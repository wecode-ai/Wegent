// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use wegent_executor::envd::process_service::{
    EnvdPtyManager, EnvdPtyProcess, EnvdPtySpawnRequest, ProcessConfig, ProcessServiceHandler,
    PtyConfig, StartRequest,
};

#[tokio::test]
async fn envd_stores_unix_pty_wrapper_for_process_management() {
    let process: Arc<dyn EnvdPtyProcess> = Arc::new(FakePtyProcess);
    let manager = FakePtyManager {
        process: Arc::clone(&process),
        spawned: Mutex::new(Vec::new()),
    };
    let mut handler = ProcessServiceHandler::new();
    let request = StartRequest {
        process: ProcessConfig {
            cmd: "/bin/sh".to_owned(),
            args: Vec::new(),
            cwd: Some(PathBuf::from("/tmp")),
            envs: HashMap::new(),
        },
        pty: Some(PtyConfig { rows: 24, cols: 80 }),
        tag: None,
    };

    let response = handler.start(request, &manager).await.unwrap();

    assert_eq!(response.pid, process.pid());
    assert!(Arc::ptr_eq(
        handler.manager.processes.get(&process.pid()).unwrap(),
        &process
    ));
    assert!(Arc::ptr_eq(
        handler.manager.pty_processes.get(&process.pid()).unwrap(),
        &process
    ));
    assert_eq!(handler.manager.pty_fds.get(&process.pid()), Some(&56));
    assert_eq!(handler.cleanup_pids, vec![process.pid()]);
    assert_eq!(manager.spawned.lock().unwrap()[0].rows, 24);
    assert_eq!(manager.spawned.lock().unwrap()[0].cols, 80);
}

struct FakePtyProcess;

impl EnvdPtyProcess for FakePtyProcess {
    fn pid(&self) -> u32 {
        1234
    }

    fn fd(&self) -> Option<i32> {
        Some(56)
    }

    fn poll(&self) -> Option<i32> {
        None
    }

    fn resize(&self, _rows: u16, _cols: u16) -> Result<(), String> {
        Ok(())
    }

    fn close(&self) {}
}

struct FakePtyManager {
    process: Arc<dyn EnvdPtyProcess>,
    spawned: Mutex<Vec<EnvdPtySpawnRequest>>,
}

impl EnvdPtyManager for FakePtyManager {
    fn is_available(&self) -> bool {
        true
    }

    fn spawn(&self, request: EnvdPtySpawnRequest) -> Result<Arc<dyn EnvdPtyProcess>, String> {
        self.spawned.lock().unwrap().push(request);
        Ok(Arc::clone(&self.process))
    }
}
