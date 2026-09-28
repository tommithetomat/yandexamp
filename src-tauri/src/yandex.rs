//! Yandex Music API client.
//!
//! The OAuth token lives only here, in Rust memory (zeroized on drop). The
//! WebView never receives it: every request is made from this side, so even a
//! script injected through API content (a crafted track title, lyrics…) has
//! nothing to steal.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};
use zeroize::Zeroizing;

const API: &str = "https://api.music.yandex.net";
const OAUTH: &str = "https://oauth.yandex.ru";
const MAGIC: &str = "XGRlBW9FXlekgbPrRHuSiA";
const LYRICS_KEY: &[u8] = b"p93jhgh689SBReK6ghtw62";
// Public client ids of the official Yandex Music mobile app (embedded in its APK)
const OAUTH1_ID: &str = "0618394846eb4d9589a602f80ce013d6";
const OAUTH1_SECRET: &str = "c13b3de8d9f5492caf321467c3520358";
pub const OAUTH2_ID: &str = "23cabbbdc6cd418abb4b39c32c41195d";
const OAUTH2_SECRET: &str = "53bc75238f0c4d08a118e51fe9203300";
const DEVICE_ID: &str = "377c5ae26b09fccd72deae0a95425559";
const DEVICE_UUID: &str = "3cfccdaf75dcf98b917a54afe50447ba";
const CLIENT_WP: &str = "WindowsPhone/3.17";
const CLIENT_ANDROID: &str = "YandexMusicAndroid/24023621";
const STREAM_TTL: Duration = Duration::from_secs(600);
const EXPIRED: &str = "Сессия истекла — войдите заново";

pub type R<T> = Result<T, String>;

pub fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn net(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Сервер не ответил вовремя".into()
    } else {
        // without_url: never echo request URLs (signed stream links) into the UI
        format!("Сетевая ошибка: {}", e.without_url())
    }
}

/// Network hiccups worth another try: VPN reconnects, dropped or stalled sockets.
fn transient(e: &reqwest::Error) -> bool {
    e.is_timeout() || e.is_connect() || e.is_request() || e.is_body() || e.is_decode()
}

const TRIES: u32 = 3;

/// Sends a request up to TRIES times with growing timeouts and pauses, and
/// reads the whole body inside the same attempt, so a VPN that drops the
/// socket mid-response is retried as well. `make` rebuilds the request.
pub async fn send_text(make: impl Fn() -> reqwest::RequestBuilder) -> R<(u16, String)> {
    let mut last = None;
    for attempt in 0..TRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * 3u64.pow(attempt - 1))).await;
        }
        let res = make().timeout(Duration::from_secs(12 + 9 * attempt as u64)).send().await;
        match res {
            Ok(res) => {
                let status = res.status().as_u16();
                if status >= 500 && attempt + 1 < TRIES {
                    continue;
                }
                match res.text().await {
                    Ok(body) => return Ok((status, body)),
                    Err(e) if transient(&e) => last = Some(e),
                    Err(e) => return Err(net(e)),
                }
            }
            Err(e) if transient(&e) => last = Some(e),
            Err(e) => return Err(net(e)),
        }
    }
    Err(last.map(net).unwrap_or_else(|| "Сервер Яндекса временно недоступен".into()))
}

fn need<T>(o: Option<T>, msg: &str) -> R<T> {
    o.ok_or_else(|| msg.to_string())
}

/// Ids coming from the UI end up in API paths — allow only id-shaped strings
/// so the frontend can't steer the authenticated client to other endpoints.
pub fn safe_id(s: &str) -> R<&str> {
    let ok = !s.is_empty()
        && s.len() <= 80
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'));
    if ok { Ok(s) } else { Err("Некорректный идентификатор".into()) }
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn str_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

const EMPTY: &[Value] = &[];
fn arr(v: &Value) -> std::slice::Iter<'_, Value> {
    match v.as_array() {
        Some(a) => a.iter(),
        None => EMPTY.iter(),
    }
}

fn is_track(t: &Value) -> bool {
    t.is_object() && t.get("error").is_none()
}

pub fn is_yandex_host(u: &str) -> bool {
    url::Url::parse(u)
        .ok()
        .filter(|p| p.scheme() == "https")
        .and_then(|p| p.host_str().map(|h| h.to_ascii_lowercase()))
        .map(|h| {
            ["yandex.net", "yandex.ru"]
                .iter()
                .any(|d| h == *d || h.ends_with(&format!(".{d}")))
        })
        .unwrap_or(false)
}

pub fn map_track(t: &Value) -> Value {
    let artists: Vec<&Value> = arr(&t["artists"]).collect();
    let names: Vec<&str> = artists.iter().filter_map(|a| a["name"].as_str()).collect();
    let list: Vec<Value> = artists
        .iter()
        .filter_map(|a| Some(json!({ "id": str_of(&a["id"])?, "name": a["name"].as_str()? })))
        .collect();
    // Short looping clip some tracks carry (the "vertical video" of the mobile app)
    let video = t["backgroundVideoUri"].as_str().filter(|u| is_yandex_host(u));
    let color = t["derivedColors"]["accent"]
        .as_str()
        .filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|h| h.is_ascii_hexdigit()));
    json!({
        "id": str_of(&t["id"]).unwrap_or_default(),
        "title": t["title"].as_str().unwrap_or("Unknown"),
        "artist": if names.is_empty() { "Unknown".to_string() } else { names.join(", ") },
        "artistId": artists.first().and_then(|a| str_of(&a["id"])),
        "album": t.pointer("/albums/0/title").and_then(Value::as_str).unwrap_or(""),
        "duration": t["durationMs"].as_u64().unwrap_or(0),
        "coverUri": t["coverUri"].as_str(),
        "artists": list,
        "video": video,
        "color": color,
    })
}

/// Pull the text of `<tag>…</tag>` out of the tiny download-info XML.
pub fn xml_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open) {
        let at = from + i + open.len();
        match xml[at..].chars().next() {
            Some('>') | Some(' ') => {
                let Some(gt) = xml[at..].find('>') else { return String::new() };
                let start = at + gt + 1;
                return match xml[start..].find(&close) {
                    Some(j) => xml[start..start + j].trim().to_string(),
                    None => String::new(),
                };
            }
            _ => from = at,
        }
    }
    String::new()
}

fn parse(status: u16, body: &str) -> R<Value> {
    if status == 401 {
        return Err(EXPIRED.into());
    }
    serde_json::from_str(body).map_err(|_| format!("Сервер вернул некорректный ответ (HTTP {status})"))
}

#[derive(Default)]
struct Session {
    token: Option<Zeroizing<String>>,
    uid: Option<String>,
}

#[derive(Default)]
struct Wave {
    queue: String,
    batch_id: Option<String>,
}

pub struct Yandex {
    http: reqwest::Client,
    stream_http: reqwest::Client,
    session: RwLock<Session>,
    wave: Mutex<Wave>,
    streams: Mutex<HashMap<String, (String, Instant)>>,
}

impl Yandex {
    pub fn new() -> Self {
        // Short idle pool + keepalive: after a VPN reconnect the old sockets are
        // dead, and reusing one would hang the request until it times out.
        let http = reqwest::Client::builder()
            .user_agent("YandexAmp/2.0")
            .connect_timeout(Duration::from_secs(8))
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(15))
            .build()
            .expect("HTTP client");
        // Audio downloads may take minutes on a slow link: no total timeout,
        // only a stall timeout between received bytes.
        let stream_http = reqwest::Client::builder()
            .user_agent("YandexAmp/2.0")
            .connect_timeout(Duration::from_secs(8))
            .read_timeout(Duration::from_secs(15))
            .pool_idle_timeout(Duration::from_secs(30))
            .tcp_keepalive(Duration::from_secs(15))
            .build()
            .expect("HTTP client");
        Self {
            http,
            stream_http,
            session: Default::default(),
            wave: Default::default(),
            streams: Default::default(),
        }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub fn stream_http(&self) -> &reqwest::Client {
        &self.stream_http
    }

    // ---------- session ----------

    pub async fn set_token(&self, token: Zeroizing<String>, uid: Option<String>) {
        let mut s = self.session.write().await;
        s.token = Some(token);
        s.uid = uid;
    }

    pub async fn session(&self) -> Option<(Zeroizing<String>, Option<String>)> {
        let s = self.session.read().await;
        s.token.clone().map(|t| (t, s.uid.clone()))
    }

    pub async fn clear(&self) {
        *self.session.write().await = Session::default();
        *self.wave.lock().await = Wave::default();
        self.streams.lock().await.clear();
    }

    async fn auth_header(&self) -> R<HeaderValue> {
        let s = self.session.read().await;
        let t = need(s.token.as_ref(), "Не выполнен вход")?;
        let value = Zeroizing::new(format!("OAuth {}", t.as_str()));
        let mut hv = HeaderValue::from_str(&value).map_err(|_| "Некорректный токен".to_string())?;
        hv.set_sensitive(true); // never shown in debug output
        Ok(hv)
    }

    async fn get_raw(&self, path: &str, client: &str) -> R<(u16, String)> {
        let (auth, url) = (self.auth_header().await?, format!("{API}{path}"));
        send_text(|| self.http.get(&url).header(AUTHORIZATION, auth.clone()).header("X-Yandex-Music-Client", client)).await
    }

    async fn get(&self, path: &str) -> R<Value> {
        let (status, body) = self.get_raw(path, CLIENT_WP).await?;
        parse(status, &body)
    }

    async fn post_form(&self, path: &str, form: &[(&str, &str)]) -> R<Value> {
        let (auth, url) = (self.auth_header().await?, format!("{API}{path}"));
        let (status, body) = send_text(|| {
            self.http.post(&url).header(AUTHORIZATION, auth.clone()).header("X-Yandex-Music-Client", CLIENT_WP).form(form)
        })
        .await?;
        parse(status, &body)
    }

    async fn post_json(&self, path: &str, body: &Value) -> R<()> {
        let (auth, url) = (self.auth_header().await?, format!("{API}{path}"));
        let (status, _) = send_text(|| {
            self.http.post(&url).header(AUTHORIZATION, auth.clone()).header("X-Yandex-Music-Client", CLIENT_WP).json(body)
        })
        .await?;
        if (200..300).contains(&status) { Ok(()) } else { Err(format!("HTTP {status}")) }
    }

    async fn uid(&self) -> R<String> {
        if let Some(u) = self.session.read().await.uid.clone() {
            return Ok(u);
        }
        self.account_status().await?;
        need(self.session.read().await.uid.clone(), "Не удалось получить UID — войдите заново")
    }

    /// Ok(Some) — token accepted; Ok(None) — rejected by Yandex; Err — network trouble.
    pub async fn account_status(&self) -> R<Option<Value>> {
        let (status, body) = self.get_raw("/account/status", CLIENT_WP).await?;
        if status == 401 || status == 403 {
            return Ok(None);
        }
        let v: Value = serde_json::from_str(&body).map_err(|_| "Некорректный ответ сервера".to_string())?;
        let Some(acc) = v.pointer("/result/account").cloned() else { return Ok(None) };
        let Some(uid) = str_of(&acc["uid"]) else { return Ok(None) };
        self.session.write().await.uid = Some(uid);
        Ok(Some(acc))
    }

    // ---------- auth ----------

    async fn oauth_post(&self, path: &str, form: &[(&str, &str)]) -> R<Value> {
        let url = format!("{OAUTH}{path}");
        let (_, body) = send_text(|| self.http.post(&url).form(form)).await?;
        let v: Value =
            serde_json::from_str(&body).map_err(|_| "Некорректный ответ сервера авторизации".to_string())?;
        if v.get("error").is_some() {
            let msg = v["error_description"].as_str().or(v["error"].as_str()).unwrap_or("Ошибка авторизации");
            return Err(msg.to_string());
        }
        Ok(v)
    }

    pub async fn login_password(&self, username: &str, password: &str) -> R<()> {
        let v = self
            .oauth_post(
                "/1/token",
                &[
                    ("grant_type", "password"),
                    ("username", username),
                    ("password", password),
                    ("client_id", OAUTH1_ID),
                    ("client_secret", OAUTH1_SECRET),
                ],
            )
            .await?;
        // This intermediate token can mint tokens for other Yandex services:
        // use it once for the exchange, never keep or persist it.
        let x = Zeroizing::new(need(v["access_token"].as_str(), "Сервер не выдал токен")?.to_string());
        drop(v);
        self.exchange_for_music(&x).await
    }

    pub async fn exchange_for_music(&self, basic: &str) -> R<()> {
        let path = format!("/1/token?device_id={DEVICE_ID}&uuid={DEVICE_UUID}&package_name=ru.yandex.music");
        let v = self
            .oauth_post(
                &path,
                &[
                    ("grant_type", "x-token"),
                    ("access_token", basic),
                    ("client_id", OAUTH2_ID),
                    ("client_secret", OAUTH2_SECRET),
                ],
            )
            .await?;
        let token = Zeroizing::new(need(v["access_token"].as_str(), "Сервер не выдал токен")?.to_string());
        self.set_token(token, str_of(&v["uid"])).await;
        Ok(())
    }

    /// Best effort: ask Yandex to invalidate the token, so a copy stolen
    /// earlier stops working once the user signs out.
    pub async fn revoke(&self) {
        let Some((token, _)) = self.session().await else { return };
        let _ = self
            .http
            .post(format!("{OAUTH}/revoke_token"))
            .form(&[
                ("access_token", token.as_str()),
                ("client_id", OAUTH2_ID),
                ("client_secret", OAUTH2_SECRET),
            ])
            .send()
            .await;
    }

    // ---------- library ----------

    pub async fn user_playlists(&self) -> R<Value> {
        let uid = self.uid().await?;
        let v = self.get(&format!("/users/{uid}/playlists/list")).await?;
        let list: Vec<Value> = arr(&v["result"])
            .map(|p| {
                json!({
                    "kind": p["kind"],
                    "uid": str_of(&p["uid"]).unwrap_or_else(|| uid.clone()),
                    "title": p["title"].as_str().unwrap_or("Без названия"),
                    "trackCount": p["trackCount"].as_u64().unwrap_or(0),
                })
            })
            .collect();
        Ok(Value::Array(list))
    }

    pub async fn playlist_tracks(&self, uid: &str, kind: i64) -> R<Value> {
        safe_id(uid)?;
        let v = self.get(&format!("/users/{uid}/playlists/{kind}?rich-tracks=true")).await?;
        let pl = &v["result"];
        if !pl.is_object() {
            return Err("Плейлист не найден".into());
        }
        let tracks: Vec<Value> =
            arr(&pl["tracks"]).filter(|t| is_track(&t["track"])).map(|t| map_track(&t["track"])).collect();
        Ok(json!({ "title": pl["title"].as_str().unwrap_or("Плейлист"), "tracks": tracks }))
    }

    pub async fn smart_playlists(&self) -> R<Value> {
        let v = self.get("/landing3?blocks=personalplaylists").await?;
        let mut out = vec![];
        for block in arr(&v["result"]["blocks"]) {
            for e in arr(&block["entities"]) {
                let p = if e["data"]["data"].is_object() { &e["data"]["data"] } else { &e["data"] };
                if p["kind"].is_null() {
                    continue;
                }
                if let Some(uid) = str_of(&p["uid"]).or_else(|| str_of(&p["owner"]["uid"])) {
                    out.push(json!({
                        "kind": p["kind"],
                        "uid": uid,
                        "title": p["title"].as_str().unwrap_or("Плейлист"),
                        "trackCount": p["trackCount"].as_u64().unwrap_or(0),
                    }));
                }
            }
        }
        Ok(Value::Array(out))
    }

    async fn tracks_by_ids(&self, ids: &[String]) -> R<Vec<Value>> {
        let mut tracks = vec![];
        // The /tracks endpoint chokes on huge lists — go in chunks
        for chunk in ids.chunks(250) {
            let joined = chunk.join(",");
            let full = self.post_form("/tracks", &[("track-ids", joined.as_str())]).await?;
            tracks.extend(arr(&full["result"]).filter(|t| is_track(t)).map(map_track));
        }
        Ok(tracks)
    }

    /// Fresh metadata for tracks saved by an older version (artists list, clip, colour).
    pub async fn refresh_tracks(&self, ids: &[String]) -> R<Value> {
        let ids: Vec<String> = ids.iter().filter(|i| safe_id(i).is_ok()).take(3000).cloned().collect();
        Ok(Value::Array(self.tracks_by_ids(&ids).await?))
    }

    pub async fn liked_tracks(&self) -> R<Value> {
        let uid = self.uid().await?;
        let v = self.get(&format!("/users/{uid}/likes/tracks")).await?;
        let ids: Vec<String> = arr(&v["result"]["library"]["tracks"])
            .filter_map(|r| {
                let id = str_of(&r["id"])?;
                Some(match str_of(&r["albumId"]) {
                    Some(a) => format!("{id}:{a}"),
                    None => id,
                })
            })
            .collect();
        let tracks = self.tracks_by_ids(&ids).await?;
        Ok(json!({ "title": "Мне нравится", "tracks": tracks }))
    }

    pub async fn liked_ids(&self) -> R<Value> {
        let uid = self.uid().await?;
        let v = self.get(&format!("/users/{uid}/likes/tracks")).await?;
        let ids: Vec<String> = arr(&v["result"]["library"]["tracks"]).filter_map(|r| str_of(&r["id"])).collect();
        Ok(json!(ids))
    }

    /// action: "likes/tracks/add-multiple" | "likes/tracks/remove" | "dislikes/tracks/add-multiple"
    pub async fn rate(&self, track_id: &str, action: &str) -> R<()> {
        safe_id(track_id)?;
        let uid = self.uid().await?;
        self.post_form(&format!("/users/{uid}/{action}"), &[("track-ids", track_id)]).await.map(|_| ())
    }

    async fn lyrics_in(&self, track_id: &str, format: &str) -> R<Option<String>> {
        let ts = chrono::Utc::now().timestamp().to_string();
        let mut mac = Hmac::<Sha256>::new_from_slice(LYRICS_KEY).map_err(err)?;
        mac.update(format!("{track_id}{ts}").as_bytes());
        let sign = B64.encode(mac.finalize().into_bytes());
        // The server checks the signature against the Android client header
        let path = format!("/tracks/{track_id}/lyrics?format={format}&timeStamp={ts}&sign={}", enc(&sign));
        let (status, body) = self.get_raw(&path, CLIENT_ANDROID).await?;
        if status != 200 {
            return Ok(None);
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let Some(url) = v["result"]["downloadUrl"].as_str().filter(|u| u.starts_with("https://")) else {
            return Ok(None);
        };
        let (_, text) = send_text(|| self.http.get(url)).await?;
        let text = text.trim().to_string();
        Ok((!text.is_empty()).then_some(text))
    }

    /// Time-synced (LRC) lyrics when Yandex has them, plain text otherwise.
    pub async fn lyrics(&self, track_id: &str) -> R<Value> {
        safe_id(track_id)?;
        if let Some(lrc) = self.lyrics_in(track_id, "LRC").await? {
            if lrc.contains("[0") {
                return Ok(json!({ "text": lrc, "synced": true }));
            }
        }
        let text = self.lyrics_in(track_id, "TEXT").await?.unwrap_or_default();
        Ok(json!({ "text": text, "synced": false }))
    }

    // ---------- My Wave / rotor ----------

    pub async fn set_wave_settings(&self, mood: &str, diversity: &str, language: &str) {
        let body = json!({ "moodEnergy": mood, "diversity": diversity, "language": language, "type": "rotor" });
        // Nice-to-have: never let a failure here block the wave itself
        if self.post_json("/rotor/station/user:onyourwave/settings3", &body).await.is_err() {
            let _ = self.post_json("/rotor/station/user:onyourwave/settings2", &body).await;
        }
    }

    pub async fn wave_tracks(&self, more: bool) -> R<Value> {
        let mut queue = if more { self.wave.lock().await.queue.clone() } else { String::new() };
        let mut tracks = vec![];
        for i in 0..4 {
            let q = if queue.is_empty() { String::new() } else { format!("&queue={}", enc(&queue)) };
            let (status, body) =
                self.get_raw(&format!("/rotor/station/user:onyourwave/tracks?settings2=true{q}"), CLIENT_WP).await?;
            if i == 0 && (status == 401 || status == 403) {
                return Err("Волна недоступна — проверьте вход и подписку Яндекс Плюс".into());
            }
            let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if let Some(b) = str_of(&v["result"]["batchId"]) {
                self.wave.lock().await.batch_id = Some(b);
            }
            let seq: Vec<&Value> = arr(&v["result"]["sequence"]).collect();
            if seq.is_empty() {
                break;
            }
            tracks.extend(seq.iter().filter(|s| s["track"].is_object()).map(|s| map_track(&s["track"])));
            queue = seq.last().and_then(|s| str_of(&s["track"]["id"])).unwrap_or_default();
            if queue.is_empty() {
                break;
            }
            if i == 0 && !more {
                // Fresh start — tell the rotor the station is playing
                let _ = self.wave_feedback("radioStarted", None, None).await;
            }
        }
        self.wave.lock().await.queue = queue;
        let mut seen = HashSet::new();
        let unique: Vec<Value> = tracks
            .into_iter()
            .filter(|t| seen.insert(t["id"].as_str().unwrap_or_default().to_string()))
            .collect();
        Ok(json!({ "title": "Моя волна", "tracks": unique }))
    }

    pub async fn wave_feedback(&self, kind: &str, track_id: Option<String>, played: Option<f64>) -> R<()> {
        if !matches!(kind, "radioStarted" | "trackStarted" | "trackFinished" | "skip") {
            return Err("Неизвестное событие волны".into());
        }
        let mut body = json!({
            "type": kind,
            "timestamp": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "from": "desktop_win-radio-user-onyourwave",
        });
        if let Some(t) = track_id {
            body["trackId"] = json!(safe_id(&t)?);
        }
        if let Some(p) = played {
            body["totalPlayedSeconds"] = json!(p.max(0.0).round() as i64);
        }
        let path = match self.wave.lock().await.batch_id.clone() {
            Some(b) => format!("/rotor/station/user:onyourwave/feedback?batch-id={}", enc(&b)),
            None => "/rotor/station/user:onyourwave/feedback".to_string(),
        };
        self.post_json(&path, &body).await
    }

    pub async fn stations_list(&self) -> R<Value> {
        let v = self.get("/rotor/stations/list").await?;
        let out: Vec<Value> = arr(&v["result"])
            .filter_map(|s| {
                let kind = s["station"]["id"]["type"].as_str()?;
                let tag = str_of(&s["station"]["id"]["tag"])?;
                Some(json!({ "id": format!("{kind}:{tag}"), "type": kind, "title": s["station"]["name"].as_str().unwrap_or("Станция") }))
            })
            .collect();
        Ok(Value::Array(out))
    }

    pub async fn station_tracks(&self, station: &str) -> R<Value> {
        safe_id(station)?;
        let v = self.get(&format!("/rotor/station/{station}/tracks?settings2=true")).await?;
        let tracks: Vec<Value> =
            arr(&v["result"]["sequence"]).filter(|s| s["track"].is_object()).map(|s| map_track(&s["track"])).collect();
        Ok(json!({ "title": v["result"]["station"]["name"].as_str().unwrap_or("Радио"), "tracks": tracks }))
    }

    // ---------- discovery ----------

    pub async fn chart(&self) -> R<Value> {
        let v = self.get("/landing3/chart").await?;
        let list = if v["result"]["chart"]["tracks"].is_array() {
            &v["result"]["chart"]["tracks"]
        } else {
            &v["result"]["chart"]["chart"]["tracks"]
        };
        let tracks: Vec<Value> = arr(list).filter(|t| is_track(&t["track"])).map(|t| map_track(&t["track"])).collect();
        Ok(json!({ "title": "Чарт", "tracks": tracks }))
    }

    pub async fn new_releases(&self) -> R<Value> {
        let v = self.get("/landing3?blocks=new-releases").await?;
        let ids: Vec<String> = arr(&v["result"]["blocks"])
            .flat_map(|b| arr(&b["entities"]))
            // entity.id is a block-local key; the album id sits in entity.data.id
            .filter_map(|e| str_of(&e["data"]["id"]))
            .filter(|id| safe_id(id).is_ok())
            .take(30)
            .collect();
        // Albums are fetched in parallel — sequentially this took ~30 round trips
        let albums = futures::future::join_all(
            ids.iter().map(|id| async move { self.get(&format!("/albums/{id}/with-tracks")).await }),
        )
        .await;
        let tracks: Vec<Value> = albums
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|a| {
                let first = &a["result"]["volumes"][0][0];
                is_track(first).then(|| map_track(first))
            })
            .collect();
        Ok(json!({ "title": "Новинки", "tracks": tracks }))
    }

    /// "Recently played": Yandex keeps it as contexts (playlists, albums,
    /// artists), not single tracks — the same list as in its own apps.
    pub async fn play_history(&self) -> R<Value> {
        let v = self.get("/landing3?blocks=play_contexts").await?;
        let mut out = vec![];
        for block in arr(&v["result"]["blocks"]) {
            for e in arr(&block["entities"]) {
                let (d, p) = (&e["data"], &e["data"]["payload"]);
                let Some(id) = str_of(&d["contextItem"]) else { continue };
                let cover = p["cover"]["uri"].as_str()
                    .or(p["cover"]["itemsUri"][0].as_str())
                    .or(p["coverUri"].as_str())
                    .or(p["ogImage"].as_str());
                let (kind, title, subtitle) = match d["context"].as_str() {
                    Some("playlist") => ("playlist", p["title"].as_str(), p["owner"]["name"].as_str().map(|n| format!("Плейлист · {n}"))),
                    Some("album") => {
                        let names: Vec<&str> = arr(&p["artists"]).filter_map(|a| a["name"].as_str()).collect();
                        ("album", p["title"].as_str(), Some(format!("Альбом · {}", names.join(", "))))
                    }
                    Some("artist") => ("artist", p["name"].as_str(), Some("Исполнитель".to_string())),
                    _ => continue,
                };
                let Some(title) = title else { continue };
                if safe_id(&id).is_ok() {
                    out.push(json!({ "kind": kind, "id": id, "title": title, "subtitle": subtitle, "cover": cover }));
                }
            }
        }
        Ok(json!({ "title": "История", "contexts": out }))
    }

    pub async fn artist(&self, id: &str) -> R<Value> {
        safe_id(id)?;
        let v = self.get(&format!("/artists/{id}/brief-info")).await?;
        let r = &v["result"];
        let popular: Vec<Value> = arr(&r["popularTracks"]).filter(|t| is_track(t)).map(map_track).collect();
        let albums: Vec<Value> = arr(&r["albums"])
            .map(|a| {
                json!({
                    "id": str_of(&a["id"]).unwrap_or_default(),
                    "title": a["title"].as_str().unwrap_or("Альбом"),
                    "year": a["year"],
                    "coverUri": a["coverUri"].as_str(),
                })
            })
            .collect();
        Ok(json!({
            "name": r["artist"]["name"].as_str().unwrap_or("Исполнитель"),
            "cover": r["artist"]["cover"]["uri"].as_str().or(r["artist"]["ogImage"].as_str()),
            "albums": albums,
            "popular": popular,
        }))
    }

    pub async fn album_tracks(&self, id: &str) -> R<Value> {
        safe_id(id)?;
        let v = self.get(&format!("/albums/{id}/with-tracks")).await?;
        let r = &v["result"];
        let tracks: Vec<Value> = arr(&r["volumes"]).flat_map(arr).filter(|t| is_track(t)).map(map_track).collect();
        Ok(json!({ "title": r["title"].as_str().unwrap_or("Альбом"), "tracks": tracks }))
    }

    pub async fn search(&self, query: &str) -> R<Value> {
        let v = self.get(&format!("/search?type=track&text={}&page=0&nococrrect=false", enc(query))).await?;
        Ok(Value::Array(arr(&v["result"]["tracks"]["results"]).map(map_track).collect()))
    }

    // ---------- audio stream ----------

    /// Resolves the signed CDN link of a track (cached for a few minutes).
    pub async fn resolve_stream(&self, track_id: &str) -> R<String> {
        safe_id(track_id)?;
        if let Some((u, at)) = self.streams.lock().await.get(track_id).cloned() {
            if at.elapsed() < STREAM_TTL {
                return Ok(u);
            }
        }
        let v = self.get(&format!("/tracks/{track_id}/download-info")).await?;
        let mut mp3: Vec<&Value> = arr(&v["result"])
            .filter(|i| i["codec"] == "mp3" && !i["preview"].as_bool().unwrap_or(false))
            .collect();
        mp3.sort_by_key(|i| std::cmp::Reverse(i["bitrateInKbps"].as_u64().unwrap_or(0)));
        let info_url = need(
            mp3.first().and_then(|i| i["downloadInfoUrl"].as_str()),
            "Для этого трека нет полного MP3-потока (нужна подписка Яндекс Плюс)",
        )?;
        if !is_yandex_host(info_url) {
            return Err("Неожиданный адрес потока".into());
        }
        let (_, xml) = send_text(|| self.http.get(info_url)).await?;
        let (host, path, ts, s) = (xml_tag(&xml, "host"), xml_tag(&xml, "path"), xml_tag(&xml, "ts"), xml_tag(&xml, "s"));
        if host.is_empty() || path.len() < 2 || !path.is_ascii() {
            return Err("Не удалось разобрать ссылку на поток".into());
        }
        let sign = format!("{:x}", Md5::digest(format!("{MAGIC}{}{s}", &path[1..]).as_bytes()));
        let url = format!("https://{host}/get-mp3/{sign}/{ts}{path}");
        // The stream proxy fetches whatever we cache here — only Yandex hosts
        if !is_yandex_host(&url) {
            return Err("Неожиданный адрес потока".into());
        }
        self.streams.lock().await.insert(track_id.to_string(), (url.clone(), Instant::now()));
        Ok(url)
    }

    pub async fn forget_stream(&self, track_id: &str) {
        self.streams.lock().await.remove(track_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_validated() {
        assert!(safe_id("12345:678").is_ok());
        assert!(safe_id("genre:rock").is_ok());
        assert!(safe_id("activity:wake-up").is_ok());
        assert!(safe_id("../account").is_err());
        assert!(safe_id("1?x=1").is_err());
        assert!(safe_id("").is_err());
    }

    #[test]
    fn xml_tags_are_parsed() {
        let xml = "<?xml version=\"1.0\"?><download-info><host>s1.storage.yandex.net</host>\
                   <path>/rmusic/abc</path><ts>0005f</ts><region>-1</region><s>deadbeef</s></download-info>";
        assert_eq!(xml_tag(xml, "host"), "s1.storage.yandex.net");
        assert_eq!(xml_tag(xml, "path"), "/rmusic/abc");
        assert_eq!(xml_tag(xml, "ts"), "0005f");
        assert_eq!(xml_tag(xml, "s"), "deadbeef");
        assert_eq!(xml_tag(xml, "missing"), "");
    }

    #[test]
    fn only_yandex_hosts_pass() {
        assert!(is_yandex_host("https://s1.storage.yandex.net/get-mp3/x"));
        assert!(is_yandex_host("https://storage.mds.yandex.net/x"));
        assert!(!is_yandex_host("http://s1.storage.yandex.net/x"));
        assert!(!is_yandex_host("https://yandex.net.evil.com/x"));
        assert!(!is_yandex_host("https://evilyandex.net/x"));
    }

    #[test]
    fn tracks_are_mapped() {
        let t = json!({ "id": 42, "title": "Журавли", "artists": [{ "id": 7, "name": "Mujuice" }],
                        "albums": [{ "title": "Downshifting" }], "durationMs": 268000, "coverUri": "avatars.yandex.net/x/%%" });
        let m = map_track(&t);
        assert_eq!(m["id"], "42");
        assert_eq!(m["artist"], "Mujuice");
        assert_eq!(m["artistId"], "7");
        assert_eq!(m["duration"], 268000);
    }
}


