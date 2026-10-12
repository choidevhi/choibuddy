//! Puts Tailscale on this PC: the phone and other PCs reach the bridge
//! through it. Signing in stays with the person, in Tailscale's own window.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DOWNLOAD_PAGE: &str = "https://tailscale.com/download/windows";

fn dir() -> PathBuf {
    let program_files = std::env::var_os("ProgramFiles").map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from);

    program_files.join("Tailscale")
}

/// Tailscale's window, where the person signs in.
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
pub fn open() -> bool {
    Command::new(app_in(&dir())).spawn().is_ok()
}

/// Installs Tailscale with winget; Windows asks for permission once. Then
/// Tailscale's window opens for signing in. Without winget, or when the
/// install did not go through, the download page opens instead and this is
/// false.
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
        std::fs::write(dir.path().join("tailscale-ipn.exe"), b"").unwrap();
        assert!(installed_in(dir.path()));
    }
}
