//! Stable supervisor. It never loads code or opens data from the selected release.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn read(path: impl AsRef<Path>) -> io::Result<String> {
    Ok(fs::read_to_string(path)?.trim_end().to_owned())
}

fn release_id(value: &str) -> io::Result<&str> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        || value == "."
        || value == ".."
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid release identifier",
        ));
    }
    Ok(value)
}

fn run() -> io::Result<()> {
    let mut args = env::args_os().skip(1);
    let root = PathBuf::from(
        args.next()
            .ok_or_else(|| io::Error::other("Missing release root"))?,
    );
    let bridge = args
        .next()
        .ok_or_else(|| io::Error::other("Missing recovery executable"))?;
    let forwarded: Vec<_> = args.collect();
    let id = read(root.join("active"))?;
    let slot = root.join("slots").join(release_id(&id)?);
    let executable = read(slot.join("executable"))?;
    let trial = read(root.join("trial")).ok();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("supervisor.lock"))?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    if let Some(token) = &trial {
        release_id(token)?;
        fs::write(root.join("attempted"), token)?;
    }
    let spawned = Command::new(&executable)
        .args(&forwarded)
        .env("WEWORK_RELEASE_SUPERVISED", &id)
        .env("WEWORK_RELEASE_ROOT", &root)
        .stdin(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            if let Some(token) = &trial {
                fs::write(root.join("failed"), token)?;
                Command::new(&bridge)
                    .args(&forwarded)
                    .env_remove("WEWORK_RELEASE_SUPERVISED")
                    .env("WEWORK_RELEASE_ROOT", &root)
                    .stdin(Stdio::null())
                    .spawn()?;
                return Ok(());
            }
            return Err(error);
        }
    };
    fs::write(root.join("active-pid"), child.id().to_string())?;
    // Only an activation is time bounded. A healthy ordinary launch is not an update trial.
    let Some(token) = trial else { return Ok(()) };
    release_id(&token)?;
    let started = Instant::now();
    loop {
        if read(root.join("healthy")).ok().as_deref() == Some(&token) {
            return Ok(());
        }
        let exited = child.try_wait()?.is_some();
        if exited || started.elapsed() >= Duration::from_secs(60) {
            if !exited {
                child.kill()?;
                child.wait()?;
            }
            // Recovery and any data restore run in the stable installed shell, not the failed app.
            fs::write(root.join("failed"), &token)?;
            Command::new(&bridge)
                .args(&forwarded)
                .env_remove("WEWORK_RELEASE_SUPERVISED")
                .env("WEWORK_RELEASE_ROOT", &root)
                .env("WEWORK_RELEASE_RECOVERY", &token)
                .stdin(Stdio::null())
                .spawn()?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Wework launcher: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_paths_and_line_injection() {
        for id in ["", "..", "../host", "a/b", "a\\b", "a\nb"] {
            assert!(release_id(id).is_err());
        }
        assert!(release_id("0.5.14-beta.1-1234").is_ok());
    }
}
