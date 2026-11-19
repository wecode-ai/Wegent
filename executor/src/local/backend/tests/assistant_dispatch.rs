use super::*;
use crate::task_runtime::LocalTaskStore;

fn is_isolated_case(name: &str) -> bool {
    // Other tests' handlers can outlive environment guards and capture the default store.
    const CASE_ENV: &str = "WEGENT_ASSISTANT_DISPATCH_TEST_CASE";
    if env::var(CASE_ENV).ok().as_deref() == Some(name) {
        return true;
    }
    let output = std::process::Command::new(env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("local::backend::tests::assistant_dispatch::{name}"),
            "--nocapture",
        ])
        .env(CASE_ENV, name)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("1 passed"), "{stdout}");
    false
}

#[test]
fn assistant_dispatch_heartbeat_uses_the_authorized_app_installation_identity() {
    if !is_isolated_case(
        "assistant_dispatch_heartbeat_uses_the_authorized_app_installation_identity",
    ) {
        return;
    }
    let _guard = env_lock();
    let root = tempfile::tempdir().unwrap();
    let previous_home = env::var_os("WEGENT_EXECUTOR_HOME");
    env::set_var("WEGENT_EXECUTOR_HOME", root.path());
    let (payload, settings) = {
        let store = LocalTaskStore::from_env().unwrap();
        let mut settings = store.personal_stand_in(7, "desktop-installation").unwrap();
        settings["primary"] = json!({
            "enabled": true,
            "prompt": "private prompt",
            "preferences": "private preferences",
            "collaboration": {
                "enabled": true,
                "allProjects": false,
                "projects": [{"id": "project-1", "store": "cloud"}],
                "excludedProjects": [],
                "tags": ["assignment"],
                "policy": {"automatic": true, "askBeforeAct": false}
            }
        });
        let saved = store
            .save_personal_stand_in(7, "desktop-installation", settings)
            .unwrap();
        let mut config = backend_config("backend-registration");
        config.device_type = "app".into();
        config.app_device_id = "desktop-installation".into();
        let client = LocalBackendClient::new(config, SocketIoTransport::default());
        let payload = client.heartbeat_payload();
        assert_eq!(store.personal_stand_in(7, "").unwrap(), saved);
        (payload, saved)
    };
    restore_env("WEGENT_EXECUTOR_HOME", previous_home);

    assert_eq!(payload["device_id"], "backend-registration");
    let declaration = &payload["runtime_features"]["personalAssistantDispatch"];
    let roles = declaration["roles"].as_array().unwrap();
    assert_eq!(
        roles.len(),
        1,
        "the saved App grant must reach the heartbeat"
    );
    assert_eq!(roles[0]["id"], "@primary");
    assert_eq!(roles[0]["userId"], 7);
    assert_eq!(roles[0]["version"], settings["version"]);
    assert_eq!(
        roles[0]["collaboration"]["projects"],
        json!([{"id":"project-1","store":"cloud"}])
    );
    assert!(!declaration.to_string().contains("private"));
}

#[test]
fn assistant_dispatch_does_not_borrow_another_installations_grant() {
    if !is_isolated_case("assistant_dispatch_does_not_borrow_another_installations_grant") {
        return;
    }
    let _guard = env_lock();
    let root = tempfile::tempdir().unwrap();
    let previous_home = env::var_os("WEGENT_EXECUTOR_HOME");
    env::set_var("WEGENT_EXECUTOR_HOME", root.path());
    let declarations = {
        let store = LocalTaskStore::from_env().unwrap();
        let mut settings = store.personal_stand_in(7, "authorized-device").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"private","preferences":"",
            "collaboration":{"enabled":true,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}});
        let saved = store
            .save_personal_stand_in(7, "authorized-device", settings)
            .unwrap();
        let declarations: Vec<Value> = [
            ("app", "authorized-device", ""),
            ("app", "authorized-device", "another-installation"),
            ("remote", "authorized-device", "another-installation"),
            ("remote", "another-installation", "authorized-device"),
        ]
        .into_iter()
        .map(|(device_type, registration_id, app_device_id)| {
            let mut config = backend_config(registration_id);
            config.device_type = device_type.into();
            config.app_device_id = app_device_id.into();
            LocalBackendClient::new(config, SocketIoTransport::default()).runtime_features()
                ["personalAssistantDispatch"]
                .clone()
        })
        .collect();
        assert_eq!(store.personal_stand_in(7, "").unwrap(), saved);
        declarations
    };
    restore_env("WEGENT_EXECUTOR_HOME", previous_home);

    for index in [0, 1, 3] {
        assert_eq!(declarations[index], json!({"version":1,"roles":[]}));
    }
    assert_eq!(declarations[2]["roles"][0]["id"], "@primary");
    assert_eq!(declarations[2]["roles"][0]["userId"], 7);
}
