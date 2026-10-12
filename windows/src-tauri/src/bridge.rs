//! Finds, starts and installs the Node bridge that Claude Code's hooks talk to.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
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

    let profile = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default();

    profile.join(".choibuddy")
}

/// Takes PATH from the person's login shell. Apps opened from Finder start
/// with /usr/bin:/bin:/usr/sbin:/sbin, which misses node (Homebrew, nvm, ...)
/// and claude, and the bridge and installer both need them. Interactive too,
/// since nvm and friends usually load from ~/.zshrc; the markers fence off
/// anything the shell's startup files print.
#[cfg(target_os = "macos")]
pub fn adopt_login_path() {
    const MARK: &str = "__CHOIBUDDY_PATH__";

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let Ok(output) = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);

    if let Some(path) = text.split(MARK).nth(1).filter(|path| !path.is_empty()) {
        // SAFETY: called first thing in `run`, before any other thread exists.
        unsafe { std::env::set_var("PATH", path) };
    }
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

/// The bridge's /api/health answer, or None when no ChoiBuddy bridge answers.
fn health(port: u16) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(400)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

    stream.write_all(request.as_bytes()).ok()?;

    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);

    response.contains("\"name\":\"choibuddy\"").then_some(response)
}

pub fn is_up(port: u16) -> bool {
    health(port).is_some()
}

/// The version the running bridge reports.
pub fn running_version(port: u16) -> Option<String> {
    let response = health(port)?;
    let start = response.find("\"version\":\"")? + "\"version\":\"".len();
    let end = response[start..].find('"')? + start;

    Some(response[start..end].to_owned())
}

const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// The Node the installer copied next to the bridge (the hooks use the same).
pub fn installed_node(home: &Path) -> PathBuf {
    home.join("app").join("node").join(NODE)
}

/// The Node this app ships with, so nobody needs one of their own.
pub fn bundled_node(resource_dir: &Path) -> PathBuf {
    resource_dir.join("runtime").join(NODE)
}

/// The first of `candidates` that exists, else `node` from the PATH (a bridge
/// installed by an older version, or from a clone).
fn node_program(candidates: &[PathBuf]) -> PathBuf {
    candidates.iter().find(|path| path.is_file()).cloned().unwrap_or_else(|| PathBuf::from("node"))
}

fn node(candidates: &[PathBuf]) -> Command {
    let mut command = Command::new(node_program(candidates));

    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command
}

/// Starts the installed bridge when it is not answering. Spawned from this
/// app it lives outside any Claude Code process, so it keeps running after
/// sessions end. `bundled` is this app's own Node, used when the installed
/// copy is missing.
pub fn ensure(home: &Path, bundled: Option<&Path>) -> bool {
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

    let mut candidates = vec![installed_node(home)];

    candidates.extend(bundled.map(Path::to_path_buf));

    let mut command = node(&candidates);

    command.arg("--no-warnings").arg(&main);

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);

    // Its own process group, so quitting the app does not take it down.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);

    let spawned = command.spawn();

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

/// Runs the bundled installer with the bundled Node: copies the bridge and
/// that Node into ~/.choibuddy and adds the hooks to ~/.claude/settings.json
/// (it backs the file up first).
pub fn install(resource_dir: &Path) -> bool {
    run_installer(resource_dir, false) == Some(0)
}

fn run_installer(resource_dir: &Path, when_idle: bool) -> Option<i32> {
    let script = resource_dir.join("bridge").join("src").join("install.ts");
    let mut command = node(&[bundled_node(resource_dir)]);

    command.arg("--no-warnings").arg(script);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    if when_idle {
        command.arg("--when-idle");
    }

    command.status().ok()?.code()
}

// The installer's answer while an approval request waits.
const BUSY: i32 = 3;
const UPGRADE_RETRY: Duration = Duration::from_secs(5 * 60);
const UPGRADE_TRIES: u32 = 24;

/// After the app updated itself, the bridge, the hooks and the mod follow:
/// when the running bridge is older than this app, the bundled installer
/// runs once no approval request waits (it keeps Auto Accept). Nothing
/// happens where ChoiBuddy was never connected to Claude Code.
pub fn upgrade_if_older(resource_dir: &Path, home: &Path, app_version: &str) {
    let Some(config) = read_config(home) else {
        return;
    };

    if !home.join("app").exists() {
        return;
    }

    for _ in 0..UPGRADE_TRIES {
        let Some(running) = running_version(config.port) else {
            return;
        };

        if !crate::update::is_newer(app_version, &running) {
            return;
        }

        match run_installer(resource_dir, true) {
            Some(BUSY) => std::thread::sleep(UPGRADE_RETRY),
            _ => return,
        }
    }
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
    fn runs_the_first_node_that_exists_else_the_one_on_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let installed = installed_node(dir.path());
        let bundled = bundled_node(dir.path());

        assert_eq!(node_program(&[installed.clone(), bundled.clone()]), PathBuf::from("node"));

        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"").unwrap();
        assert_eq!(node_program(&[installed.clone(), bundled.clone()]), bundled);

        std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
        std::fs::write(&installed, b"").unwrap();
        assert_eq!(node_program(&[installed.clone(), bundled]), installed);
    }

    #[test]
    fn reads_the_running_bridges_version() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 512];
            let _ = std::io::Read::read(&mut stream, &mut request);
            let body = r#"{"ok":true,"name":"choibuddy","version":"0.6.1","pid":1}"#;
            let _ = std::io::Write::write_all(&mut stream, format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes());
        });

        assert_eq!(running_version(port).as_deref(), Some("0.6.1"));
        server.join().unwrap();
    }

    #[test]
    fn nothing_listening_is_not_up() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        drop(listener);
        assert!(!is_up(port));
    }
}
