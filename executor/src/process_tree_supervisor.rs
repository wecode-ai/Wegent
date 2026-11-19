//! Own an isolated Windows process tree before its first instruction runs.
use std::{ffi::OsString, io};

pub async fn run(arguments: Vec<OsString>) -> io::Result<i32> {
    let Some((token, command)) = arguments.split_first() else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing control token",
        ));
    };
    let token = token
        .to_str()
        .filter(|value| {
            value.len() == 36
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Invalid control token"))?;
    if command.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Missing owned program",
        ));
    }
    #[cfg(windows)]
    return run_windows(token, command).await;
    #[cfg(not(windows))]
    {
        let _ = token;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Process job supervision requires Windows",
        ))
    }
}

#[cfg(windows)]
async fn run_windows(token: &str, arguments: &[OsString]) -> io::Result<i32> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::{process::Stdio, time::Duration};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, BufReader},
        process::Command,
    };
    use wegent_subprocess::ProcessTreeGuard;

    let mut command = Command::new(&arguments[0]);
    command
        .args(&arguments[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped());
    let mut tree = ProcessTreeGuard::prepare_child(&mut command)?;
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| io::Error::other("Owned child has no PID"))?;
    // Emit the identity while the child is suspended; its output cannot spoof this first frame.
    eprintln!("wework-process-tree {token} started {pid}");
    if let Err(error) = tree.attach_child(&child) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(error);
    }
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("Missing owned stderr"))?;
    let output_token = token.to_owned();
    let output = tokio::spawn(async move {
        let mut buffer = [0_u8; 8192];
        loop {
            let size = stderr.read(&mut buffer).await?;
            if size == 0 {
                return Ok::<(), io::Error>(());
            }
            eprintln!(
                "wework-process-tree {} app-stderr {}",
                output_token,
                STANDARD.encode(&buffer[..size])
            );
        }
    });
    let mut input = BufReader::new(tokio::io::stdin()).lines();
    let status = tokio::select! {
        status = child.wait() => Some(status?),
        line = input.next_line() => {
            if line?.as_deref().is_some_and(|line| line != "stop") {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid supervisor control"));
            }
            None
        }
    };
    // A parent exit is insufficient. Job membership includes children created during shutdown.
    tree.terminate_and_wait(Duration::from_secs(10))?;
    let status = match status {
        Some(status) => status,
        None => child.wait().await?,
    };
    output.await.map_err(io::Error::other)??;
    let code = status.code().unwrap_or(1);
    eprintln!("wework-process-tree {token} stopped {pid} {code} 0");
    Ok(0)
}

#[cfg(all(test, windows))]
mod tests {
    use std::{process::Stdio, time::Duration};
    use tokio::process::Command;
    use wegent_subprocess::ProcessTreeGuard;

    #[tokio::test]
    async fn windows_job_retains_descendants_after_the_parent_exits() -> std::io::Result<()> {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/C", "start /B ping.exe -t 127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut tree = ProcessTreeGuard::prepare_child(&mut command)?;
        let mut child = command.spawn()?;
        tree.attach_child(&child)?;
        let status = tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .map_err(|_| std::io::Error::other("Owned fixture parent did not exit"))??;
        assert!(status.success());
        assert!(
            tree.active_processes()? > 0,
            "Parent exit must not certify tree exit"
        );
        tree.terminate_and_wait(Duration::from_secs(10))?;
        Ok(())
    }
}
