//! Real Node service pipe + native OS lock, without a model or external provider.
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Service(Child);

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn launch(lock: &Path) -> Service {
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../wework/dsh/connection-host/remote-lifecycle.js");
    let script = format!(
        "import {{pathToFileURL}} from 'node:url';\
         const {{acquireRemoteConnectionLock,watchRemoteConnectionParent}} = await import(pathToFileURL({module}));\
         watchRemoteConnectionParent();\
         await acquireRemoteConnectionLock({executor},{lock});\
         console.log('owner-ready');",
        module = serde_json::to_string(&module).unwrap(),
        executor = serde_json::to_string(env!("CARGO_BIN_EXE_wegent-executor")).unwrap(),
        lock = serde_json::to_string(lock).unwrap(),
    );
    Service(
        Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node is required by the shipped DSH connection service"),
    )
}

fn line(service: &mut Service) -> String {
    let stdout = service.0.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        let _ = sender.send(line);
    });
    let line = receiver.recv_timeout(Duration::from_secs(10)).unwrap();
    reader.join().unwrap();
    line
}

fn ready(service: &mut Service) {
    assert_eq!(line(service).trim(), "owner-ready");
}

#[test]
fn one_owner_cannot_prepare_while_its_service_runs_and_parent_eof_releases_it() {
    let root = tempfile::tempdir().unwrap();
    let lock = root.path().join("7/.connection-service.lock");
    let mut first = launch(&lock);
    ready(&mut first);
    let mut rejected = launch(&lock);
    assert_eq!(line(&mut rejected), "");
    assert!(!rejected.0.wait().unwrap().success());
    let mut diagnostic = String::new();
    rejected
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostic)
        .unwrap();
    assert!(diagnostic.contains("owner lock is unavailable"));
    drop(first.0.stdin.take());
    assert!(first.0.wait().unwrap().success());
    let mut restarted = launch(&lock);
    ready(&mut restarted);
    assert!(lock.is_file());
    let mut other = launch(&root.path().join("8/.connection-service.lock"));
    ready(&mut other);
}

#[test]
fn abrupt_service_death_cannot_leave_a_stale_owner_lock() {
    let root = tempfile::tempdir().unwrap();
    let lock = root.path().join("7/.connection-service.lock");
    let mut service = launch(&lock);
    ready(&mut service);
    service.0.kill().unwrap();
    service.0.wait().unwrap();
    // Native releases its OS lock after seeing the dead service pipe close.
    let mut command = Command::new(env!("CARGO_BIN_EXE_wegent-executor"));
    command
        .args([
            "--workbench-lock",
            &serde_json::to_string(&[&lock]).unwrap(),
            "--workbench-lock-wait",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut recovered = Service(command.spawn().unwrap());
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&line(&mut recovered)).unwrap()["locked"],
        true
    );
    drop(recovered);
    assert!(lock.is_file());
}
