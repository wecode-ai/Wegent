// SPDX-License-Identifier: Apache-2.0
//! Real native host -> bundled Python SDK transport; no personal auth access.

use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use wegent_executor::plugin_account_auth::{AuthError, Credential, NativeAdapter};

fn python() -> PathBuf {
    std::env::var_os("WEGENT_TEST_PYTHON")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" }))
}

fn definition() -> Value {
    json!({"protocolVersion":1,"credentialType":"password","adapter":"scripts/account-auth.py"})
}

fn oauth_definition() -> Value {
    json!({"protocolVersion":1,"credentialType":"oauth2","adapter":"scripts/account-auth.py","oauth2":["authorize","refresh","revoke"]})
}

#[tokio::test]
async fn declared_local_configuration_reaches_export_but_not_business() {
    let root = fixture();
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let mut declaration = definition();
    declaration["localEnvironment"] = json!({name:{"type":"directory"}});
    fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        json!({
            "name":"native-fixture", "connectors":[{"slug":"mail","accountAuth":declaration}]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        root.path().join("scripts/account-auth.py"),
        format!(
            r#"
import json, os, sys
from wegent_plugin_auth import AccountAuthAdapter, local_configuration
def export():
    assert local_configuration() == {{{name:?}: os.environ[{name:?}]}}
    return {{"username":"alice", "password":"synthetic-native-secret"}}
def execute(value, arguments):
    assert local_configuration() == {{}}
    assert "WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION" not in os.environ
    print("configuration-isolated")
    return 0
adapter = AccountAuthAdapter(connector_slug="mail", credential_type="password", export=export,
    account_id=lambda value:value["username"], execute=execute, allowed_commands=("read",))
raise SystemExit(adapter.main(sys.argv[1:]))
"#
        ),
    )
    .unwrap();
    let adapter = NativeAdapter::load(root.path(), "mail", &declaration).unwrap();
    let exported = adapter
        .export(&python(), Duration::from_secs(5))
        .await
        .unwrap();
    let output = adapter
        .run(
            &python(),
            exported.credential,
            &["read".into()],
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap().trim(),
        "configuration-isolated"
    );
}

fn oauth_fixture() -> tempfile::TempDir {
    let root = fixture();
    fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        json!({
            "name":"native-fixture","connectors":[{"slug":"mail","accountAuth":oauth_definition()}]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(root.path().join("scripts/account-auth.py"), r#"
import json, sys, time
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter
def authorize():
    print("synthetic-auth-secret")
    return {"access_token":"synthetic-old-access","refresh_token":"synthetic-old-refresh","expires_at":time.time()-1,"account":"alice"}
def refresh(credential):
    assert credential["refresh_token"] == "synthetic-old-refresh"
    print("synthetic-refresh-secret", file=sys.stderr)
    return {"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","expires_at":time.time()+3600}
def revoke(credential):
    assert credential["refresh_token"] == "synthetic-new-refresh"
    Path("revoked.marker").write_text("revoked")
def execute(credential, arguments):
    assert "refresh_token" not in credential
    assert credential["access_token"] == "synthetic-new-access"
    print(json.dumps({"account":credential["account"]}))
    return 0
adapter = AccountAuthAdapter(connector_slug="mail",credential_type="oauth2",export=authorize,
    account_id=lambda value:value["account"],execute=execute,allowed_commands=("read",),
    authorize=authorize,refresh=refresh,revoke=revoke)
raise SystemExit(adapter.main(sys.argv[1:]))
"#).unwrap();
    root
}

#[tokio::test]
async fn oauth_native_authorize_refresh_and_revoke_use_only_the_private_channel() {
    use wegent_executor::plugin_account_auth::OAuthOperation;
    let root = oauth_fixture();
    let adapter = NativeAdapter::load(root.path(), "mail", &oauth_definition()).unwrap();
    let authorized = adapter
        .oauth_operation(
            &python(),
            OAuthOperation::Authorize,
            None,
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authorized.account_id, "alice");
    let refreshed = adapter
        .oauth_operation(
            &python(),
            OAuthOperation::Refresh,
            Some(authorized.credential),
            Duration::from_secs(5),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(refreshed.account_id, "alice");
    let revoked = adapter
        .oauth_operation(
            &python(),
            OAuthOperation::Revoke,
            Some(refreshed.credential),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(revoked.is_none());
    assert_eq!(
        fs::read_to_string(root.path().join("revoked.marker")).unwrap(),
        "revoked"
    );
}

#[derive(Clone)]
struct OAuthTransport(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

impl wegent_executor::local::backend::LocalBackendTransport for OAuthTransport {
    fn connect<'a>(
        &'a self,
        _: &'a wegent_executor::local::backend::LocalBackendConfig,
    ) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn disconnect<'a>(&'a self) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn call<'a>(&'a self, event: &'a str, payload: Value, _: Duration) -> TestFuture<'a, Value> {
        let finished = self
            .0
            .lock()
            .unwrap()
            .contains(&"plugin.auth.oauth.finish".to_owned());
        self.0.lock().unwrap().push(event.into());
        Box::pin(async move {
            let package = json!({"installed_plugin_id":42,"connector_slug":"mail","checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":oauth_definition()});
            match event {
                "plugin.auth.oauth.revocations" => {
                    assert_eq!(payload, json!({}));
                    Ok(json!({"success":true,"connection_ids":["c".repeat(64)]}))
                }
                "plugin.auth.oauth.revoke_begin" => {
                    assert_eq!(payload, json!({"connection_id":"c".repeat(64)}));
                    Ok(
                        json!({"success":true,"state":"claimed","connection_id":"c".repeat(64),
                        "operation_id":"e".repeat(64),"package":package,
                        "credential":json!({"access_token":"synthetic-new-access", "refresh_token":"synthetic-new-refresh","account":"alice"}).to_string()}),
                    )
                }
                "plugin.auth.oauth.revoke_finish" => {
                    assert_eq!(
                        payload,
                        json!({"connection_id":"c".repeat(64),
                        "operation_id":"e".repeat(64),"succeeded":true})
                    );
                    Ok(json!({"success":true,"state":"revoked"}))
                }
                "plugin.auth.prepare" => {
                    Ok(json!({"success":true,"operation":"authorize","package":package}))
                }
                "plugin.auth.enroll" => {
                    assert_eq!(payload["account_id"], "alice");
                    let credential: Value =
                        serde_json::from_str(payload["credential"].as_str().unwrap()).unwrap();
                    assert_eq!(credential["refresh_token"], "synthetic-old-refresh");
                    Ok(json!({"success":true,"connection":{
                        "id":"c".repeat(64),"installed_plugin_id":42,"plugin_key":"mail",
                        "connector_slug":"mail","account_id":"alice","account_label":"",
                        "credential_type":"oauth2","status":"connected","revision":2,"device_ids":["source"]
                    }}))
                }
                "plugin.auth.execute" if !finished => {
                    Ok(json!({"success":false,"error":"plugin_auth_refresh_required"}))
                }
                "plugin.auth.execute" => Ok(
                    json!({"success":true,"package":package,"credential":json!({"access_token":"synthetic-new-access","account":"alice"}).to_string()}),
                ),
                "plugin.auth.oauth.begin" => Ok(
                    json!({"success":true,"state":"claimed","connection_id":"c".repeat(64),"operation_id":"d".repeat(64),"package":package,"credential":json!({"access_token":"synthetic-old-access","refresh_token":"synthetic-old-refresh","account":"alice"}).to_string()}),
                ),
                "plugin.auth.oauth.finish" => {
                    assert_eq!(payload["succeeded"], true);
                    assert_eq!(payload["account_id"], "alice");
                    let rotated: Value =
                        serde_json::from_str(payload["credential"].as_str().unwrap()).unwrap();
                    assert_eq!(rotated["refresh_token"], "synthetic-new-refresh");
                    Ok(json!({"success":true,"state":"finished"}))
                }
                _ => panic!("Unexpected OAuth event"),
            }
        })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TestFuture<'a, ()> {
        panic!("No OAuth broadcast")
    }
    fn on(&self, _: &str, _: wegent_executor::local::backend::EventHandler) {
        panic!("No OAuth subscription")
    }
}

#[tokio::test]
async fn queued_revocation_runs_native_provider_and_acknowledges_without_secrets() {
    let root = oauth_fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    wegent_executor::plugin_account_auth::revoke_pending(OAuthTransport(calls.clone()), &home)
        .await
        .unwrap();
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "plugin.auth.oauth.revocations",
            "plugin.auth.oauth.revoke_begin",
            "plugin.auth.oauth.revoke_finish"
        ]
    );
    // The package store is the authoritative root used by both execution and revocation.
    assert!(home
        .join("capabilities/store/plugins/mail-42/revoked.marker")
        .exists());
}

#[tokio::test]
async fn oauth_authorization_intent_returns_only_account_metadata() {
    let root = oauth_fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let connection = wegent_executor::plugin_account_auth::migrate(
        OAuthTransport(calls.clone()),
        &home,
        &"b".repeat(64),
    )
    .await
    .unwrap();
    let metadata = serde_json::to_string(&connection).unwrap();
    assert!(!metadata.contains("synthetic"));
    assert_eq!(connection.account_id, "alice");
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["plugin.auth.prepare", "plugin.auth.enroll"]
    );
}

#[tokio::test]
async fn oauth_execution_refreshes_under_a_lease_before_business_dispatch() {
    let root = oauth_fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let output = wegent_executor::plugin_account_auth::execute(
        OAuthTransport(calls.clone()),
        &home,
        wegent_executor::plugin_account_auth::ExecutionRequest {
            installed_plugin_id: 42,
            connector_slug: "mail".into(),
            account_id: None,
            args: vec!["read".into()],
            working_directory: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"account":"alice"})
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            "plugin.auth.execute",
            "plugin.auth.oauth.begin",
            "plugin.auth.oauth.finish",
            "plugin.auth.execute"
        ]
    );
}

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join(".codex-plugin")).unwrap();
    fs::create_dir_all(root.path().join("scripts/wegent_plugin_auth")).unwrap();
    fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        json!({
            "name":"native-fixture","connectors":[{"slug":"mail","accountAuth":definition()}]
        })
        .to_string(),
    )
    .unwrap();
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../sdk/plugin-auth/wegent_plugin_auth");
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        if entry.path().extension().is_some_and(|ext| ext == "py") {
            fs::copy(
                entry.path(),
                root.path()
                    .join("scripts/wegent_plugin_auth")
                    .join(entry.file_name()),
            )
            .unwrap();
        }
    }
    fs::write(root.path().join("scripts/account-auth.py"), r#"
import json, os, subprocess, sys, time
from pathlib import Path
from wegent_plugin_auth import AccountAuthAdapter
SECRET = "synthetic-native-secret"
def export():
    print(SECRET)
    print(SECRET, file=sys.stderr)
    assert "WEGENT_AUTH_TOKEN" not in os.environ
    return {"username":"alice","password":SECRET}
def execute(value, args):
    if len(args) > 1: assert Path(args[1]).read_text() == "workspace-input"
    assert value["password"] == SECRET
    if args[0] == "fail": raise RuntimeError(SECRET)
    if args[0] == "sleep":
        Path("child.pid").write_text(str(os.getpid()))
        grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        Path("grandchild.pid").write_text(str(grandchild.pid))
        time.sleep(30)
    if args[0] == "large": print("x" * (1024 * 1024 + 1))
    else: print(json.dumps({"account":value["username"]}))
    return 0
adapter = AccountAuthAdapter(connector_slug="mail",credential_type="password",export=export,
    account_id=lambda value:value["username"],execute=execute,allowed_commands=("read","fail","sleep","large"))
raise SystemExit(adapter.main(sys.argv[1:]))
"#).unwrap();
    root
}

#[tokio::test]
async fn native_adapter_exports_and_executes_without_secret_output() {
    let root = fixture();
    let adapter = NativeAdapter::load(root.path(), "mail", &definition()).unwrap();
    let exported = adapter
        .export(&python(), Duration::from_secs(10))
        .await
        .unwrap();
    assert_eq!(exported.account_id, "alice");
    let output = adapter
        .run(
            &python(),
            exported.credential,
            &["read".into()],
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&output).unwrap(),
        json!({"account":"alice"})
    );
    assert!(!String::from_utf8(output)
        .unwrap()
        .contains("synthetic-native-secret"));
}

#[tokio::test]
async fn provider_failure_and_oversized_output_do_not_escape() {
    let root = fixture();
    let adapter = NativeAdapter::load(root.path(), "mail", &definition()).unwrap();
    for command in ["fail", "large"] {
        let credential =
            Credential::from_json(r#"{"username":"alice","password":"synthetic-native-secret"}"#)
                .unwrap();
        let error = adapter
            .run(
                &python(),
                credential,
                &[command.into()],
                None,
                Duration::from_secs(10),
            )
            .await
            .err()
            .unwrap();
        assert!(!error.to_string().contains("synthetic-native-secret"));
        assert!([
            "plugin_auth_execution_failed",
            "plugin_auth_output_too_large"
        ]
        .contains(&error.0));
    }
}

#[tokio::test]
async fn failed_bootstrap_returns_before_the_private_channel_deadline() {
    let root = fixture();
    fs::write(
        root.path().join("scripts/account-auth.py"),
        "import sys\nsys.stdin.buffer.read(32)\nprint('synthetic-bootstrap-secret')\nprint('synthetic-bootstrap-secret', file=sys.stderr)\nraise SystemExit(23)\n",
    )
    .unwrap();
    let adapter = NativeAdapter::load(root.path(), "mail", &definition()).unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        adapter.export(&python(), Duration::from_secs(60)),
    )
    .await
    .expect("a failed bootstrap must not wait for the private-channel deadline")
    .err()
    .unwrap();
    assert_eq!(error, AuthError("plugin_auth_execution_failed"));
}

#[tokio::test]
async fn timeout_terminates_the_adapter() {
    let root = fixture();
    let adapter = NativeAdapter::load(root.path(), "mail", &definition()).unwrap();
    let credential =
        Credential::from_json(r#"{"username":"alice","password":"synthetic-native-secret"}"#)
            .unwrap();
    let error = adapter
        .run(
            &python(),
            credential,
            &["sleep".into()],
            None,
            Duration::from_secs(2),
        )
        .await
        .err()
        .unwrap();
    assert_eq!(error, AuthError("plugin_auth_timeout"));
    assert!(root.path().join("child.pid").is_file());
    assert!(root.path().join("grandchild.pid").is_file());
    #[cfg(windows)]
    for file in ["child.pid", "grandchild.pid"] {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let pid = fs::read_to_string(root.path().join(file))
            .unwrap()
            .parse()
            .unwrap();
        // SAFETY: handles are opened only to wait for owned synthetic processes.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if handle.is_null() {
                assert_eq!(GetLastError(), ERROR_INVALID_PARAMETER);
            } else {
                let status = WaitForSingleObject(handle, 2000);
                CloseHandle(handle);
                assert_eq!(status, WAIT_OBJECT_0, "timed-out process tree must exit");
            }
        }
    }
    #[cfg(unix)]
    {
        let pid: i32 = fs::read_to_string(root.path().join("child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                // SAFETY: signal zero only checks the synthetic child's liveness.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("timed-out adapter must be terminated and reaped");
    }
}

#[test]
fn adapter_definition_and_path_must_match_the_installed_package() {
    let root = fixture();
    let changed =
        json!({"protocolVersion":1,"credentialType":"bearer","adapter":"scripts/account-auth.py"});
    assert!(NativeAdapter::load(root.path(), "mail", &changed).is_err());
    assert!(NativeAdapter::load(root.path(), "other", &definition()).is_err());
    #[cfg(unix)]
    {
        fs::remove_file(root.path().join("scripts/account-auth.py")).unwrap();
        std::os::unix::fs::symlink("/bin/sh", root.path().join("scripts/account-auth.py")).unwrap();
        assert!(NativeAdapter::load(root.path(), "mail", &definition()).is_err());
    }
}

#[derive(Clone)]
struct MigrationTransport(std::sync::Arc<std::sync::Mutex<Vec<String>>>);

type TestFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>;

impl wegent_executor::local::backend::LocalBackendTransport for MigrationTransport {
    fn connect<'a>(
        &'a self,
        _: &'a wegent_executor::local::backend::LocalBackendConfig,
    ) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn disconnect<'a>(&'a self) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn call<'a>(&'a self, event: &'a str, payload: Value, _: Duration) -> TestFuture<'a, Value> {
        self.0.lock().unwrap().push(event.into());
        Box::pin(async move {
            match event {
                "plugin.auth.automatic" => {
                    assert_eq!(payload, json!({"installed_plugin_ids":[42]}));
                    Ok(json!({"success":true,"migrations":[]}))
                }
                "plugin.auth.execute" => {
                    assert_eq!(
                        payload,
                        json!({"installed_plugin_id":42,"connector_slug":"mail","account_id":null})
                    );
                    Ok(json!({"success":true,"package":{
                        "installed_plugin_id":42,"connector_slug":"mail",
                        "checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":definition()
                    },"credential":r#"{"username":"alice","password":"synthetic-native-secret"}"#}))
                }
                "plugin.auth.prepare" => {
                    assert_eq!(payload, json!({"migration_id":"b".repeat(64)}));
                    Ok(json!({"success":true,"operation":"export","package":{
                        "installed_plugin_id":42,"connector_slug":"mail",
                        "checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":definition()
                    }}))
                }
                "plugin.auth.enroll" => {
                    let credential: Value =
                        serde_json::from_str(payload["credential"].as_str().unwrap()).unwrap();
                    assert_eq!(credential["password"], "synthetic-native-secret");
                    Ok(json!({"success":true,"connection":{
                        "id":"c".repeat(64),"installed_plugin_id":42,"plugin_key":"mail",
                        "connector_slug":"mail","account_id":"alice","account_label":"",
                        "credential_type":"password","status":"connected","revision":2,"device_ids":["source"]
                    }}))
                }
                _ => panic!("Unexpected credential event"),
            }
        })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TestFuture<'a, ()> {
        panic!("No broadcast")
    }
    fn on(&self, _: &str, _: wegent_executor::local::backend::EventHandler) {
        panic!("No subscription")
    }
}

fn managed_fixture(root: &Path, checksum: &str) -> PathBuf {
    let home = root.join("executor-home");
    let package = home.join("capabilities/store/plugins/mail-42");
    fs::create_dir_all(&package).unwrap();
    fs::rename(root.join("scripts"), package.join("scripts")).unwrap();
    fs::rename(root.join(".codex-plugin"), package.join(".codex-plugin")).unwrap();
    fs::write(
        home.join("capabilities/manifest.json"),
        json!({"plugins":{"mail@wework":{
            "installed_plugin_id":42,"managed":true,"enabled":true,
            "checksum":checksum,"store_path":package
        }}})
        .to_string(),
    )
    .unwrap();
    home
}

#[derive(Clone)]
struct TransferTransport {
    calls: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    package: PathBuf,
}

fn transfer_definition() -> Value {
    let mut definition = oauth_definition();
    definition["exportMode"] = json!("exclusive");
    definition
}

impl wegent_executor::local::backend::LocalBackendTransport for TransferTransport {
    fn connect<'a>(
        &'a self,
        _: &'a wegent_executor::local::backend::LocalBackendConfig,
    ) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn disconnect<'a>(&'a self) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn call<'a>(&'a self, event: &'a str, payload: Value, _: Duration) -> TestFuture<'a, Value> {
        self.calls.lock().unwrap().push(event.into());
        Box::pin(async move {
            let package = json!({"installed_plugin_id":42,"connector_slug":"mail","checksum":format!("sha256:{}", "a".repeat(64)),"auth_definition":transfer_definition()});
            let credential = json!({"access_token":"synthetic-old-access","refresh_token":"synthetic-old-refresh","account":"alice"}).to_string();
            match event {
                "plugin.auth.prepare" => Ok(json!({"success":true,"package":package,"operation":
                    if self.package.join("staged.marker").exists() {"transfer"} else {"export"}})),
                "plugin.auth.transfer.stage" => {
                    assert_eq!(payload["account_id"], "alice");
                    assert!(payload["credential"]
                        .as_str()
                        .unwrap()
                        .contains("synthetic-old-refresh"));
                    fs::write(self.package.join("staged.marker"), "staged").unwrap();
                    Ok(json!({"success":true,"state":"staged"}))
                }
                "plugin.auth.transfer.prepare" => Ok(
                    json!({"success":true,"state":"staged","package":package,"credential":credential}),
                ),
                "plugin.auth.transfer.finish" => {
                    assert_eq!(payload, json!({"migration_id":"b".repeat(64)}));
                    assert!(self.package.join("detached.marker").exists());
                    let attempts = self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|call| *call == event)
                        .count();
                    if attempts == 1 {
                        return Err("synthetic lost acknowledgement".into());
                    }
                    Ok(json!({"success":true,"connection":{
                        "id":"c".repeat(64),"installed_plugin_id":42,"plugin_key":"mail","connector_slug":"mail",
                        "account_id":"alice","account_label":"","credential_type":"oauth2","status":"connected",
                        "revision":2,"device_ids":["source"]
                    }}))
                }
                "plugin.auth.transfer.abort" => {
                    assert_eq!(payload, json!({"migration_id":"b".repeat(64)}));
                    assert!(self.package.join("aborted.marker").exists());
                    assert!(!self.package.join("detached.marker").exists());
                    let attempts = self
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|call| *call == event)
                        .count();
                    if attempts == 1 {
                        return Err("synthetic lost abort acknowledgement".into());
                    }
                    Ok(json!({"success":true,"state":"aborted"}))
                }
                _ => panic!("exclusive migration bypassed the transfer protocol"),
            }
        })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TestFuture<'a, ()> {
        panic!("No secret broadcast")
    }
    fn on(&self, _: &str, _: wegent_executor::local::backend::EventHandler) {
        panic!("No secret subscription")
    }
}

#[tokio::test]
async fn exclusive_transfer_resumes_without_exporting_again_and_requires_durable_detach() {
    let root = oauth_fixture();
    fs::write(root.path().join(".codex-plugin/plugin.json"),
        json!({"name":"fixture","connectors":[{"slug":"mail","accountAuth":transfer_definition()}]}).to_string()).unwrap();
    let script_path = root.path().join("scripts/account-auth.py");
    let script = fs::read_to_string(&script_path)
        .unwrap()
        .replace(
            "adapter = AccountAuthAdapter",
            r#"
def detach(migration_id, credential):
    assert migration_id == 'b' * 64
    assert credential['refresh_token'] == 'synthetic-old-refresh'
    assert Path('staged.marker').exists()
    if Path('blocked.marker').exists():
        raise RuntimeError('synthetic-private-detach-failure')
    print('synthetic-private-detach-output')
    Path('detached.marker').write_text('detached')
adapter = AccountAuthAdapter"#,
        )
        .replace("revoke=revoke)", "revoke=revoke,detach=detach)");
    fs::write(script_path, script).unwrap();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let package = home.join("capabilities/store/plugins/mail-42");
    fs::write(package.join("blocked.marker"), "blocked").unwrap();
    let transport = TransferTransport {
        calls: Default::default(),
        package: package.clone(),
    };
    let error =
        wegent_executor::plugin_account_auth::migrate(transport.clone(), &home, &"b".repeat(64))
            .await
            .unwrap_err();
    assert_eq!(error, AuthError("plugin_auth_execution_failed"));
    assert!(!transport
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|call| call == "plugin.auth.transfer.finish"));
    fs::remove_file(package.join("blocked.marker")).unwrap();
    let connection =
        wegent_executor::plugin_account_auth::migrate(transport.clone(), &home, &"b".repeat(64))
            .await
            .unwrap();
    assert_eq!(connection.account_id, "alice");
    assert!(!serde_json::to_string(&connection)
        .unwrap()
        .contains("synthetic-"));
    let calls = transport.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| *call == "plugin.auth.transfer.stage")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| *call == "plugin.auth.transfer.finish")
            .count(),
        2
    );
}

#[tokio::test]
async fn source_change_aborts_escrow_only_after_durable_adapter_confirmation() {
    let root = oauth_fixture();
    fs::write(root.path().join(".codex-plugin/plugin.json"),
        json!({"name":"fixture","connectors":[{"slug":"mail","accountAuth":transfer_definition()}]}).to_string()).unwrap();
    let path = root.path().join("scripts/account-auth.py");
    let script = fs::read_to_string(&path)
        .unwrap()
        .replace(
            "adapter = AccountAuthAdapter",
            r#"
def detach(migration_id, credential):
    from wegent_plugin_auth import SourceChanged
    assert migration_id == 'b' * 64
    assert Path('staged.marker').exists()
    Path('aborted.marker').write_text('fenced')
    print('synthetic-source-change-noise')
    raise SourceChanged('synthetic-private-source-details')
adapter = AccountAuthAdapter"#,
        )
        .replace("revoke=revoke)", "revoke=revoke,detach=detach)");
    fs::write(path, script).unwrap();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let transport = TransferTransport {
        calls: Default::default(),
        package: home.join("capabilities/store/plugins/mail-42"),
    };
    let error =
        wegent_executor::plugin_account_auth::migrate(transport.clone(), &home, &"b".repeat(64))
            .await
            .unwrap_err();
    assert_eq!(error, AuthError("plugin_auth_source_changed"));
    let calls = transport.calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| *call == "plugin.auth.transfer.abort")
            .count(),
        2
    );
    assert!(!calls
        .iter()
        .any(|call| call == "plugin.auth.transfer.finish"));
}

#[tokio::test]
async fn migration_resolves_managed_package_and_only_returns_connection_metadata() {
    let root = fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let connection = wegent_executor::plugin_account_auth::migrate(
        MigrationTransport(calls.clone()),
        &home,
        &"b".repeat(64),
    )
    .await
    .unwrap();
    assert_eq!(connection.account_id, "alice");
    assert!(!serde_json::to_string(&connection)
        .unwrap()
        .contains("synthetic-native-secret"));
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["plugin.auth.prepare", "plugin.auth.enroll"]
    );
}

#[tokio::test]
async fn mismatched_package_is_rejected_before_local_credentials_are_read() {
    let root = fixture();
    let home = managed_fixture(root.path(), "sha256:old-package");
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let result = wegent_executor::plugin_account_auth::migrate(
        MigrationTransport(calls.clone()),
        &home,
        &"b".repeat(64),
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        AuthError("plugin_auth_package_sync_required")
    );
    assert_eq!(*calls.lock().unwrap(), vec!["plugin.auth.prepare"]);
}

#[tokio::test]
async fn renderer_migration_entry_rejects_secret_payloads_and_requires_connected_backend() {
    use wegent_executor::config::device::DeviceConfig;
    use wegent_executor::local::app_ipc::AppIpcServer;
    use wegent_executor::local::backend::LocalBackendConnectionController;

    let controller = LocalBackendConnectionController::start(DeviceConfig::default()).await;
    let server = AppIpcServer::new().with_backend_connection_handler(controller);
    let description = server
        .dispatch("executor.protocol.describe", json!({}))
        .await
        .unwrap();
    assert!(description["renderer_methods"]
        .as_array()
        .unwrap()
        .contains(&json!("executor.plugin_auth.migrate")));
    let error = server.dispatch("executor.plugin_auth.migrate", json!({
        "migration_id":"b".repeat(64), "credential":"synthetic-secret", "plugin_root":"/tmp/untrusted"
    })).await.unwrap_err();
    assert_eq!(error.code, "plugin_auth_invalid_request");
    assert!(!error.message.contains("synthetic-secret"));
    let error = server
        .dispatch(
            "executor.plugin_auth.migrate",
            json!({"migration_id":"b".repeat(64)}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "backend_connection_unavailable");
}

#[tokio::test]
async fn granted_execution_returns_business_output_without_exporting_local_auth() {
    let root = fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    // The target device has no local authentication. Only broker credentials work.
    let script = home.join("capabilities/store/plugins/mail-42/scripts/account-auth.py");
    let source = fs::read_to_string(&script).unwrap().replace(
        "def export():",
        "def export():\n    raise RuntimeError('Cloud device has no local login')",
    );
    fs::write(script, source).unwrap();
    let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let output = wegent_executor::plugin_account_auth::execute(
        MigrationTransport(calls.clone()),
        &home,
        wegent_executor::plugin_account_auth::ExecutionRequest {
            installed_plugin_id: 42,
            connector_slug: "mail".into(),
            account_id: None,
            args: vec!["read".into()],
            working_directory: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&output).unwrap(),
        json!({"account":"alice"})
    );
    assert!(!output.contains("synthetic-native-secret"));
    assert_eq!(*calls.lock().unwrap(), vec!["plugin.auth.execute"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_sdk_cli_reaches_native_broker_without_local_login_or_secret_output() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use wegent_executor::plugin_account_auth::broker;
    let root = fixture();
    let home = managed_fixture(root.path(), &format!("sha256:{}", "a".repeat(64)));
    let package = home.join("capabilities/store/plugins/mail-42");
    let adapter = package.join("scripts/account-auth.py");
    let source = fs::read_to_string(&adapter).unwrap()
        .replace("def export():", "def export():\n    raise RuntimeError('No local login')")
        .replace("def execute(value, args):", "def execute(value, args):\n    from wegent_plugin_auth import delegate_cloud_command\n    assert delegate_cloud_command(Path('.'), 'mail', args, account_id='alice') is None");
    fs::write(adapter, source).unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("input.txt"), "workspace-input").unwrap();
    let cli = package.join("scripts/cli.py");
    fs::write(&cli, "import sys\nfrom pathlib import Path\nfrom wegent_plugin_auth import delegate_cloud_command\nresult = delegate_cloud_command(Path(__file__).resolve().parents[1], 'mail', sys.argv[1:])\nassert result is not None, 'Cloud command must not use local auth'\nraise SystemExit(result)\n").unwrap();
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let connected = Arc::new(AtomicBool::new(true));
    let server = broker::start(
        MigrationTransport(calls.clone()),
        home,
        connected.clone(),
        true,
    )
    .await
    .unwrap();
    let environment = broker::environment();
    let client = reqwest::Client::new();
    let url = &environment["WEGENT_PLUGIN_AUTH_BROKER"];
    let rejected: Value = client
        .post(url)
        .bearer_auth("invalid")
        .json(&json!({"credential":"synthetic-secret"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rejected, json!({"error":"plugin_auth_broker_unauthorized"}));
    let rejected: Value = client
        .post(url)
        .bearer_auth(&environment["WEGENT_PLUGIN_AUTH_BROKER_TOKEN"])
        .header("origin", "https://untrusted.example")
        .json(&json!({"installed_plugin_id":42,"connector_slug":"mail","args":["read"]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rejected, json!({"error":"plugin_auth_broker_unauthorized"}));
    assert!(calls
        .lock()
        .unwrap()
        .iter()
        .all(|event| event == "plugin.auth.automatic"));
    let output = tokio::process::Command::new(python())
        .arg(&cli)
        .arg("read")
        .arg("input.txt")
        .current_dir(&workspace)
        .envs(&environment)
        .output()
        .await
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"account":"alice"})
    );
    assert!(output.stderr.is_empty());
    connected.store(false, Ordering::Release);
    let failed = tokio::process::Command::new(python())
        .arg(&cli)
        .arg("read")
        .arg("input.txt")
        .current_dir(&workspace)
        .envs(&environment)
        .output()
        .await
        .unwrap();
    assert!(!failed.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&failed.stdout).unwrap(),
        json!({"error":"plugin_auth_backend_unavailable"})
    );
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.as_str() != "plugin.auth.automatic")
            .cloned()
            .collect::<Vec<_>>(),
        vec!["plugin.auth.execute"]
    );
    connected.store(true, Ordering::Release);
    let mut sleeping_cli = tokio::process::Command::new(python())
        .arg(&cli)
        .arg("sleep")
        .current_dir(&workspace)
        .envs(&environment)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !workspace.join("child.pid").exists() {
            assert!(sleeping_cli.try_wait().unwrap().is_none());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    drop(server);
    let cancelled = tokio::time::timeout(Duration::from_secs(5), sleeping_cli.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert!(!cancelled.status.success());
    assert!(!String::from_utf8_lossy(&cancelled.stdout).contains("synthetic-native-secret"));
    #[cfg(unix)]
    {
        let pid: i32 = fs::read_to_string(workspace.join("child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while unsafe { libc::kill(pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
    assert!(broker::environment().is_empty());
}
