//! Puts Tailscale on this PC: the phone and other PCs reach the bridge
//! through it. Signing in stays with the person, in Tailscale's own window.

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Stdio;
use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const DOWNLOAD_PAGE: &str = "https://tailscale.com/download/windows";
#[cfg(target_os = "macos")]
const DOWNLOAD_PAGE: &str = "https://tailscale.com/download/mac";

#[cfg(target_os = "macos")]
fn dir() -> PathBuf {
    PathBuf::from("/Applications/Tailscale.app")
}

/// Tailscale's app, where the person signs in. On macOS it is the app bundle.
#[cfg(target_os = "macos")]
fn app_in(dir: &Path) -> PathBuf {
    dir.join("Contents").join("Info.plist")
}

#[cfg(target_os = "macos")]
pub fn open() -> bool {
    Command::new("open").arg("-a").arg(dir()).spawn().is_ok()
}

/// macOS has no installer to run quietly here (Tailscale comes from the App
/// Store or its own download), so the download page opens and this is false.
#[cfg(target_os = "macos")]
pub fn install() -> bool {
    let _ = Command::new("open").arg(DOWNLOAD_PAGE).spawn();

    false
}

#[cfg(windows)]
fn dir() -> PathBuf {
    let program_files = std::env::var_os("ProgramFiles").map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);

    program_files.join("Tailscale")
}

/// Tailscale's window, where the person signs in.
#[cfg(windows)]
fn app_in(dir: &Path) -> PathBuf {
    dir.join("tailscale-ipn.exe")
}

pub fn installed_in(dir: &Path) -> bool {
    app_in(dir).is_file()
}

pub fn installed() -> bool {
    installed_in(&dir())
}

/// Opens Tailscale's window so the person can sign in.
#[cfg(windows)]
pub fn open() -> bool {
    Command::new(app_in(&dir())).spawn().is_ok()
}

/// Installs Tailscale with winget; Windows asks for permission once. Then
/// Tailscale's window opens for signing in. Without winget, or when the
/// install did not go through, the download page opens instead and this is
/// false.
#[cfg(windows)]
pub fn install() -> bool {
    let done = Command::new("winget")
        .args([
            "install",
            "--id",
            "Tailscale.Tailscale",
            "--exact",
            "--silent",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--disable-interactivity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|status| status.success());

    if done && installed() {
        return open();
    }

    let _ = Command::new("explorer").arg(DOWNLOAD_PAGE).spawn();

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_means_its_window_is_there() {
        let dir = tempfile::tempdir().unwrap();

        assert!(!installed_in(dir.path()));
        let app = app_in(dir.path());

        std::fs::create_dir_all(app.parent().unwrap()).unwrap();
        std::fs::write(&app, b"").unwrap();
        assert!(installed_in(dir.path()));
    }
}
