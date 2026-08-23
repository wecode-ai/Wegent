//! Native screenshot bridge for harness app pages.
//!
//! Harness app (smart app / plugin) pages run inside the Wework embedded
//! browser as remote content (`http://127.0.0.1:<random-port>`), so the
//! standard `getDisplayMedia` API is not available and Tauri rejects
//! remote-origin IPC unless a capability explicitly grants it.
//!
//! This inlined plugin exposes a single command that captures the calling
//! webview natively. `capabilities/harness-apps.json` grants it only to
//! local-loopback remote pages; the command additionally verifies the caller
//! is a harness app webview so ordinary embedded browser tabs stay out.

use tauri::{State, Webview, Wry};

use crate::embedded_browser::EmbeddedBrowserState;
#[cfg(target_os = "macos")]
use crate::embedded_browser::{
    embedded_browser_capture_snapshot, is_harness_app_browser_label, logical_label_for_native_label,
};

pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri::plugin::Builder::new("wegent-capture")
        .invoke_handler(tauri::generate_handler![capture_webview_snapshot])
        .build()
}

/// Capture the current webview as a PNG data URL.
///
/// The command resolves the calling webview itself, so harness pages do not
/// need to know their webview label. Only webviews whose logical embedded
/// browser label is a harness app (`app-harness-*`) are accepted.
#[tauri::command]
pub async fn capture_webview_snapshot(
    state: State<'_, EmbeddedBrowserState>,
    webview: Webview<Wry>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let native_label = webview.label().to_string();
        let logical_label = logical_label_for_native_label(state.inner(), &native_label)?
            .ok_or_else(|| {
                format!("Current webview {native_label} is not an embedded browser webview")
            })?;
        if !is_harness_app_browser_label(&logical_label) {
            return Err(format!(
                "Screenshot bridge is only available to harness app webviews, got {logical_label}"
            ));
        }
        embedded_browser_capture_snapshot(state, Some(logical_label)).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (state, webview);
        Err("Embedded browser screenshots are currently supported on macOS only".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use tauri::utils::acl::{
        capability::{Capability, CapabilityFile},
        manifest::{Manifest, PermissionFile},
        resolved::Resolved,
        Commands, ExecutionContext, Permission,
    };
    use tauri::{utils::platform::Target, Url};

    use super::is_harness_app_browser_label;

    fn wegent_capture_manifest() -> Manifest {
        Manifest::new(
            vec![PermissionFile {
                default: None,
                set: vec![],
                permission: vec![Permission {
                    version: None,
                    identifier: "allow-capture-webview-snapshot".into(),
                    description: None,
                    commands: Commands {
                        allow: vec!["capture_webview_snapshot".into()],
                        deny: vec![],
                    },
                    scope: Default::default(),
                    platforms: None,
                }],
            }],
            None,
        )
    }

    fn load_harness_apps_capability() -> Capability {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/harness-apps.json"
        );
        match CapabilityFile::load(path).expect("harness-apps.json should load") {
            CapabilityFile::Capability(capability) => capability,
            _ => panic!("harness-apps.json must contain a single capability"),
        }
    }

    #[test]
    fn harness_capability_grants_capture_only_to_loopback_pages() {
        let mut acl = BTreeMap::new();
        acl.insert("wegent-capture".to_string(), wegent_capture_manifest());
        let mut capabilities = BTreeMap::new();
        let capability = load_harness_apps_capability();
        capabilities.insert(capability.identifier.clone(), capability);

        let resolved = Resolved::resolve(&acl, capabilities, Target::current())
            .expect("capability resolution should succeed");
        let command = "plugin:wegent-capture|capture_webview_snapshot";
        let resolved_commands = resolved
            .allowed_commands
            .get(command)
            .expect("capture command should be allowed by the harness capability");

        let loopback_url = Url::parse("http://127.0.0.1:3080/").unwrap();
        let harness_webview = "embedded-browser-native-42";
        let allowed_on_harness_webview = resolved_commands.iter().any(|cmd| {
            cmd.webviews
                .iter()
                .any(|pattern| pattern.matches(harness_webview))
                && matches!(&cmd.context, ExecutionContext::Remote { url } if url.test(&loopback_url))
        });
        assert!(
            allowed_on_harness_webview,
            "loopback harness webview should be allowed to capture"
        );

        let remote_url = Url::parse("https://example.com/").unwrap();
        let allowed_on_remote_origin = resolved_commands.iter().any(|cmd| {
            cmd.webviews
                .iter()
                .any(|pattern| pattern.matches(harness_webview))
                && matches!(&cmd.context, ExecutionContext::Remote { url } if url.test(&remote_url))
        });
        assert!(
            !allowed_on_remote_origin,
            "non-loopback origins must not be able to capture"
        );
    }

    #[test]
    fn capture_is_limited_to_harness_app_webviews() {
        assert!(is_harness_app_browser_label(
            "app-harness-dsh-opsduty-workbench-auxiliary-workspace-tab"
        ));
        assert!(!is_harness_app_browser_label("workspace-browser"));
        assert!(!is_harness_app_browser_label("embedded-browser-native-1"));
    }
}
