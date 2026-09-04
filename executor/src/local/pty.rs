// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::{Read, Write},
    path::Path,
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::sync::Notify;

#[cfg(unix)]
use std::os::unix::io::RawFd;

const PTY_READ_BUFFER_SIZE: usize = 8 * 1024;
const PTY_READ_QUEUE_CAPACITY: usize = 64;
const PTY_DESCENDANT_EXIT_GRACE: Duration = Duration::from_millis(100);

pub struct UnixPtyManager;

impl UnixPtyManager {
    pub fn new() -> Self {
        Self
    }

    pub fn is_available(&self) -> bool {
        cfg!(unix)
    }

    pub fn spawn(
        &self,
        argv: &[&str],
        cwd: Option<&Path>,
        env: &[(&str, &str)],
        rows: u16,
        cols: u16,
    ) -> Result<UnixPtyProcess, String> {
        let (program, args) = argv
            .split_first()
            .ok_or_else(|| "pty command argv is empty".to_owned())?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        let mut command = CommandBuilder::new(program);
        for arg in args {
            command.arg(arg);
        }
        if let Some(cwd) = cwd {
            command.cwd(cwd);
        }
        command.env("TERM", "xterm-256color");
        for (key, value) in env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| error.to_string())?;
        let pid = child.process_id().unwrap_or_default();
        let mut killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let (read_tx, read_rx) = mpsc::sync_channel(PTY_READ_QUEUE_CAPACITY);
        let (exit_tx, exit_rx) = mpsc::sync_channel(1);
        let event_signal = Arc::new(PtyEventSignal::default());

        if let Err(error) = spawn_child_watcher(child, exit_tx, Arc::clone(&event_signal), pid) {
            let _ = killer.kill();
            return Err(error);
        }
        if let Err(error) = spawn_reader_thread(reader, read_tx, Arc::clone(&event_signal)) {
            terminate_process_group(pid, true);
            let _ = killer.kill();
            return Err(error);
        }

        Ok(UnixPtyProcess {
            pid,
            #[cfg(unix)]
            fd: pair.master.as_raw_fd(),
            master: pair.master,
            writer,
            killer,
            read_rx,
            exit_rx,
            exit_code: None,
            output_closed: false,
            event_signal,
        })
    }
}

impl Default for UnixPtyManager {
    fn default() -> Self {
        Self::new()
    }
}

pub struct UnixPtyProcess {
    pid: u32,
    #[cfg(unix)]
    fd: Option<RawFd>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    read_rx: Receiver<PtyReadEvent>,
    exit_rx: Receiver<std::io::Result<u32>>,
    exit_code: Option<u32>,
    output_closed: bool,
    event_signal: Arc<PtyEventSignal>,
}

impl UnixPtyProcess {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    #[cfg(unix)]
    pub fn fd(&self) -> Option<RawFd> {
        self.fd
    }

    pub fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let written = self.writer.write(data)?;
        self.writer.flush()?;
        Ok(written)
    }

    pub fn read_available(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        let event = if timeout.is_zero() {
            match self.read_rx.try_recv() {
                Ok(event) => Some(event),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => Some(PtyReadEvent::Eof),
            }
        } else {
            match self.read_rx.recv_timeout(timeout) {
                Ok(event) => Some(event),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => Some(PtyReadEvent::Eof),
            }
        };
        match event {
            Some(PtyReadEvent::Data(data)) => Ok(Some(data)),
            Some(PtyReadEvent::Eof) => {
                self.output_closed = true;
                Ok(Some(Vec::new()))
            }
            Some(PtyReadEvent::Error(error)) => {
                self.output_closed = true;
                Err(error)
            }
            None => Ok(None),
        }
    }

    pub fn set_event_notifier(&mut self, notifier: Arc<Notify>) {
        self.event_signal.set_notifier(notifier);
    }

    pub fn output_closed(&self) -> bool {
        self.output_closed
    }

    pub fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    pub fn poll(&mut self) -> std::io::Result<Option<u32>> {
        if let Some(exit_code) = self.exit_code {
            return Ok(Some(exit_code));
        }
        match self.exit_rx.try_recv() {
            Ok(Ok(exit_code)) => {
                self.exit_code = Some(exit_code);
                Ok(Some(exit_code))
            }
            Ok(Err(error)) => Err(error),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "PTY process watcher stopped before reporting an exit status",
            )),
        }
    }

    pub fn wait_timeout(&mut self, timeout: Duration) -> std::io::Result<Option<u32>> {
        if let Some(exit_code) = self.exit_code {
            return Ok(Some(exit_code));
        }
        match self.exit_rx.recv_timeout(timeout) {
            Ok(Ok(exit_code)) => {
                self.exit_code = Some(exit_code);
                Ok(Some(exit_code))
            }
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "PTY process watcher stopped before reporting an exit status",
            )),
        }
    }

    pub fn wait(&mut self) -> std::io::Result<u32> {
        if let Some(exit_code) = self.exit_code {
            return Ok(exit_code);
        }
        match self.exit_rx.recv() {
            Ok(Ok(exit_code)) => {
                self.exit_code = Some(exit_code);
                Ok(exit_code)
            }
            Ok(Err(error)) => Err(error),
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "PTY process watcher stopped before reporting an exit status",
            )),
        }
    }

    pub fn terminate(&mut self, force: bool) {
        terminate_process_group(self.pid, force);
        let _ = self.killer.kill();
    }

    pub fn close(&mut self) {
        self.terminate(true);
    }
}

#[derive(Default)]
struct PtyEventSignal {
    notifier: Mutex<Option<Arc<Notify>>>,
}

impl PtyEventSignal {
    fn set_notifier(&self, notifier: Arc<Notify>) {
        if let Ok(mut current) = self.notifier.lock() {
            *current = Some(notifier);
        }
    }

    fn notify(&self) {
        if let Ok(notifier) = self.notifier.lock() {
            if let Some(notifier) = notifier.as_ref() {
                notifier.notify_one();
            }
        }
    }
}

enum PtyReadEvent {
    Data(Vec<u8>),
    Eof,
    Error(std::io::Error),
}

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    read_sender: SyncSender<PtyReadEvent>,
    event_signal: Arc<PtyEventSignal>,
) -> Result<(), String> {
    thread::Builder::new()
        .name("wegent-pty-reader".to_owned())
        .spawn(move || {
            let mut buffer = vec![0_u8; PTY_READ_BUFFER_SIZE];
            loop {
                let event = match reader.read(&mut buffer) {
                    Ok(0) => PtyReadEvent::Eof,
                    Ok(count) => PtyReadEvent::Data(buffer[..count].to_vec()),
                    Err(error) if is_pty_eof(&error) => PtyReadEvent::Eof,
                    Err(error) => PtyReadEvent::Error(error),
                };
                let finished = !matches!(event, PtyReadEvent::Data(_));
                if read_sender.send(event).is_err() {
                    break;
                }
                event_signal.notify();
                if finished {
                    break;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start PTY output reader: {error}"))
}

fn spawn_child_watcher(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    exit_sender: SyncSender<std::io::Result<u32>>,
    event_signal: Arc<PtyEventSignal>,
    pid: u32,
) -> Result<(), String> {
    thread::Builder::new()
        .name("wegent-pty-child-watcher".to_owned())
        .spawn(move || {
            let result = child.wait().map(|status| status.exit_code());
            let _ = exit_sender.send(result);
            event_signal.notify();
            terminate_descendants_after_exit(pid);
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start PTY child watcher: {error}"))
}

#[cfg(unix)]
fn terminate_process_group(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    signal_process_group(pid, signal);
}

#[cfg(not(unix))]
fn terminate_process_group(_pid: u32, _force: bool) {}

#[cfg(unix)]
fn terminate_descendants_after_exit(pid: u32) {
    signal_process_group(pid, libc::SIGHUP);
    thread::sleep(PTY_DESCENDANT_EXIT_GRACE);
    signal_process_group(pid, libc::SIGKILL);
}

#[cfg(not(unix))]
fn terminate_descendants_after_exit(_pid: u32) {}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    if pid == 0 {
        return;
    }
    if let Ok(process_group) = i32::try_from(pid) {
        unsafe {
            libc::kill(-process_group, signal);
        }
    }
}

#[cfg(unix)]
fn is_pty_eof(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}

#[cfg(not(unix))]
fn is_pty_eof(_error: &std::io::Error) -> bool {
    false
}
