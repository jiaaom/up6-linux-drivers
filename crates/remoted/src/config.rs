//! /etc/remoted.toml: one `[[remote]]` table per kind of remote.

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default)]
    remote: Vec<RawRemote>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRemote {
    name: Option<String>,
    address: Option<String>,
    characteristic: String,
    #[serde(default)]
    code_byte: usize,
    #[serde(default = "zero")]
    release: String,
    #[serde(default = "yes")]
    repeat: bool,
    keys: BTreeMap<String, String>,
}

fn zero() -> String {
    "0x00".into()
}
fn yes() -> bool {
    true
}

/// One kind of remote, and how its codes become keys.
#[derive(Debug, Clone)]
pub struct Remote {
    /// BlueZ device Name (or Alias) to match; any name if unset.
    pub name: Option<String>,
    /// Bluetooth address to match (AA:BB:…); any address if unset.
    pub address: Option<String>,
    /// UUID of the GATT characteristic that notifies the key codes.
    pub characteristic: String,
    /// Which byte of a notification holds the key code.
    pub code_byte: usize,
    /// The code sent when every key is up.
    pub release: u8,
    /// Let the kernel autorepeat held keys (for remotes that don't repeat).
    pub repeat: bool,
    /// Remote code -> Linux key code.
    pub keys: BTreeMap<u8, u16>,
}

impl Remote {
    /// A readable label for logs and the uinput device name.
    pub fn label(&self) -> String {
        self.name.clone().or_else(|| self.address.clone()).unwrap_or_else(|| self.characteristic.clone())
    }
}

pub fn parse_int(s: &str) -> Option<u64> {
    let s = s.trim();
    match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u64::from_str_radix(h, 16).ok(),
        None => s.parse().ok(),
    }
}

pub fn parse(text: &str) -> Result<Vec<Remote>, String> {
    let file: File = toml::from_str(text).map_err(|e| e.to_string())?;
    if file.remote.is_empty() {
        return Err("no [[remote]] configured".into());
    }
    file.remote
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            let what = format!("remote #{}", i + 1);
            let byte = |s: &str| parse_int(s).and_then(|n| u8::try_from(n).ok());
            let release = byte(&r.release).ok_or(format!("{what}: bad release code {:?}", r.release))?;
            let mut keys = BTreeMap::new();
            for (code, key) in &r.keys {
                let c = byte(code).ok_or(format!("{what}: bad remote code {code:?} (0x00..0xff)"))?;
                let k = crate::keys::parse(key).ok_or(format!("{what}: unknown key {key:?}"))?;
                if c == release {
                    return Err(format!("{what}: code {code} is the release code"));
                }
                keys.insert(c, k);
            }
            if keys.is_empty() {
                return Err(format!("{what}: no keys"));
            }
            let uuid = r.characteristic.trim().to_ascii_lowercase();
            if uuid.len() != 36 || uuid.matches('-').count() != 4 {
                return Err(format!("{what}: characteristic must be a full 128-bit UUID"));
            }
            Ok(Remote {
                name: r.name.filter(|s| !s.is_empty()),
                address: r.address.map(|a| a.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()),
                characteristic: uuid,
                code_byte: r.code_byte,
                release,
                repeat: r.repeat,
                keys,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn shipped_config_parses() {
        let r = parse(include_str!("../remoted.toml")).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name.as_deref(), Some("T2_remote_RC001"));
        assert_eq!(r[0].keys.get(&0x52), Some(&103)); // KEY_UP
        assert_eq!(r[0].keys.get(&0x7f), Some(&1)); // KEY_ESC
        assert_eq!(r[0].keys.len(), 11);
    }

    #[test]
    fn rejects_bad_input() {
        let base = "[[remote]]\ncharacteristic = \"6e40ff03-b5a3-f393-e0a9-e50e24dcca9e\"\n";
        assert!(parse(&format!("{base}[remote.keys]\n\"0x52\" = \"KEY_BOGUS\"\n")).is_err());
        assert!(parse(&format!("{base}[remote.keys]\n\"0x152\" = \"KEY_UP\"\n")).is_err());
        assert!(parse(&format!("{base}[remote.keys]\n\"0x00\" = \"KEY_UP\"\n")).is_err());
        assert!(parse(&format!("{base}[remote.keys]\n\"82\" = \"up\"\n")).is_ok());
        assert!(parse("").is_err());
    }
}
