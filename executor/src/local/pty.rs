// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::{Error, ErrorKind, Read, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

#[cfg(unix)]
use std::os::unix::io::RawFd;

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
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;

        Ok(UnixPtyProcess {
            pid: child.process_id().unwrap_or_default(),
            #[cfg(unix)]
            fd: pair.master.as_raw_fd(),
            master: pair.master,
            child,
            reader,
            writer,
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
    child: Box<dyn Child + Send + Sync>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
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

    pub fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reader.read(buffer)
    }

    #[cfg(unix)]
    pub fn read_available(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        let fd = self.fd.ok_or_else(|| {
            Error::new(
                ErrorKind::Unsupported,
                "PTY master file descriptor is not available",
            )
        })?;
        set_nonblocking(fd)?;
        read_available_fd(fd, timeout)
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
        self.child
            .try_wait()
            .map(|status| status.map(|status| status.exit_code()))
    }

    pub fn wait_timeout(&mut self, timeout: Duration) -> std::io::Result<Option<u32>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return Ok(Some(status.exit_code()));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn wait(&mut self) -> std::io::Result<u32> {
        self.child.wait().map(|status| status.exit_code())
    }

    pub fn terminate(&mut self, _force: bool) {
        let _ = self.child.kill();
    }

    pub fn close(&mut self) {
        self.terminate(true);
    }
}

#[cfg(unix)]
fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
fn read_available_fd(fd: RawFd, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
    let mut poll_fd = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    let ready = unsafe { libc::poll(&mut poll_fd, 1, poll_timeout_ms(timeout)) };
    if ready < 0 {
        return Err(Error::last_os_error());
    }
    if ready == 0 {
        return Ok(None);
    }

    let mut buffer = vec![0_u8; 4096];
    let count = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
    if count > 0 {
        buffer.truncate(count as usize);
        return Ok(Some(buffer));
    }
    if count == 0 {
        return Ok(Some(Vec::new()));
    }

    let error = Error::last_os_error();
    match error.raw_os_error() {
        Some(code) if code == libc::EAGAIN || code == libc::EWOULDBLOCK => Ok(None),
        Some(code) if code == libc::EIO => Ok(Some(Vec::new())),
        _ => Err(error),
    }
}

#[cfg(unix)]
fn poll_timeout_ms(timeout: Duration) -> i32 {
    timeout.as_millis().min(i32::MAX as u128) as i32
}
