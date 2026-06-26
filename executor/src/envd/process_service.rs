// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, path::PathBuf, sync::Arc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessConfig {
    pub cmd: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub envs: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyConfig {
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    pub process: ProcessConfig,
    pub pty: Option<PtyConfig>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartResponse {
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvdPtySpawnRequest {
    pub cmd: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
}

pub trait EnvdPtyProcess: Send + Sync {
    fn pid(&self) -> u32;
    fn fd(&self) -> Option<i32>;
    fn poll(&self) -> Option<i32>;
    fn resize(&self, rows: u16, cols: u16) -> Result<(), String>;
    fn close(&self);
}

pub trait EnvdPtyManager: Send + Sync {
    fn is_available(&self) -> bool;
    fn spawn(&self, request: EnvdPtySpawnRequest) -> Result<Arc<dyn EnvdPtyProcess>, String>;
}

#[derive(Default)]
pub struct ProcessManager {
    pub processes: HashMap<u32, Arc<dyn EnvdPtyProcess>>,
    pub tagged_processes: HashMap<String, u32>,
    pub pty_processes: HashMap<u32, Arc<dyn EnvdPtyProcess>>,
    pub pty_fds: HashMap<u32, i32>,
}

impl ProcessManager {
    pub fn add_pty_process(
        &mut self,
        pid: u32,
        process: Arc<dyn EnvdPtyProcess>,
        tag: Option<String>,
        pty_fd: i32,
    ) {
        self.processes.insert(pid, Arc::clone(&process));
        self.pty_processes.insert(pid, process);
        self.pty_fds.insert(pid, pty_fd);
        if let Some(tag) = tag {
            self.tagged_processes.insert(tag, pid);
        }
    }
}

#[derive(Default)]
pub struct ProcessServiceHandler {
    pub manager: ProcessManager,
    pub cleanup_pids: Vec<u32>,
}

impl ProcessServiceHandler {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start(
        &mut self,
        request: StartRequest,
        pty_manager: &dyn EnvdPtyManager,
    ) -> Result<StartResponse, String> {
        let pty = request
            .pty
            .ok_or_else(|| "Only PTY start requests are supported by this contract".to_owned())?;
        if !pty_manager.is_available() {
            return Err("PTY mode is not available on this platform".to_owned());
        }

        let mut cmd = Vec::with_capacity(1 + request.process.args.len());
        cmd.push(request.process.cmd);
        cmd.extend(request.process.args);
        let process = pty_manager.spawn(EnvdPtySpawnRequest {
            cmd,
            cwd: request.process.cwd,
            env: request.process.envs,
            rows: pty.rows,
            cols: pty.cols,
        })?;
        let pid = process.pid();
        let pty_fd = process.fd().unwrap_or(-1);
        self.manager
            .add_pty_process(pid, Arc::clone(&process), request.tag, pty_fd);
        self.cleanup_finished_process(pid).await;
        Ok(StartResponse { pid })
    }

    async fn cleanup_finished_process(&mut self, pid: u32) {
        self.cleanup_pids.push(pid);
    }
}
