//! `yamp://` audio proxy.
//!
//! The equalizer and visualizers read the audio through Web Audio, which only
//! works for CORS-enabled media. Yandex's CDN doesn't send CORS headers, so the
//! `<audio>` element plays from this scheme instead. The WebView only ever sees
//! `yamp://…/stream/<trackId>` — never a signed URL or the token.
//!
//! Each track is downloaded once, start to finish, into memory by a background
//! task that survives network trouble: a dropped or stalled connection (VPN
//! reconnects, flaky Wi-Fi) is resumed from the last received byte, and an
//! expired signed link is re-resolved. The media element's range requests are
//! answered from that buffer, so a hiccup costs a pause at most, not an error.

use crate::yandex::{safe_id, Yandex};
use crate::AppState;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeResponder};
use tokio::sync::watch;

/// Most bytes served per request; the media element asks for the next range itself.
const CHUNK: u64 = 1024 * 1024;
/// A request is answered once this much past its start has arrived.
const MIN_SERVE: u64 = 64 * 1024;
/// Seeks further than this past the download edge go straight to the CDN.
const FAR: u64 = 3 * 1024 * 1024;
/// Tracks kept in memory: the current one, the prefetched next one, a couple of recent ones.
const KEEP: usize = 4;
/// Give up on a download after this many failed attempts in a row.
const MAX_FAILS: u32 = 10;
/// How long a range request waits for bytes before giving up.
const WAIT: Duration = Duration::from_secs(40);

/// The scheme is exposed differently per platform (WebView2 needs http://).
pub fn url_for(track_id: &str) -> String {
    if cfg!(any(windows, target_os = "android")) {
        format!("http://yamp.localhost/stream/{track_id}")
    } else {
        format!("yamp://localhost/stream/{track_id}")
    }
}

#[derive(Default)]
struct Data {
    bytes: Vec<u8>,
    total: Option<u64>,
    ctype: Option<String>,
    failed: bool,
}

impl Data {
    fn complete(&self) -> bool {
        self.total.is_some_and(|t| self.bytes.len() as u64 >= t)
    }
}

pub struct Buf {
    data: Mutex<Data>,
    tick: watch::Sender<u64>,
    stop: AtomicBool,
}

impl Buf {
    fn new() -> Arc<Self> {
        Arc::new(Self { data: Default::default(), tick: watch::channel(0).0, stop: AtomicBool::new(false) })
    }
    fn bump(&self) {
        self.tick.send_modify(|n| *n += 1);
    }
    fn halt(&self) {
        self.stop.store(true, Relaxed);
        self.bump();
    }
}

/// Recently played / prefetched tracks, oldest first.
#[derive(Default)]
pub struct Cache {
    list: Mutex<VecDeque<(String, Arc<Buf>)>>,
}

impl Cache {
    /// The buffer of a track, starting its download when there is none (or the last one failed).
    pub fn get(&self, ym: &Arc<Yandex>, id: &str) -> Arc<Buf> {
        let mut list = self.list.lock().unwrap();
        let usable = |b: &Arc<Buf>| !b.stop.load(Relaxed) && !b.data.lock().unwrap().failed;
        if let Some(pos) = list.iter().position(|(k, b)| k == id && usable(b)) {
            let entry = list.remove(pos).unwrap();
            let buf = entry.1.clone();
            list.push_back(entry);
            return buf;
        }
        list.retain(|(k, _)| k != id);
        let buf = Buf::new();
        list.push_back((id.to_string(), buf.clone()));
        while list.len() > KEEP {
            if let Some((_, old)) = list.pop_front() {
                old.halt();
            }
        }
        tauri::async_runtime::spawn(download(ym.clone(), id.to_string(), buf.clone()));
        buf
    }

    pub fn clear(&self) {
        for (_, b) in self.list.lock().unwrap().drain(..) {
            b.halt();
        }
    }
}

async fn download(ym: Arc<Yandex>, id: String, buf: Arc<Buf>) {
    let mut fails = 0;
    while !buf.stop.load(Relaxed) {
        let have = {
            let d = buf.data.lock().unwrap();
            if d.complete() {
                break;
            }
            d.bytes.len() as u64
        };
        match fetch_from(&ym, &id, &buf, have).await {
            Ok(()) => fails = 0,
            Err(()) => {
                fails += 1;
                if fails >= MAX_FAILS {
                    buf.data.lock().unwrap().failed = true;
                    break;
                }
                let pause = Duration::from_millis((300u64 << fails.min(5)).min(6000));
                tokio::time::sleep(pause).await;
            }
        }
    }
    buf.bump();
}

/// One connection's worth of download, from byte `have` on. Ok when it made
/// progress or finished; Err when it's time to back off.
async fn fetch_from(ym: &Yandex, id: &str, buf: &Buf, have: u64) -> Result<(), ()> {
    let url = ym.resolve_stream(id).await.map_err(|_| ())?;
    let mut req = ym.stream_http().get(&url);
    if have > 0 {
        req = req.header(header::RANGE, format!("bytes={have}-"));
    }
    let mut res = req.send().await.map_err(|_| ())?;
    let status = res.status().as_u16();
    if matches!(status, 401 | 403 | 404 | 410) {
        // Signed links expire — resolve a fresh one next time
        ym.forget_stream(id).await;
        return Err(());
    }
    if status == 416 && have > 0 {
        buf.data.lock().unwrap().total = Some(have);
        return Ok(());
    }
    if status != 200 && status != 206 {
        return Err(());
    }
    {
        let mut d = buf.data.lock().unwrap();
        if status == 200 && have > 0 {
            d.bytes.clear(); // the CDN ignored Range: start over
        }
        let h = res.headers();
        if d.ctype.is_none() {
            d.ctype = h.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(String::from);
        }
        if d.total.is_none() {
            let from_range = h
                .get(header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.rsplit('/').next())
                .and_then(|t| t.trim().parse::<u64>().ok());
            d.total = from_range.or_else(|| res.content_length().map(|n| n + d.bytes.len() as u64));
        }
        if let Some(t) = d.total {
            let more = (t as usize).saturating_sub(d.bytes.len());
            d.bytes.reserve(more);
        }
    }
    buf.bump();
    let mut progressed = false;
    loop {
        if buf.stop.load(Relaxed) {
            return Ok(());
        }
        match res.chunk().await {
            Ok(Some(c)) => {
                buf.data.lock().unwrap().bytes.extend_from_slice(&c);
                progressed = true;
                buf.bump();
            }
            Ok(None) => {
                let mut d = buf.data.lock().unwrap();
                if d.total.is_none() {
                    d.total = Some(d.bytes.len() as u64);
                }
                return Ok(());
            }
            // Dropped mid-way: resume right away if we got something, else back off
            Err(_) => return if progressed { Ok(()) } else { Err(()) },
        }
    }
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let state = app.state::<AppState>();
    let (ym, cache) = (state.ym.clone(), state.cache.clone());
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(&ym, &cache, &req).await);
    });
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .header(header::CACHE_CONTROL, "no-store")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    base(status).body(Vec::new()).unwrap()
}

fn audio(status: StatusCode, ctype: &str, len: usize) -> tauri::http::response::Builder {
    base(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len)
}

/// "bytes=START-[END]" → (start, end)
pub fn parse_range(h: Option<&str>) -> Option<(u64, Option<u64>)> {
    let spec = h?.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let start = a.trim().parse().ok()?;
    let end = b.trim().parse().ok();
    Some((start, end))
}

async fn serve(ym: &Arc<Yandex>, cache: &Cache, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS {
        return base(StatusCode::NO_CONTENT).header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range").body(Vec::new()).unwrap();
    }
    let Some(id) = req.uri().path().strip_prefix("/stream/") else { return empty(StatusCode::NOT_FOUND) };
    let id = id.trim_end_matches('/');
    if safe_id(id).is_err() {
        return empty(StatusCode::BAD_REQUEST);
    }
    let range = parse_range(req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()));
    let buf = cache.get(ym, id);
    let mut rx = buf.tick.subscribe();
    let deadline = tokio::time::Instant::now() + WAIT;

    loop {
        // Decide under the lock, act (await) after releasing it
        let go_direct = {
            let d = buf.data.lock().unwrap();
            let have = d.bytes.len() as u64;
            let finished = d.complete() || d.failed || buf.stop.load(Relaxed);
            let ctype = d.ctype.clone().unwrap_or_else(|| "audio/mpeg".into());
            match (range, d.total) {
                (None, Some(_)) if finished && have > 0 => {
                    return audio(StatusCode::OK, &ctype, d.bytes.len()).body(d.bytes.clone()).unwrap();
                }
                (Some((start, end)), Some(total)) => {
                    if start >= total {
                        return base(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                            .body(Vec::new())
                            .unwrap();
                    }
                    let want = end.unwrap_or(u64::MAX).min(total - 1).min(start + CHUNK - 1);
                    if have > want || have >= start + MIN_SERVE || (finished && have > start) {
                        let last = want.min(have - 1);
                        let body = d.bytes[start as usize..=last as usize].to_vec();
                        return audio(StatusCode::PARTIAL_CONTENT, &ctype, body.len())
                            .header(header::CONTENT_RANGE, format!("bytes {start}-{last}/{total}"))
                            .body(body)
                            .unwrap();
                    }
                    finished || start > have + FAR
                }
                _ if finished => return empty(StatusCode::BAD_GATEWAY),
                _ => false,
            }
        };
        if go_direct {
            let (start, end) = range.unwrap_or((0, None));
            return direct(ym, id, start, end).await;
        }
        match tokio::time::timeout_at(deadline, rx.changed()).await {
            Ok(Ok(())) => {}
            _ => return empty(StatusCode::GATEWAY_TIMEOUT),
        }
    }
}

/// A range straight from the CDN, bypassing the buffer (far seeks, failed downloads).
async fn direct(ym: &Yandex, id: &str, start: u64, end: Option<u64>) -> Response<Vec<u8>> {
    let end = end.map_or(start + CHUNK - 1, |e| e.min(start + CHUNK - 1));
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
        }
        let Ok(url) = ym.resolve_stream(id).await else { continue };
        let res = ym
            .stream_http()
            .get(&url)
            .header(header::RANGE, format!("bytes={start}-{end}"))
            .timeout(Duration::from_secs(30))
            .send()
            .await;
        let Ok(res) = res else { continue };
        let status = res.status().as_u16();
        if matches!(status, 401 | 403 | 404 | 410) {
            ym.forget_stream(id).await;
            continue;
        }
        if status != 206 {
            continue;
        }
        let ctype = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("audio/mpeg").to_string();
        let Some(cr) = res.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).map(String::from) else {
            continue;
        };
        let Ok(bytes) = res.bytes().await else { continue };
        let body = bytes.to_vec();
        return audio(StatusCode::PARTIAL_CONTENT, &ctype, body.len())
            .header(header::CONTENT_RANGE, cr)
            .body(body)
            .unwrap();
    }
    empty(StatusCode::BAD_GATEWAY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges_are_parsed() {
        assert_eq!(parse_range(Some("bytes=0-")), Some((0, None)));
        assert_eq!(parse_range(Some("bytes=100-199")), Some((100, Some(199))));
        assert_eq!(parse_range(Some("bytes=5-9, 20-30")), Some((5, Some(9))));
        assert_eq!(parse_range(Some("items=0-1")), None);
        assert_eq!(parse_range(None), None);
    }

    #[test]
    fn stream_urls_never_carry_secrets() {
        let u = url_for("12345");
        assert!(u.ends_with("/stream/12345"));
        assert!(!u.contains("get-mp3"));
    }
}

