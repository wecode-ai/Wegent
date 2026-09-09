// SPDX-License-Identifier: Apache-2.0
//! Authenticated loopback transport shared by Windows, macOS and Linux.

use super::{AuthError, NativeAdapter, MAX_FRAME_BYTES};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
};

const MAX_STDOUT_BYTES: u64 = 1024 * 1024;

pub(super) struct AdapterResult {
    pub frame: Option<Value>,
    pub stdout: Vec<u8>,
}

struct AdapterChild {
    child: Child,
    tree: crate::process::ProcessTreeGuard,
    #[cfg(unix)]
    group_id: Option<u32>,
}

impl Drop for AdapterChild {
    fn drop(&mut self) {
        // Terminate descendants before killing the root, which taskkill needs alive.
        self.tree.terminate();
        #[cfg(unix)]
        if let Some(id) = self.group_id {
            // SAFETY: the child was created as leader of its own process group.
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

pub(super) async fn invoke(
    adapter: &NativeAdapter,
    interpreter: &Path,
    arguments: &[String],
    frame: Option<Value>,
    working_directory: Option<&Path>,
    deadline: Duration,
) -> Result<AdapterResult, AuthError> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| AuthError("plugin_auth_transport_unavailable"))?;
    let port = listener
        .local_addr()
        .map_err(|_| AuthError("plugin_auth_transport_unavailable"))?
        .port();
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| AuthError("plugin_auth_transport_unavailable"))?;
    let mut command = Command::new(interpreter);
    let local_configuration = super::local_configuration::capture(
        adapter.definition.local_environment.as_ref(),
        arguments.first().map(String::as_str),
    )?;
    crate::process::hide_windows_console(&mut command);
    command
        .arg(&adapter.script)
        .args(arguments)
        .current_dir(working_directory.unwrap_or(&adapter.root))
        .env_clear()
        .envs(native_environment())
        .env("WEGENT_PLUGIN_AUTH_PORT", port.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(configuration) = local_configuration {
        command.env("WEGENT_PLUGIN_AUTH_LOCAL_CONFIGURATION", configuration);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let spawned = command
        .spawn()
        .map_err(|_| AuthError("plugin_auth_launch_failed"))?;
    let mut child = AdapterChild {
        tree: crate::process::ProcessTreeGuard::new(spawned.id()),
        #[cfg(unix)]
        group_id: spawned.id(),
        child: spawned,
    };
    tokio::time::timeout(deadline, async {
        let mut stdin = child
            .child
            .stdin
            .take()
            .ok_or(AuthError("plugin_auth_transport_unavailable"))?;
        stdin
            .write_all(&nonce)
            .await
            .map_err(|_| AuthError("plugin_auth_transport_unavailable"))?;
        drop(stdin);
        let stdout = child
            .child
            .stdout
            .take()
            .ok_or(AuthError("plugin_auth_transport_unavailable"))?;
        let output = async {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_STDOUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| AuthError("plugin_auth_execution_failed"))?;
            if bytes.len() as u64 > MAX_STDOUT_BYTES {
                return Err(AuthError("plugin_auth_output_too_large"));
            }
            Ok(bytes)
        };
        let transfer = async {
            let mut stream = authenticate(&listener, &nonce).await?;
            if let Some(frame) = frame {
                let bytes = serde_json::to_vec(&frame)
                    .map_err(|_| AuthError("plugin_auth_invalid_credential"))?;
                if bytes.len() > MAX_FRAME_BYTES {
                    return Err(AuthError("plugin_auth_invalid_credential"));
                }
                stream
                    .write_u32(bytes.len() as u32)
                    .await
                    .map_err(|_| AuthError("plugin_auth_transport_failed"))?;
                stream
                    .write_all(&bytes)
                    .await
                    .map_err(|_| AuthError("plugin_auth_transport_failed"))?;
                stream
                    .shutdown()
                    .await
                    .map_err(|_| AuthError("plugin_auth_transport_failed"))?;
                if arguments.first().map(String::as_str) != Some("refresh") {
                    return Ok(None);
                }
            }
            {
                let length = stream
                    .read_u32()
                    .await
                    .map_err(|_| AuthError("plugin_auth_transport_failed"))?
                    as usize;
                if length == 0 || length > MAX_FRAME_BYTES {
                    return Err(AuthError("plugin_auth_invalid_credential"));
                }
                let mut bytes = vec![0; length];
                stream
                    .read_exact(&mut bytes)
                    .await
                    .map_err(|_| AuthError("plugin_auth_transport_failed"))?;
                Ok(Some(serde_json::from_slice(&bytes).map_err(|_| {
                    AuthError("plugin_auth_invalid_credential")
                })?))
            }
        };
        // Keep ownership of the child PID until transfer/output finish. A timed-out
        // grandchild holding stdout must not leave us signalling a recycled PID.
        let (frame, stdout) = tokio::select! {
            result = async { tokio::try_join!(transfer, output) } => result?,
            error = wait_for_failure(&child.child) => return Err(error),
        };
        let status = child
            .child
            .wait()
            .await
            .map_err(|_| AuthError("plugin_auth_execution_failed"))?;
        child.tree.disarm();
        #[cfg(unix)]
        {
            child.group_id = None;
        }
        if !status.success() {
            return Err(AuthError("plugin_auth_execution_failed"));
        }
        Ok(AdapterResult { frame, stdout })
    })
    .await
    .map_err(|_| AuthError("plugin_auth_timeout"))?
}

async fn wait_for_failure(child: &Child) -> AuthError {
    loop {
        match exited_unsuccessfully(child) {
            Ok(false) => tokio::time::sleep(Duration::from_millis(20)).await,
            Ok(true) | Err(_) => return AuthError("plugin_auth_execution_failed"),
        }
    }
}

#[cfg(unix)]
fn exited_unsuccessfully(child: &Child) -> std::io::Result<bool> {
    let pid = child
        .id()
        .ok_or_else(|| std::io::Error::other("child unavailable"))?;
    // SAFETY: waitid writes a siginfo_t for our owned child. WNOWAIT deliberately
    // keeps its PID reserved until private I/O and process-group cleanup finish.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        if libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        ) != 0
        {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(error);
        }
        // A successful child can exit before we drain its buffered private frame.
        Ok(info.si_pid() != 0 && (info.si_code != libc::CLD_EXITED || info.si_status() != 0))
    }
}

#[cfg(windows)]
fn exited_unsuccessfully(child: &Child) -> std::io::Result<bool> {
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{GetExitCodeProcess, WaitForSingleObject},
    };
    let handle = child
        .raw_handle()
        .ok_or_else(|| std::io::Error::other("child unavailable"))?;
    // SAFETY: Child owns this handle throughout the query; neither call closes it.
    unsafe {
        match WaitForSingleObject(handle, 0) {
            WAIT_TIMEOUT => Ok(false),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if GetExitCodeProcess(handle, &mut code) == 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(code != 0)
            }
            _ => Err(std::io::Error::last_os_error()),
        }
    }
}

async fn authenticate(listener: &TcpListener, nonce: &[u8; 32]) -> Result<TcpStream, AuthError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| AuthError("plugin_auth_transport_failed"))?;
        let mut received = [0u8; 32];
        if let Ok(Ok(_)) =
            tokio::time::timeout(Duration::from_secs(1), stream.read_exact(&mut received)).await
        {
            // Compare all bytes; a local unauthenticated connection never gets credentials.
            let difference = received
                .iter()
                .zip(nonce)
                .fold(0u8, |diff, (a, b)| diff | (a ^ b));
            if difference == 0 {
                return Ok(stream);
            }
        }
    }
}

fn native_environment() -> Vec<(String, String)> {
    crate::process_environment::process_env(&[])
        .into_iter()
        .filter(|(key, _)| {
            matches!(
                key.to_ascii_uppercase().as_str(),
                "PATH"
                    | "HOME"
                    | "USERPROFILE"
                    | "APPDATA"
                    | "LOCALAPPDATA"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "TEMP"
                    | "TMP"
                    | "TMPDIR"
                    | "LANG"
                    | "LC_ALL"
                    | "USER"
                    | "LOGNAME"
                    | "DBUS_SESSION_BUS_ADDRESS"
                    | "XDG_RUNTIME_DIR"
                    | "XDG_CONFIG_HOME"
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unauthenticated_connections_receive_no_credentials() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut socket = authenticate(&listener, &[7u8; 32]).await.unwrap();
            socket.write_all(b"private-frame").await.unwrap();
        });
        let mut wrong = TcpStream::connect(address).await.unwrap();
        wrong.write_all(&[0u8; 32]).await.unwrap();
        let mut bytes = [0; 1];
        let count = tokio::time::timeout(Duration::from_secs(2), wrong.read(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 0);
        let mut right = TcpStream::connect(address).await.unwrap();
        right.write_all(&[7u8; 32]).await.unwrap();
        let mut received = Vec::new();
        right.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, b"private-frame");
        server.await.unwrap();
    }
}
