use std::sync::Mutex;

use tauri::{ipc::CapabilityBuilder, AppHandle, Manager};

#[derive(Default)]
enum Phase {
    #[default]
    Pending,
    Granted(u16),
    Revoked,
}

#[derive(Default)]
pub struct KernelAccess(Mutex<Phase>);

fn permissions() -> Vec<String> {
    let mut permissions = include_str!("native-command-names.txt")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .collect::<Vec<_>>();
    let chrome: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/window-chrome.json"))
            .expect("valid window capability template");
    permissions.extend(
        chrome["permissions"]
            .as_array()
            .expect("window permissions")
            .iter()
            .map(|value| value.as_str().expect("permission reference").to_owned()),
    );
    permissions
}

fn pet_permissions() -> Vec<String> {
    let pet: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/pet-window.json"))
            .expect("valid pet capability template");
    pet["permissions"]
            .as_array()
            .expect("pet window permissions")
            .iter()
            .map(|value| value.as_str().expect("permission reference").to_owned())
            .collect()
}

fn capability(port: u16, deny: bool, pet: bool) -> CapabilityBuilder {
    let kind = if deny { "revoked" } else { "active" };
    let window = if pet { "pet-overlay" } else { "main" };
    let mut builder = CapabilityBuilder::new(format!("kernel-{kind}-{port}-{window}"))
        .local(false)
        .window(window)
        .remote(format!("http://127.0.0.1:{port}/*"));
    for permission in if pet { pet_permissions() } else { permissions() } {
        builder = builder.permission(if deny {
            permission.replacen("allow-", "deny-", 1)
        } else {
            permission
        });
    }
    builder
}

impl KernelAccess {
    pub fn grant(
        &self,
        port: u16,
        mut install: impl FnMut(CapabilityBuilder) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut phase = self.0.lock().map_err(|_| "kernel access lock poisoned")?;
        if port == 0 || !matches!(*phase, Phase::Pending) {
            return Err("kernel origin cannot be granted after activation or cancellation".into());
        }
        install(capability(port, false, true))?;
        if let Err(error) = install(capability(port, false, false)) {
            *phase = Phase::Revoked;
            install(capability(port, true, true))?;
            return Err(error);
        }
        *phase = Phase::Granted(port);
        Ok(())
    }

    fn revoke(
        &self,
        mut install: impl FnMut(CapabilityBuilder) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut phase = self.0.lock().map_err(|_| "kernel access lock poisoned")?;
        let previous = std::mem::replace(&mut *phase, Phase::Revoked);
        if let Phase::Granted(port) = previous {
            // Runtime ACL additions do not replace previous identifiers. Explicit
            // deny rules take precedence over all grants for this exact origin.
            let main = install(capability(port, true, false));
            let pet = install(capability(port, true, true));
            main?;
            pet?;
        }
        Ok(())
    }
}

pub fn revoke(app: &AppHandle) {
    if let Err(error) = app.state::<KernelAccess>().revoke(|capability| {
        app.add_capability(capability)
            .map_err(|error| error.to_string())
    }) {
        eprintln!("kernel native access revocation failed: {error}");
        app.exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{capability, KernelAccess};
    use tauri::ipc::Origin;

    #[test]
    fn compiled_acl_grants_only_the_current_kernel_and_revocation_is_final() {
        let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        let authority = context.runtime_authority_mut();
        let remote = |url: &str| Origin::Remote {
            url: url.parse().unwrap(),
        };
        let active = remote("http://127.0.0.1:52123/#bot");
        let mut commands = include_str!("native-command-names.txt")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        commands.extend(
            [
                "minimize",
                "toggle_maximize",
                "close",
                "start_dragging",
                "is_maximized",
            ]
            .map(|command| format!("plugin:window|{command}")),
        );
        for command in &commands {
            assert!(authority
                .resolve_access(command, "main", "main", &active)
                .is_none());
        }
        authority.add_capability(capability(52123, false, false)).unwrap();
        authority.add_capability(capability(52123, false, true)).unwrap();
        for command in &commands {
            assert!(
                authority
                    .resolve_access(command, "main", "main", &active)
                    .is_some(),
                "{command}"
            );
            assert_eq!(
                authority
                    .resolve_access(command, "pet-overlay", "pet-overlay", &active)
                    .is_some(),
                command == "plugin:window|start_dragging",
                "{command}: pet-overlay window"
            );
            for origin in [
                Origin::Local,
                remote("http://127.0.0.1:51400/"),
                remote("http://127.0.0.1:52124/"),
                remote("http://localhost:52123/"),
                remote("http://[::1]:52123/"),
                remote("https://127.0.0.1:52123/"),
                remote("https://example.com/"),
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &origin)
                        .is_none(),
                    "{command}: foreign origin"
                );
                assert!(
                    authority
                        .resolve_access(command, "pet-overlay", "pet-overlay", &origin)
                        .is_none(),
                    "{command}: foreign origin on pet-overlay"
                );
            }
            assert!(authority
                .resolve_access(command, "splash", "splash", &active)
                .is_none());
        }
        assert!(authority
            .resolve_access("plugin:window|destroy", "main", "main", &active)
            .is_none());
        assert!(authority.resolve_access("plugin:window|set_ignore_cursor_events", "pet-overlay", "pet-overlay", &active).is_some());
        for pet in [false, true] {
            authority.add_capability(capability(52123, true, pet)).unwrap();
            authority.add_capability(capability(52123, false, pet)).unwrap();
        }
        for command in &commands {
            assert!(authority
                .resolve_access(command, "main", "main", &active)
                .is_none());
            assert!(authority.resolve_access(command, "pet-overlay", "pet-overlay", &active).is_none());
        }
        assert!(authority.resolve_access("plugin:window|set_ignore_cursor_events", "pet-overlay", "pet-overlay", &active).is_none());
    }

    #[test]
    fn cancellation_before_handshake_prevents_a_late_grant() {
        let access = KernelAccess::default();
        access.revoke(|_| panic!("no grant to revoke")).unwrap();
        assert!(access.grant(52123, |_| panic!("must not install")).is_err());
    }

    #[test]
    fn one_kernel_generation_gets_one_grant_and_one_revocation() {
        let access = KernelAccess::default();
        access.grant(52123, |_| Ok(())).unwrap();
        assert!(access
            .grant(52124, |_| panic!("cannot extend the origin set"))
            .is_err());
        access.revoke(|_| Ok(())).unwrap();
        access.revoke(|_| panic!("already revoked")).unwrap();
    }
}
