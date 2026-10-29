// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(unix)]
const CONFIG: &str = "model = \"fixture-model\"\nopenai_base_url = \"http://fixture.invalid/v1\"\n";

#[cfg(unix)]
struct HeldNativeWrite {
    client: CodexAppServerClient,
    stdin: Arc<Mutex<ChildStdin>>,
    request: tokio::task::JoinHandle<Result<Value, String>>,
    home: tempfile::TempDir,
}

#[cfg(unix)]
impl HeldNativeWrite {
    async fn start(method: &'static str) -> Self {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("config.toml"), CONFIG).unwrap();
        let mut command = Command::new("sh");
        command.args(["-c", r#"
            IFS= read -r request || exit 1
            : > "$1/config.toml"
            printf '%s\n' '{"method":"fixture/partial"}'
            IFS= read -r release || exit 1
            [ "$release" != exit ] || exit 0
            printf '%s\n' 'model = "fixture-model"' 'openai_base_url = "http://fixture.invalid/v1"' > "$1/config.toml"
            if [ "$release" = error ]; then
                printf '%s\n' '{"id":1,"error":{"code":-1,"message":"native error"}}'
            else
                printf '%s\n' '{"id":1,"result":{}}'
            fi
            while IFS= read -r unused; do :; done
        "#, "config-writer"]).arg(home.path());
        configure_codex_app_server_process_group(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let stdout = CodexStdout::new(child.stdout.take().unwrap(), None);
        let pending = Arc::new(PendingCodexRequests::default());
        let notifications = CodexNotificationHub::new();
        let mut observer = notifications.subscribe_all();
        let reader_task = tokio::spawn(read_persistent_codex_app_server_stdout(
            stdout,
            Arc::clone(&pending),
            notifications.clone(),
        ));
        let process = CodexAppServerProcess {
            config_diagnostics: Some(CodexConfigDiagnosticTarget::new(
                home.path().to_path_buf(),
                child.id(),
            )),
            child,
            stdin: Arc::clone(&stdin),
            pending: Arc::clone(&pending),
            notifications,
            reader_task,
        };
        let handle = process.handle();
        let state = CodexAppServerSharedState {
            process: Some(process),
            process_environment: BTreeMap::from([(
                CODEX_HOME_ENV.to_owned(),
                home.path().display().to_string(),
            )]),
            ..CodexAppServerSharedState::default()
        };
        let client = CodexAppServerClient {
            binary: "unused-native-config-fixture".to_owned(),
            home: Some(home.path().to_path_buf()),
            state: Arc::new(Mutex::new(state)),
        };
        let (sender, receiver) = oneshot::channel();
        let request = pending
            .insert(
                1,
                method,
                Instant::now() + Duration::from_secs(10),
                10,
                sender,
            )
            .await;
        let request = tokio::spawn(CodexAppServerClient::send_request_and_wait(
            method,
            json!({}),
            10,
            request,
            handle,
            receiver,
        ));
        let notification = timeout(Duration::from_secs(5), observer.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(notification["method"], "fixture/partial");
        assert_eq!(
            fs::metadata(home.path().join("config.toml")).unwrap().len(),
            0
        );
        Self {
            client,
            stdin,
            request,
            home,
        }
    }

    async fn release(&self, outcome: &str) {
        self.stdin
            .lock()
            .await
            .write_all(format!("{outcome}\n").as_bytes())
            .await
            .unwrap();
    }

    fn assert_preserved(&self) {
        assert_eq!(
            fs::read_to_string(self.home.path().join("config.toml")).unwrap(),
            CONFIG
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn restart_waits_for_native_partial_config_write_before_killing() {
    let fixture = HeldNativeWrite::start("marketplace/add").await;
    let client = fixture.client.clone();
    let mut restart = Box::pin(client.restart());
    assert!(
        futures_util::poll!(restart.as_mut()).is_pending(),
        "Restart terminated the native writer while config.toml was truncated"
    );
    assert!(
        fixture.client.state.try_lock().is_err(),
        "Admission must stay locked during drain"
    );
    fixture.release("ok").await;
    restart.await;
    fixture.assert_preserved();
    assert!(fixture.request.await.unwrap().is_ok());
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_caller_still_waits_for_native_config_write() {
    let fixture = HeldNativeWrite::start("plugin/list").await;
    fixture.request.abort();
    let client = fixture.client.clone();
    let mut restart = Box::pin(client.restart());
    assert!(futures_util::poll!(restart.as_mut()).is_pending());
    fixture.release("ok").await;
    restart.await;
    fixture.assert_preserved();
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_restart_keeps_native_process_and_environment_registered() {
    let mut fixture = HeldNativeWrite::start("config/batchWrite").await;
    let environment = fixture
        .client
        .state
        .lock()
        .await
        .process_environment
        .clone();
    let client = fixture.client.clone();
    let mut restart = Box::pin(client.restart());
    assert!(futures_util::poll!(restart.as_mut()).is_pending());
    drop(restart);
    {
        let mut state = fixture.client.state.lock().await;
        assert_eq!(state.process_environment, environment);
        assert!(!state.process.as_mut().unwrap().has_exited());
    }
    fixture.release("ok").await;
    assert!((&mut fixture.request).await.unwrap().is_ok());
    fixture.assert_preserved();
    fixture.client.restart().await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_without_an_explicit_error_fails_ordinary_pending_reads() {
    let fixture = HeldNativeWrite::start("config/read").await;
    let mut state = fixture.client.state.lock().await;
    assert!(stop_codex_app_server_process(&mut state, None).await);
    drop(state);
    assert_eq!(
        fixture.request.await.unwrap(),
        Err("codex app-server stopped".to_owned())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn native_error_and_exit_both_release_the_configuration_drain() {
    for outcome in ["error", "exit"] {
        let fixture = HeldNativeWrite::start("marketplace/remove").await;
        let client = fixture.client.clone();
        let restart = tokio::spawn(async move { client.restart().await });
        tokio::task::yield_now().await;
        fixture.release(outcome).await;
        timeout(Duration::from_secs(2), restart)
            .await
            .unwrap()
            .unwrap();
        if outcome == "error" {
            fixture.assert_preserved();
        }
        assert!(fixture.request.await.unwrap().is_err());
    }
}

#[tokio::test]
async fn shutdown_rejects_every_existing_process_admission_path() {
    let client = CodexAppServerClient {
        binary: "must-not-spawn-after-shutdown".to_owned(),
        home: None,
        state: Arc::new(Mutex::new(CodexAppServerSharedState {
            executor_shutdown_requested: true,
            ..CodexAppServerSharedState::default()
        })),
    };
    assert!(matches!(client.prepare_request("plugin/list", 10).await,
        Err(error) if error == CODEX_APP_SERVER_EXECUTOR_SHUTDOWN));
    assert!(matches!(client.ensure_process_with_startup().await,
        Err(error) if error == CODEX_APP_SERVER_EXECUTOR_SHUTDOWN));
    assert!(
        matches!(client.ensure_process_for_launch_config(&CodexLaunchConfig::default()).await,
        Err(error) if error == CODEX_APP_SERVER_EXECUTOR_SHUTDOWN)
    );
    assert!(client.state.lock().await.process.is_none());
}
