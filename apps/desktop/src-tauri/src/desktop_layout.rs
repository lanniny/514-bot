use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use dunce::canonicalize;
use serde::Serialize;

static LAYOUT: OnceLock<DesktopLayout> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLayout {
    pub bundled: bool,
    pub kernel_dir: PathBuf,
    pub workspace_root: PathBuf,
    pub data_root: PathBuf,
    pub log_root: PathBuf,
    pub node: Option<PathBuf>,
    #[serde(skip)]
    seed_root: Option<PathBuf>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn regular_file(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(invalid("runtime input must be a regular file"));
    }
    Ok(())
}

impl DesktopLayout {
    fn discover(exe: &Path, development_root: &Path, data_home: &Path) -> io::Result<Self> {
        let base = exe
            .parent()
            .ok_or_else(|| invalid("executable has no parent directory"))?;
        let marker = base.join("514cc-bundle.json");
        if marker.exists() {
            regular_file(&marker)?;
            let value: serde_json::Value = serde_json::from_slice(&fs::read(marker)?)?;
            if value["schema"] != "514cc.portable/v1" {
                return Err(invalid("unsupported portable runtime manifest"));
            }
            let resources = canonicalize(base.join("resources"))?;
            let base = canonicalize(base)?;
            if !resources.starts_with(&base) {
                return Err(invalid(
                    "portable resources escape the application directory",
                ));
            }
            let kernel_dir = canonicalize(resources.join("control-center"))?;
            let node = base
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
            regular_file(&node)?;
            if !canonicalize(&node)?.starts_with(&base) || !kernel_dir.starts_with(&resources) {
                return Err(invalid(
                    "portable runtime input escapes the application directory",
                ));
            }
            regular_file(&kernel_dir.join("server.mjs"))?;
            regular_file(&kernel_dir.join("package.json"))?;
            if !data_home.is_absolute() {
                return Err(invalid("CC_DATA_HOME must be an absolute path"));
            }
            let existing_parent = data_home
                .ancestors()
                .find(|path| path.exists())
                .ok_or_else(|| invalid("cannot resolve data directory parent"))?;
            if canonicalize(existing_parent)?.starts_with(&base) {
                return Err(invalid(
                    "user data must be outside the application resources",
                ));
            }
            fs::create_dir_all(data_home)?;
            let data_home = canonicalize(data_home)?;
            if data_home.starts_with(&base) {
                return Err(invalid(
                    "user data must be outside the application resources",
                ));
            }
            Ok(Self {
                bundled: true,
                kernel_dir,
                workspace_root: data_home.join("workspace"),
                data_root: data_home.join("data"),
                log_root: data_home.join("logs"),
                node: Some(node),
                seed_root: Some(resources.join("seed")),
            })
        } else {
            if base.join("resources").exists() || base.join("runtime").exists() {
                return Err(invalid(
                    "portable runtime manifest is missing; refusing development fallback",
                ));
            }
            let root = canonicalize(development_root)?;
            let kernel_dir = root.join("apps").join("control-center");
            regular_file(&kernel_dir.join("server.mjs"))?;
            Ok(Self {
                bundled: false,
                kernel_dir,
                workspace_root: root.clone(),
                data_root: std::env::var_os("CONTROL_CENTER_DATA_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| root.join(".ai-shared").join("control-center")),
                log_root: root.join(".scratch").join("desktop-launch"),
                node: None,
                seed_root: None,
            })
        }
    }

    fn prepare(&self) -> io::Result<()> {
        if self.bundled {
            let home = self.workspace_root.parent().expect("user data parent");
            if canonicalize(home)? != home {
                return Err(invalid("user data root changed since discovery"));
            }
            for path in [
                &self.workspace_root,
                &self.data_root,
                &self.log_root,
                &self.workspace_root.join(".scratch"),
            ] {
                match fs::symlink_metadata(path) {
                    Ok(metadata) => {
                        if metadata.file_type().is_symlink()
                            || !metadata.is_dir()
                            || !canonicalize(path)?.starts_with(home)
                        {
                            return Err(invalid(
                                "user data directories must stay inside their verified root",
                            ));
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
        }
        fs::create_dir_all(&self.workspace_root)?;
        fs::create_dir_all(&self.data_root)?;
        fs::create_dir_all(&self.log_root)?;
        fs::create_dir_all(self.workspace_root.join(".scratch"))?;
        if let Some(seed) = &self.seed_root {
            let source = canonicalize(seed)?;
            if !source.starts_with(self.kernel_dir.parent().expect("resource parent")) {
                return Err(invalid("seed resources escape the application directory"));
            }
            let destination = canonicalize(&self.workspace_root)?;
            copy_missing_seed(&source, &destination, &destination)?;
        }
        Ok(())
    }
}

fn copy_missing_seed(source: &Path, destination: &Path, boundary: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    if !canonicalize(destination)?.starts_with(boundary) {
        return Err(invalid("seed destination escapes the user workspace"));
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(invalid("seed resources must not contain symbolic links"));
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_missing_seed(&entry.path(), &target, boundary)?;
        } else if kind.is_file() {
            if target.exists() {
                regular_file(&target)?;
                continue;
            }
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let temporary = destination.join(format!(".seed-{}-{stamp}.tmp", std::process::id()));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(&fs::read(entry.path())?)?;
                file.sync_all()?;
                // Publish without replacing a concurrent startup's or user's file.
                match fs::hard_link(&temporary, &target) {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        regular_file(&target)
                    }
                    Err(error) => Err(error),
                }
            })();
            let _ = fs::remove_file(temporary);
            result?;
        } else {
            return Err(invalid("unsupported seed resource type"));
        }
    }
    Ok(())
}

pub fn initialize() -> io::Result<&'static DesktopLayout> {
    let exe = std::env::current_exe()?;
    let development_root = std::env::var_os("CC_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    let data_home = std::env::var_os("CC_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|path| PathBuf::from(path).join("514Bot")))
        .or_else(|| {
            std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".local/share/514bot"))
        })
        .ok_or_else(|| invalid("cannot resolve user data directory; set CC_DATA_HOME"))?;
    let layout = DesktopLayout::discover(&exe, &development_root, &data_home)?;
    layout.prepare()?;
    LAYOUT
        .set(layout)
        .map_err(|_| invalid("desktop layout was already initialized"))?;
    Ok(current())
}

pub fn current() -> &'static DesktopLayout {
    LAYOUT
        .get()
        .expect("desktop layout initialized before Tauri startup")
}

pub fn is_bundled() -> bool {
    LAYOUT.get().is_some_and(|layout| layout.bundled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocated_bundle_uses_local_node_and_never_overwrites_user_config() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("514cc-layout-{}-{stamp}", std::process::id()));
        let bundle = root.join("application");
        let home = root.join("user-data");
        for directory in [
            "runtime",
            "resources/control-center",
            "resources/seed/config",
        ] {
            fs::create_dir_all(bundle.join(directory)).unwrap();
        }
        fs::write(
            bundle.join("514cc-bundle.json"),
            r#"{"schema":"514cc.portable/v1"}"#,
        )
        .unwrap();
        fs::write(
            bundle
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" }),
            "node fixture",
        )
        .unwrap();
        fs::write(
            bundle.join("resources/control-center/server.mjs"),
            "server fixture",
        )
        .unwrap();
        fs::write(bundle.join("resources/control-center/package.json"), "{}").unwrap();
        fs::write(
            bundle.join("resources/seed/config/settings.json"),
            "original seed",
        )
        .unwrap();
        let layout = DesktopLayout::discover(
            &bundle.join("desktop.exe"),
            &root.join("missing-dev-repo"),
            &home,
        )
        .unwrap();
        assert!(layout.bundled);
        #[cfg(windows)]
        assert!(!layout.kernel_dir.to_string_lossy().starts_with(r"\\?\"));
        layout.prepare().unwrap();
        let config = layout.workspace_root.join("config/settings.json");
        fs::write(&config, "user changes").unwrap();
        layout.prepare().unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), "user changes");
        assert!(
            DesktopLayout::discover(&bundle.join("desktop.exe"), &root, &bundle.join("data"))
                .is_err()
        );
        assert!(!bundle.join("data").exists());
        #[cfg(windows)]
        for name in ["workspace", "data", "logs"] {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};
            let link = home.join(name);
            let backup = home.join(format!("saved-{name}"));
            fs::rename(&link, &backup).unwrap();
            let target = bundle.join("resources/seed");
            let mut helper = Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:TEST_LINK_PATH -Target $env:TEST_LINK_TARGET -ErrorAction Stop | Out-Null"])
                .env("TEST_LINK_PATH", &link)
                .env("TEST_LINK_TARGET", &target)
                .creation_flags(crate::CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .spawn().unwrap();
            if !crate::reap_within(&mut helper, std::time::Duration::from_secs(10)) {
                let _ = helper.kill();
                panic!("junction fixture helper timed out");
            }
            assert!(helper.try_wait().unwrap().unwrap().success());
            assert!(
                layout.prepare().is_err(),
                "redirected {name} must be rejected"
            );
            assert!(!target.join(".scratch").exists());
            assert_eq!(
                fs::read_to_string(target.join("config/settings.json")).unwrap(),
                "original seed"
            );
            fs::remove_dir(&link).unwrap();
            fs::rename(backup, link).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }
}
