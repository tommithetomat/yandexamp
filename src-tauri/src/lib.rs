mod stream;
mod vault;
mod yandex;

use serde_json::{json, Value};
use std::sync::{Arc, Mutex as StdMutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use yandex::{err, Yandex, R};
use zeroize::Zeroizing;

pub struct AppState {
    pub ym: Arc<Yandex>,
    pub cache: Arc<stream::Cache>,
}
type St<'a> = State<'a, AppState>;

const REPO: &str = "tommithetomat/yandexamp";

async fn persist(ym: &Yandex) -> R<()> {
    match ym.session().await {
        Some((token, uid)) => vault::save(&token, uid.as_deref()),
        None => Ok(()),
    }
}

/// Accepts the token only after Yandex confirms it, then stores it in the vault.
async fn accept_session(ym: &Yandex) -> R<()> {
    if ym.account_status().await?.is_none() {
        ym.clear().await;
        return Err("Яндекс не принял вход — попробуйте ещё раз".into());
    }
    persist(ym).await
}

fn token_from_url(url: &str) -> Option<String> {
    let (_, fragment) = url.split_once('#')?;
    url::form_urlencoded::parse(fragment.as_bytes())
        .find(|(k, _)| k == "access_token")
        .map(|(_, v)| v.into_owned())
        .filter(|t| !t.is_empty())
}

// ---------- session ----------

#[tauri::command]
async fn restore_session(st: St<'_>) -> R<bool> {
    let Some(saved) = vault::load() else { return Ok(false) };
    st.ym.set_token(saved.token, saved.uid).await;
    match st.ym.account_status().await {
        Ok(Some(_)) => Ok(true),
        Ok(None) => {
            // Rejected by Yandex (revoked / expired) — forget it for good
            st.ym.clear().await;
            vault::clear();
            Ok(false)
        }
        Err(_) => Ok(true), // offline: keep the session, requests will retry
    }
}

#[tauri::command]
async fn login_password(st: St<'_>, username: String, password: String) -> R<()> {
    let password = Zeroizing::new(password);
    st.ym.login_password(username.trim(), &password).await?;
    accept_session(&st.ym).await
}

#[tauri::command]
async fn login_token(st: St<'_>, token: String) -> R<()> {
    let token = Zeroizing::new(token.trim().to_string());
    if token.is_empty() || token.len() > 400 || token.chars().any(char::is_whitespace) {
        return Err("Это не похоже на токен".into());
    }
    st.ym.set_token(token, None).await;
    accept_session(&st.ym).await
}

/// Opens Yandex's own login page in a separate window. That window has no
/// access to the app's commands (see capabilities/), and we inject nothing into
/// it — we only watch its address for the token in the redirect.
#[tauri::command]
async fn login_browser(app: AppHandle, st: St<'_>) -> R<()> {
    let (tx, rx) = tokio::sync::oneshot::channel::<R<String>>();
    let tx = Arc::new(StdMutex::new(Some(tx)));
    let send = move |r: R<String>| {
        if let Some(t) = tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = t.send(r);
        }
    };

    if let Some(old) = app.get_webview_window("auth") {
        let _ = old.close();
    }
    let url = format!(
        "https://oauth.yandex.ru/authorize?response_type=token&client_id={}&force_confirm=0",
        yandex::OAUTH2_ID
    );
    let on_nav = send.clone();
    let win = WebviewWindowBuilder::new(&app, "auth", WebviewUrl::External(url.parse().map_err(err)?))
        .title("Вход в Яндекс")
        .inner_size(520.0, 720.0)
        .center()
        .on_navigation(move |u| match token_from_url(u.as_str()) {
            Some(t) => {
                on_nav(Ok(t));
                false // don't follow the redirect, we have what we need
            }
            None => true,
        })
        .build()
        .map_err(err)?;

    let on_close = send.clone();
    win.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            on_close(Err("Окно авторизации закрыто".into()));
        }
    });
    // Some redirects only surface in the address after load — poll it as well
    let (poll_win, on_poll) = (win.clone(), send.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            match poll_win.url() {
                Ok(u) => {
                    if let Some(t) = token_from_url(u.as_str()) {
                        on_poll(Ok(t));
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let result = rx.await.map_err(|_| "Вход отменён".to_string())?;
    let _ = win.close();
    let token = Zeroizing::new(result?);
    // Prefer a fresh music token bound to this device; fall back to the one we got
    if st.ym.exchange_for_music(&token).await.is_err() {
        st.ym.set_token(token, None).await;
    }
    accept_session(&st.ym).await
}

#[tauri::command]
async fn logout(st: St<'_>) -> R<()> {
    st.ym.revoke().await;
    st.ym.clear().await;
    st.cache.clear();
    vault::clear();
    Ok(())
}

// ---------- library ----------

#[tauri::command]
async fn search(st: St<'_>, query: String) -> R<Value> {
    st.ym.search(&query).await
}

#[tauri::command]
async fn track_stream_url(st: St<'_>, track_id: String) -> R<String> {
    // Resolve now so errors (no subscription, expired session) reach the UI
    st.ym.resolve_stream(&track_id).await?;
    st.cache.get(&st.ym, &track_id); // start downloading before the player asks
    Ok(stream::url_for(&track_id))
}

/// Downloads the next track in the background, so it starts instantly and
/// survives a network drop at the track change.
#[tauri::command]
async fn prefetch_track(st: St<'_>, track_id: String) -> R<()> {
    yandex::safe_id(&track_id)?;
    st.cache.get(&st.ym, &track_id);
    Ok(())
}

#[tauri::command]
async fn refresh_tracks(st: St<'_>, ids: Vec<String>) -> R<Value> {
    st.ym.refresh_tracks(&ids).await
}

#[tauri::command]
async fn get_playlists(st: St<'_>) -> R<Value> {
    st.ym.user_playlists().await
}

#[tauri::command]
async fn get_smart_playlists(st: St<'_>) -> R<Value> {
    st.ym.smart_playlists().await
}

#[tauri::command]
async fn get_liked_tracks(st: St<'_>) -> R<Value> {
    st.ym.liked_tracks().await
}

#[tauri::command]
async fn get_liked_ids(st: St<'_>) -> R<Value> {
    st.ym.liked_ids().await
}

#[tauri::command]
async fn like_track(st: St<'_>, track_id: String) -> R<()> {
    st.ym.rate(&track_id, "likes/tracks/add-multiple").await
}

#[tauri::command]
async fn unlike_track(st: St<'_>, track_id: String) -> R<()> {
    st.ym.rate(&track_id, "likes/tracks/remove").await
}

#[tauri::command]
async fn dislike_track(st: St<'_>, track_id: String) -> R<()> {
    st.ym.rate(&track_id, "dislikes/tracks/add-multiple").await
}

#[tauri::command]
async fn set_wave_settings(st: St<'_>, mood_energy: String, diversity: String, language: String) -> R<()> {
    let ok = |v: &str, allowed: &[&str]| allowed.contains(&v);
    if !ok(&mood_energy, &["all", "active", "fun", "calm", "sad"])
        || !ok(&diversity, &["default", "favorite", "discover", "popular"])
        || !ok(&language, &["any", "russian", "not-russian"])
    {
        return Err("Некорректные настройки волны".into());
    }
    st.ym.set_wave_settings(&mood_energy, &diversity, &language).await;
    Ok(())
}

#[tauri::command]
async fn get_wave_tracks(st: St<'_>, more: bool) -> R<Value> {
    st.ym.wave_tracks(more).await
}

#[tauri::command]
async fn wave_feedback(st: St<'_>, kind: String, track_id: Option<String>, played_seconds: Option<f64>) -> R<()> {
    st.ym.wave_feedback(&kind, track_id, played_seconds).await
}

#[tauri::command]
async fn get_playlist_tracks(st: St<'_>, uid: String, kind: i64) -> R<Value> {
    st.ym.playlist_tracks(&uid, kind).await
}

#[tauri::command]
async fn get_lyrics(st: St<'_>, track_id: String) -> R<Value> {
    st.ym.lyrics(&track_id).await
}

#[tauri::command]
async fn get_stations_list(st: St<'_>) -> R<Value> {
    st.ym.stations_list().await
}

#[tauri::command]
async fn get_station_tracks(st: St<'_>, station_id: String) -> R<Value> {
    st.ym.station_tracks(&station_id).await
}

#[tauri::command]
async fn get_track_radio(st: St<'_>, track_id: String) -> R<Value> {
    yandex::safe_id(&track_id)?;
    st.ym.station_tracks(&format!("track:{track_id}")).await
}

#[tauri::command]
async fn get_chart(st: St<'_>) -> R<Value> {
    st.ym.chart().await
}

#[tauri::command]
async fn get_new_releases(st: St<'_>) -> R<Value> {
    st.ym.new_releases().await
}

#[tauri::command]
async fn get_play_history(st: St<'_>) -> R<Value> {
    st.ym.play_history().await
}

#[tauri::command]
async fn get_artist(st: St<'_>, artist_id: String) -> R<Value> {
    st.ym.artist(&artist_id).await
}

#[tauri::command]
async fn get_album_tracks(st: St<'_>, album_id: String) -> R<Value> {
    st.ym.album_tracks(&album_id).await
}

// ---------- app ----------

fn newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    let (a, b) = (parse(latest), parse(current));
    for i in 0..3 {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

/// Asks GitHub for the latest release. Always reports the running version,
/// so the UI can show it even when GitHub is unreachable.
#[tauri::command]
async fn check_update(app: AppHandle, st: St<'_>) -> R<Value> {
    let current = app.package_info().version.to_string();
    let none = json!({ "newer": false, "current": current });
    let res = st
        .ym
        .http()
        .get(format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await;
    let Ok(res) = res else { return Ok(none) };
    let Ok(v) = res.json::<Value>().await else { return Ok(none) };
    let latest = v["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
    if latest.is_empty() {
        return Ok(none);
    }
    Ok(json!({
        "newer": newer(&latest, &current),
        "current": current,
        "latest": latest,
        "url": v["html_url"].as_str().unwrap_or(&format!("https://github.com/{REPO}/releases")),
    }))
}

#[tauri::command]
fn open_releases(app: AppHandle, url: String) -> R<()> {
    let prefix = format!("https://github.com/{REPO}/");
    let target = if url.starts_with(&prefix) { url } else { format!("{prefix}releases") };
    app.opener().open_url(target, None::<&str>).map_err(err)
}

// ---------- window ----------

fn resize(win: &WebviewWindow, width: Option<f64>, height: Option<f64>) -> R<()> {
    let scale = win.scale_factor().map_err(err)?;
    let cur = win.inner_size().map_err(err)?.to_logical::<f64>(scale);
    let (w, h) = (width.unwrap_or(cur.width).round(), height.unwrap_or(cur.height).round());
    if (w - cur.width).abs() < 1.0 && (h - cur.height).abs() < 1.0 {
        return Ok(());
    }
    // Some platforms ignore programmatic resizes of fixed-size windows
    let _ = win.set_resizable(true);
    let r = win.set_size(LogicalSize::new(w, h)).map_err(err);
    let _ = win.set_resizable(false);
    r
}

#[tauri::command]
fn win_set_height(window: WebviewWindow, height: f64) -> R<()> {
    resize(&window, None, Some(height.clamp(80.0, 2000.0)))
}

#[tauri::command]
fn win_set_width(window: WebviewWindow, width: f64) -> R<()> {
    resize(&window, Some(width.clamp(200.0, 2400.0)), None)
}

/// Remembers the full player size while the window is in mini mode.
static PLAYER_SIZE: StdMutex<Option<(f64, f64)>> = StdMutex::new(None);

/// Window presets: "login" (compact card), "player" (full deck, resizable),
/// "mini" (control strip), "mini-v" (vertical card with the stage on top).
/// Sizes live here, the UI only names the mode.
#[tauri::command]
fn win_layout(window: WebviewWindow, mode: String) -> R<()> {
    let scale = window.scale_factor().map_err(err)?;
    let cur = window.inner_size().map_err(err)?.to_logical::<f64>(scale);
    let (w, h, resizable, min) = match mode.as_str() {
        "login" => (460.0, 660.0, false, None),
        "mini" | "mini-v" => {
            // Only the full deck is ever this wide — don't remember a mini size
            if cur.width >= 1000.0 {
                *PLAYER_SIZE.lock().map_err(err)? = Some((cur.width, cur.height));
            }
            if mode == "mini" { (660.0, 112.0, false, None) } else { (340.0, 620.0, false, None) }
        }
        "player" => {
            let (w, h) = PLAYER_SIZE.lock().map_err(err)?.unwrap_or((1280.0, 820.0));
            (w, h, true, Some((1120.0, 780.0)))
        }
        _ => return Err("Неизвестный режим окна".into()),
    };
    let _ = window.set_resizable(true);
    window.set_min_size(min.map(|(mw, mh)| LogicalSize::new(mw, mh))).map_err(err)?;
    window.set_size(LogicalSize::new(w, h)).map_err(err)?;
    window.set_resizable(resizable).map_err(err)?;
    if !mode.starts_with("mini") {
        let _ = window.center();
    }
    Ok(())
}

#[tauri::command]
fn win_set_pin(window: WebviewWindow, on: bool) -> R<()> {
    window.set_always_on_top(on).map_err(err)
}

#[tauri::command]
fn win_hide(window: WebviewWindow) -> R<()> {
    window.hide().map_err(err)
}

#[tauri::command]
fn win_close(app: AppHandle) {
    app.exit(0);
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Показать / скрыть", true, None::<&str>)?;
    let play = MenuItem::with_id(app, "playpause", "Играть / пауза", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "Следующий трек", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "Предыдущий трек", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let (s1, s2) = (PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?);
    let menu = Menu::with_items(app, &[&toggle, &s1, &play, &next, &prev, &s2, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("YandexAmp")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "toggle" => toggle_main(app),
            "quit" => app.exit(0),
            cmd => {
                let _ = app.emit("media-cmd", cmd.to_string());
            }
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { ym: Arc::new(Yandex::new()), cache: Default::default() })
        .register_asynchronous_uri_scheme_protocol("yamp", |ctx, req, responder| {
            stream::handle(ctx.app_handle(), req, responder)
        })
        .invoke_handler(tauri::generate_handler![
            restore_session,
            login_password,
            login_token,
            login_browser,
            logout,
            search,
            track_stream_url,
            prefetch_track,
            refresh_tracks,
            get_playlists,
            get_smart_playlists,
            get_liked_tracks,
            get_liked_ids,
            like_track,
            unlike_track,
            dislike_track,
            set_wave_settings,
            get_wave_tracks,
            wave_feedback,
            get_playlist_tracks,
            get_lyrics,
            get_stations_list,
            get_station_tracks,
            get_track_radio,
            get_chart,
            get_new_releases,
            get_play_history,
            get_artist,
            get_album_tracks,
            check_update,
            open_releases,
            win_set_height,
            win_set_width,
            win_layout,
            win_set_pin,
            win_hide,
            win_close,
        ])
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running YandexAmp");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_taken_from_redirect_fragment() {
        let u = "https://music.yandex.ru/#access_token=y0_AbC-123&token_type=bearer&expires_in=31536000";
        assert_eq!(token_from_url(u).as_deref(), Some("y0_AbC-123"));
        assert_eq!(token_from_url("https://oauth.yandex.ru/authorize?access_token=nope"), None);
        assert_eq!(token_from_url("https://music.yandex.ru/#access_token="), None);
    }

    #[test]
    fn versions_compare_numerically() {
        assert!(newer("1.10.0", "1.9.3"));
        assert!(!newer("1.3.0", "2.0.0"));
        assert!(!newer("2.0.0", "2.0.0"));
    }
}
