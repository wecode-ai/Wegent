// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[cfg(unix)]
async fn assert_restart_waits_for_process_exit(mode: &str) {
    use std::os::unix::fs::PermissionsExt;

    let _environment = environment::LaunchEnvironment::new();
    let root = tempfile::tempdir().unwrap();
    let binary = root.path().join("fake-codex");
    std::fs::write(
        &binary,
        r#"#!/bin/sh
printf '%s\n' "$$" > "$0.pid"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
  esac
done
"#,
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let client = CodexAppServerClient::new(binary.to_string_lossy());
    let mut child = spawn_idle_app_server_child();
    let old_pid = child.id().unwrap();
    let stdin = child.stdin.take().unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    client.state.lock().await.process = Some(CodexAppServerProcess {
        child,
        terminating: false,
        termination_error: None,
        termination_task: None,
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        notifications: CodexNotificationHub::new(),
        reader_task: tokio::spawn(async {}),
        teardown_barrier: Some((entered_tx, release_rx)),
    });
    if mode == "stalled" {
        client.mark_thread_active("thread-1").await;
    }
    let restarting_client = client.clone();
    let mode = mode.to_owned();
    let restart = tokio::spawn(async move {
        match mode.as_str() {
            "idle" => restarting_client.restart_if_idle().await.unwrap(),
            "stalled" => assert!(restarting_client
                .restart_stalled_turn_process("thread-1")
                .await
                .unwrap()),
            "proxy" => {
                restarting_client
                    .configure_runtime_proxy_for_restart(Some("http://127.0.0.1:9099"))
                    .await
                    .unwrap();
            }
            "mutation" => {
                restarting_client
                    .mutate_configuration_if_idle(|| async { Ok(((), true)) })
                    .await
                    .unwrap();
            }
            _ => restarting_client.restart().await.unwrap(),
        }
    });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    assert_eq!(
        unsafe { libc::kill(old_pid as i32, 0) },
        0,
        "old child must remain alive at the teardown barrier"
    );
    let requesting_client = client.clone();
    let request = tokio::spawn(async move {
        requesting_client
            .ensure_process_for_launch_config(&CodexLaunchConfig::default())
            .await
    });
    let marker = PathBuf::from(format!("{}.pid", binary.display()));
    let admitted_while_old_alive = timeout(Duration::from_secs(3), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .is_ok();
    release_tx.send(()).unwrap();
    restart.await.unwrap();
    request.await.unwrap().unwrap();
    let new_pid = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .child
        .id()
        .unwrap();
    let old_child_exited = unsafe { libc::kill(old_pid as i32, 0) } != 0;
    client.restart().await.unwrap();
    eprintln!(
        "controlled teardown old_pid={old_pid} new_pid={new_pid} old_exited={old_child_exited}"
    );
    assert_ne!(new_pid, old_pid);
    assert!(
        !admitted_while_old_alive,
        "replacement app-server was admitted before old child teardown completed"
    );
    assert!(
        old_child_exited,
        "restart returned before the old child was reaped"
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn forced_restart_waits_for_old_process_exit_before_admission() {
    assert_restart_waits_for_process_exit("forced").await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_restart_waits_for_old_process_exit_before_admission() {
    assert_restart_waits_for_process_exit("idle").await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_restart_waits_for_old_process_exit_before_admission() {
    assert_restart_waits_for_process_exit("stalled").await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_restart_waits_for_old_process_exit_before_admission() {
    assert_restart_waits_for_process_exit("proxy").await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutation_restart_waits_for_old_process_exit_before_admission() {
    assert_restart_waits_for_process_exit("mutation").await;
}

async fn install_idle_process(client: &CodexAppServerClient, terminating: bool) -> u32 {
    let mut child = spawn_idle_app_server_child();
    let pid = child.id().unwrap();
    let stdin = child.stdin.take().unwrap();
    client.state.lock().await.process = Some(CodexAppServerProcess {
        child,
        terminating,
        termination_error: None,
        termination_task: None,
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        notifications: CodexNotificationHub::new(),
        reader_task: tokio::spawn(async {}),
        teardown_barrier: None,
    });
    pid
}

#[tokio::test]
async fn termination_tool_failure_accepts_a_confirmed_exited_child() {
    let mut child = spawn_idle_app_server_child();
    signal_controlled_child(child.id().unwrap()).unwrap();
    child.wait().await.unwrap();
    let mut task = Some(tokio::spawn(async {
        Err("taskkill failed with controlled exit status".to_owned())
    }));
    assert_eq!(
        finish_codex_app_server_termination(&mut child, &mut task).await,
        Ok(())
    );
    assert!(task.is_none());
}

#[tokio::test]
async fn termination_tool_failure_rejects_a_still_running_child() {
    let mut child = spawn_idle_app_server_child();
    let error = "taskkill failed with controlled exit status".to_owned();
    let task_error = error.clone();
    let mut task = Some(tokio::spawn(async move { Err(task_error) }));
    let result = finish_codex_app_server_termination(&mut child, &mut task).await;
    let still_running = matches!(child.try_wait(), Ok(None));
    signal_controlled_child(child.id().unwrap()).unwrap();
    child.wait().await.unwrap();
    assert_eq!(result, Err(error));
    assert!(still_running);
    assert!(task.is_none());
}

pub(in crate::agents::codex) fn signal_controlled_child(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as i32), libc::SIGKILL) == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().to_string())
        }
    }
    #[cfg(windows)]
    {
        crate::process::kill_windows_process_tree(pid)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_teardown_retains_old_process_until_exit() {
    let client = CodexAppServerClient::new("codex-cancelled-teardown-test");
    let pid = install_idle_process(&client, false).await;
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    client
        .state
        .lock()
        .await
        .process
        .as_mut()
        .unwrap()
        .teardown_barrier = Some((entered_tx, release_rx));
    let retiring_client = client.clone();
    let teardown = tokio::spawn(async move { retiring_client.restart().await });
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    teardown.abort();
    assert!(teardown.await.unwrap_err().is_cancelled());
    let old_child_still_alive = {
        let mut state = client.state.lock().await;
        let process = state.process.as_mut().unwrap();
        process.terminating
            && process.child.id() == Some(pid)
            && process.child.try_wait().unwrap().is_none()
    };
    let requesting_client = client.clone();
    let mut admission = tokio::spawn(async move { requesting_client.existing_process().await });
    let admitted_before_exit = timeout(Duration::from_millis(50), &mut admission)
        .await
        .is_ok();
    release_tx.send(()).unwrap();
    let outcome = if admitted_before_exit {
        None
    } else {
        Some(admission.await.unwrap())
    };
    assert!(old_child_still_alive);
    assert!(
        !admitted_before_exit,
        "a cancelled teardown must not expose the old handle"
    );
    assert!(matches!(outcome, Some(Err(error)) if error == "codex app-server is not running"));
    assert!(client.state.lock().await.process.is_none());
}

#[tokio::test]
async fn teardown_failure_propagates_without_admitting_a_replacement() {
    let client = CodexAppServerClient::new("codex-teardown-failure-test");
    let pid = install_idle_process(&client, true).await;
    let error = "failed to wait for codex app-server exit: controlled wait failure".to_owned();
    client
        .state
        .lock()
        .await
        .process
        .as_mut()
        .unwrap()
        .termination_error = Some(error.clone());
    assert_eq!(client.restart().await, Err(error.clone()));
    assert_eq!(
        client.restart_if_idle().await,
        Err(CodexIdleMutationError::Update(error.clone()))
    );
    assert!(
        matches!(client.ensure_process_for_launch_config(&CodexLaunchConfig::default()).await, Err(message) if message == error)
    );
    assert!(matches!(client.existing_process().await, Err(message) if message == error));
    {
        let mut state = client.state.lock().await;
        let process = state.process.as_mut().unwrap();
        assert_eq!(process.child.id(), Some(pid));
        assert!(process.child.try_wait().unwrap().is_none());
        signal_codex_app_server_child(&mut process.child);
        process.child.wait().await.unwrap();
    }
    client.restart().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_teardown_preserves_failed_kill_result_for_admission() {
    let client = CodexAppServerClient::new("codex-cancelled-kill-failure-test");
    let pid = install_idle_process(&client, true).await;
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let error = "taskkill failed with controlled exit status".to_owned();
    let kill_error = error.clone();
    client
        .state
        .lock()
        .await
        .process
        .as_mut()
        .unwrap()
        .termination_task = Some(tokio::task::spawn_blocking(move || {
        entered_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        Err(kill_error)
    }));
    let retiring_client = client.clone();
    let (started_tx, started_rx) = oneshot::channel();
    let teardown = tokio::spawn(async move {
        started_tx.send(()).unwrap();
        retiring_client.restart().await
    });
    started_rx.await.unwrap();
    tokio::task::spawn_blocking(move || entered_rx.recv().unwrap())
        .await
        .unwrap();
    teardown.abort();
    assert!(teardown.await.unwrap_err().is_cancelled());
    release_tx.send(()).unwrap();
    let outcome = timeout(
        Duration::from_secs(1),
        client.ensure_process_for_launch_config(&CodexLaunchConfig::default()),
    )
    .await;
    assert!(
        matches!(outcome, Ok(Err(message)) if message == error),
        "kill failure must propagate rather than wait indefinitely or spawn a replacement"
    );
    assert_eq!(
        client.restart_if_idle().await,
        Err(CodexIdleMutationError::Update(error))
    );
    {
        let mut state = client.state.lock().await;
        let process = state.process.as_mut().unwrap();
        assert_eq!(process.child.id(), Some(pid));
        assert!(process.child.try_wait().unwrap().is_none());
        signal_codex_app_server_child(&mut process.child);
        process.child.wait().await.unwrap();
    }
    client.restart().await.unwrap();
}
