//! Finds, starts and installs the Node bridge that Claude Code's hooks talk to.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub struct Config {
    pub port: u16,
    pub token: String,
}

/// `~/.choibuddy`, or `CHOIBUDDY_HOME` when set (the bridge reads the same).
pub fn home() -> PathBuf {
    if let Some(dir) = std::env::var_os("CHOIBUDDY_HOME") {
        return PathBuf::from(dir);
    }

    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();

    profile.join(".choibuddy")
}

pub fn read_config(home: &Path) -> Option<Config> {
    let text = std::fs::read_to_string(home.join("config.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let token = value.get("token")?.as_str()?.to_owned();
    let port = value.get("port").and_then(serde_json::Value::as_u64).unwrap_or(47130);

    if token.len() < 32 {
        return None;
    }

    Some(Config { port: u16::try_from(port).ok()?, token })
}

/// The UI's connection as JSON, or `null` before the bridge is installed.
pub fn connection_json(home: &Path) -> String {
    match read_config(home) {
        Some(config) => serde_json::json!({
            "baseUrl": format!("http://127.0.0.1:{}", config.port),
            "token": config.token,
        })
        .to_string(),
        None => "null".to_owned(),
    }
}

pub fn is_up(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);

    response.contains("\"name\":\"choibuddy\"")
}

fn node() -> Command {
    let mut command = Command::new("node");

    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

/// Starts the installed bridge when it is not answering. Spawned from this
/// app it lives outside any Claude Code process, so it keeps running after
/// sessions end.
pub fn ensure(home: &Path) -> bool {
    let Some(config) = read_config(home) else {
        return false;
    };

    if is_up(config.port) {
        return true;
    }

    let main = home.join("app").join("bridge").join("src").join("main.ts");

    if !main.exists() {
        return false;
    }

    let spawned = node()
        .arg("--no-warnings")
        .arg(&main)
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn();

    if spawned.is_err() {
        return false;
    }

    let deadline = Instant::now() + Duration::from_secs(4);

    while Instant::now() < deadline {
        if is_up(config.port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    false
}

/// Runs the bundled installer: copies the bridge into ~/.choibuddy and adds
/// the hooks to ~/.claude/settings.json (it backs the file up first).
pub fn install(resource_dir: &Path) -> bool {
    let script = resource_dir.join("bridge").join("src").join("install.ts");

    node()
        .arg("--no-warnings")
        .arg(script)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_valid_config_as_a_loopback_connection() {
        let dir = tempfile::tempdir().unwrap();

        std::fs::write(dir.path().join("config.json"), r#"{ "port": 47131, "token": "0123456789abcdefghijklmnopqrstuvwxyz" }"#).unwrap();

        let json: serde_json::Value = serde_json::from_str(&connection_json(dir.path())).unwrap();

        assert_eq!(json["baseUrl"], "http://127.0.0.1:47131");
        assert_eq!(json["token"], "0123456789abcdefghijklmnopqrstuvwxyz");
    }

    #[test]
    fn missing_or_weak_configs_mean_not_installed() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(connection_json(dir.path()), "null");

        std::fs::write(dir.path().join("config.json"), r#"{ "port": 47130, "token": "short" }"#).unwrap();
        assert_eq!(connection_json(dir.path()), "null");
    }

    #[test]
    fn nothing_listening_is_not_up() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        drop(listener);
        assert!(!is_up(port));
    }
}
