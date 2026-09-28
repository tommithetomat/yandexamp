//! Persistent session storage.
//!
//! Layers, from outside in:
//! 1. The OS credential vault — Windows Credential Manager (DPAPI, bound to the
//!    user account) / macOS Keychain (item ACL bound to this app's signature;
//!    other apps trigger a system prompt). Nothing is written to our data folder.
//! 2. Inside the vault we store ciphertext, not the token: AES-256-GCM with a key
//!    derived from this machine's id + the OS user name + a compiled-in pepper.
//!    Generic stealers that dump the whole credential vault get an opaque blob,
//!    and a blob copied to another computer can't be decrypted there.
//!
//! What this does NOT stop: malware that targets YandexAmp specifically while
//! running as the same user — it can do everything this code does. No purely
//! local scheme can; the answer to that is revocation (see `Yandex::revoke`).

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const SERVICE: &str = "ru.yandexamp.player";
const ACCOUNT: &str = "yandex-music-session";
// Not a secret against targeted reverse engineering — it only makes the vault
// entry useless to tools that grab credentials in bulk.
const PEPPER: &[u8] = b"yandexamp/vault/v1/7f3c9a51e2b84d06a1";
const NONCE_LEN: usize = 12;

pub struct Stored {
    pub token: Zeroizing<String>,
    pub uid: Option<String>,
}

fn device_key() -> Zeroizing<[u8; 32]> {
    let machine = machine_uid::get().unwrap_or_default();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let mut h = Sha256::new();
    h.update(PEPPER);
    h.update(machine.as_bytes());
    h.update(b"|");
    h.update(user.as_bytes());
    Zeroizing::new(h.finalize().into())
}

fn cipher() -> Aes256Gcm {
    let key = device_key();
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key[..]))
}

fn seal(plain: &[u8]) -> Result<String, String> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct = cipher().encrypt(&nonce, plain).map_err(|_| "Не удалось зашифровать сессию".to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(format!("v1:{}", B64.encode(blob)))
}

fn open(sealed: &str) -> Option<Zeroizing<Vec<u8>>> {
    let blob = B64.decode(sealed.strip_prefix("v1:")?).ok()?;
    if blob.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    cipher().decrypt(Nonce::from_slice(nonce), ct).ok().map(Zeroizing::new)
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn save_to(account: &str, token: &str, uid: Option<&str>) -> Result<(), String> {
    let payload = Zeroizing::new(json!({ "t": token, "u": uid }).to_string());
    let sealed = seal(payload.as_bytes())?;
    entry(account)?.set_password(&sealed).map_err(|e| format!("Не удалось сохранить вход: {e}"))
}

fn load_from(account: &str) -> Option<Stored> {
    let e = entry(account).ok()?;
    let sealed = Zeroizing::new(e.get_password().ok()?);
    let stored = open(&sealed).and_then(|plain| {
        let v: Value = serde_json::from_slice(&plain).ok()?;
        Some(Stored {
            token: Zeroizing::new(v["t"].as_str()?.to_string()),
            uid: v["u"].as_str().map(String::from),
        })
    });
    if stored.is_none() {
        // Unreadable here (copied from another PC, tampered with) — drop it
        let _ = e.delete_credential();
    }
    stored
}

fn clear_at(account: &str) {
    if let Ok(e) = entry(account) {
        let _ = e.delete_credential();
    }
}

pub fn save(token: &str, uid: Option<&str>) -> Result<(), String> {
    save_to(ACCOUNT, token, uid)
}

pub fn load() -> Option<Stored> {
    load_from(ACCOUNT)
}

pub fn clear() {
    clear_at(ACCOUNT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_blob_roundtrips_and_hides_token() {
        let sealed = seal(b"y0_secret-token").unwrap();
        assert!(!sealed.contains("secret"));
        assert_eq!(open(&sealed).unwrap().as_slice(), b"y0_secret-token");
    }

    #[test]
    fn tampered_blob_is_rejected() {
        let sealed = seal(b"y0_secret-token").unwrap();
        let mut raw = B64.decode(sealed.strip_prefix("v1:").unwrap()).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert!(open(&format!("v1:{}", B64.encode(raw))).is_none());
    }

    #[test]
    fn os_vault_roundtrip() {
        let acc = "unit-test-session";
        save_to(acc, "y0_test_token_value", Some("123")).unwrap();
        let got = load_from(acc).expect("stored session");
        assert_eq!(got.token.as_str(), "y0_test_token_value");
        assert_eq!(got.uid.as_deref(), Some("123"));
        clear_at(acc);
        assert!(load_from(acc).is_none());
    }
}
