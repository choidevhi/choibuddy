//! Updates the app from a GitHub release: downloads the installer, runs it
//! silently once this app has quit, and starts the new version.

use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const RELEASES: &str = "https://github.com/choidevhi/choibuddy/releases/download/";
// Smaller than this is an error page, not an installer.
const MIN_INSTALLER_BYTES: u64 = 1_000_000;

/// The installer's file name when `url` is one of this project's release
/// installers, else None: the app downloads nothing else.
pub fn installer_name(url: &str) -> Option<&str> {
    let rest = url.strip_prefix(RELEASES)?;
    let (tag, name) = rest.split_once('/')?;
    let plain = |text: &str| !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));

    (plain(tag) && plain(name) && name.starts_with("ChoiBuddy_") && name.ends_with("_x64-setup.exe")).then_some(name)
}

/// "0.6.1" is newer than "0.6.0"; anything unreadable is not newer.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    let parts = |text: &str| -> Option<Vec<u32>> { text.trim_start_matches('v').split('.').map(|part| part.parse().ok()).collect() };

    match (parts(candidate), parts(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn looks_like_installer(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    let mut head = [0u8; 2];
    let read = std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut head));

    meta.len() >= MIN_INSTALLER_BYTES && read.is_ok() && &head == b"MZ"
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    // Windows' own curl (10 1803 and later) follows GitHub's redirect to the file.
    let done = Command::new("curl.exe")
        .args(["-L", "--fail", "--silent", "--show-error", "--max-time", "600", "-o"])
        .arg(to)
        .arg(url)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| error.to_string())?;

    if !done.success() {
        return Err(format!("download failed ({done})"));
    }

    if !looks_like_installer(to) {
        return Err("the download is not an installer".to_owned());
    }

    Ok(())
}

/// Downloads the installer, then hands over to a hidden helper that waits
/// for this app to quit, installs silently and starts the new version. The
/// caller quits the app right after this returns Ok.
pub fn install(url: &str) -> Result<(), String> {
    let name = installer_name(url).ok_or_else(|| "not a ChoiBuddy release installer".to_owned())?;
    let dir: PathBuf = std::env::temp_dir().join("ChoiBuddy-update");

    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;

    let installer = dir.join(name);

    download(url, &installer)?;

    let app = std::env::current_exe().map_err(|error| error.to_string())?;
    // ping waits about two seconds for this app to be gone.
    let script = format!("ping -n 3 127.0.0.1 >nul & \"{}\" /S & start \"\" \"{}\"", installer.display(), app.display());

    Command::new("cmd")
        .arg("/C")
        .raw_arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_projects_installers_are_downloaded() {
        assert_eq!(
            installer_name("https://github.com/choidevhi/choibuddy/releases/download/v0.6.1/ChoiBuddy_0.6.1_x64-setup.exe"),
            Some("ChoiBuddy_0.6.1_x64-setup.exe")
        );
        assert_eq!(installer_name("https://github.com/someone/else/releases/download/v1/ChoiBuddy_1_x64-setup.exe"), None);
        assert_eq!(installer_name("https://github.com/choidevhi/choibuddy/releases/download/v0.6.1/ChoiBuddy-0.6.1.apk"), None);
        assert_eq!(installer_name("https://github.com/choidevhi/choibuddy/releases/download/v0.6.1/../ChoiBuddy_x64-setup.exe"), None);
        assert_eq!(installer_name("https://github.com/choidevhi/choibuddy/releases/download/v0.6.1/ChoiBuddy_\"&calc&_x64-setup.exe"), None);
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(is_newer("0.6.10", "0.6.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.6.0", "0.6.0"));
        assert!(!is_newer("0.5.9", "0.6.0"));
        assert!(!is_newer("beta", "0.6.0"));
    }

    #[test]
    fn a_short_or_foreign_file_is_not_an_installer() {
        let dir = tempfile::tempdir().unwrap();
        let page = dir.path().join("page.exe");

        std::fs::write(&page, b"<html>Not Found</html>").unwrap();
        assert!(!looks_like_installer(&page));

        let fake = dir.path().join("fake.exe");
        let mut bytes = vec![0u8; MIN_INSTALLER_BYTES as usize];

        bytes[0] = b'M';
        bytes[1] = b'Z';
        std::fs::write(&fake, &bytes).unwrap();
        assert!(looks_like_installer(&fake));
    }
}
