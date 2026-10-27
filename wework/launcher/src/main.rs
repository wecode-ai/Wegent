//! Stable supervisor. It never loads code or opens data from the selected release.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::{
    env,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn recover(root: &Path, bridge: &OsStr, forwarded: &[OsString], token: &str) -> io::Result<()> {
    fs::write(root.join("failed"), token)?;
    let child = Command::new(bridge)
        .args(forwarded)
        .env_remove("WEWORK_RELEASE_SUPERVISED")
        .env("WEWORK_RELEASE_ROOT", root)
        .env("WEWORK_RELEASE_RECOVERY", token)
        .stdin(Stdio::null())
        .spawn()?;
    fs::write(root.join("recovery-pid"), child.id().to_string())?;
    Ok(())
}

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
    launch(&root, &bridge, &forwarded)
}

fn launch(root: &Path, bridge: &OsStr, forwarded: &[OsString]) -> io::Result<()> {
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
        // Acquiring the supervisor lock proves no live trial owns this token.
        // A prior unfinished attempt therefore needs recovery, never a retry.
        if read(root.join("attempted")).ok().as_deref() == Some(token)
            && read(root.join("healthy")).ok().as_deref() != Some(token)
        {
            return recover(&root, &bridge, &forwarded, token);
        }
        fs::write(root.join("attempted"), token)?;
    }
    let spawned = Command::new(&executable)
        .args(forwarded)
        .env("WEWORK_RELEASE_SUPERVISED", &id)
        .env("WEWORK_RELEASE_ROOT", &root)
        .stdin(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            if let Some(token) = &trial {
                return recover(&root, &bridge, &forwarded, token);
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
            // Data restoration belongs to the latest healthy shell.
            return recover(&root, &bridge, &forwarded, &token);
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn fixture() -> PathBuf {
        let root = env::temp_dir().join(format!(
            "wework-launcher-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("slots/target")).unwrap();
        fs::write(root.join("active"), "target").unwrap();
        fs::write(
            root.join("slots/target/executable"),
            "must-not-launch-target",
        )
        .unwrap();
        fs::write(root.join("trial"), "trial-token").unwrap();
        fs::write(root.join("attempted"), "trial-token").unwrap();
        root
    }

    #[test]
    fn an_interrupted_trial_recovers_without_restarting_the_target() {
        let root = fixture();
        // The test harness is a real executable that exits without opening a GUI.
        launch(
            &root,
            env::current_exe().unwrap().as_os_str(),
            &[OsString::from("--list")],
        )
        .unwrap();
        assert_eq!(read(root.join("failed")).unwrap(), "trial-token");
        assert!(read(root.join("recovery-pid"))
            .unwrap()
            .parse::<u32>()
            .is_ok());
        assert!(!root.join("active-pid").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_live_supervisor_keeps_ownership_of_its_trial() {
        let root = fixture();
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join("supervisor.lock"))
            .unwrap();
        lock.try_lock().unwrap();
        launch(&root, OsStr::new("must-not-launch-recovery"), &[]).unwrap();
        assert!(!root.join("failed").exists());
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_paths_and_line_injection() {
        for id in ["", "..", "../host", "a/b", "a\\b", "a\nb"] {
            assert!(release_id(id).is_err());
        }
        assert!(release_id("0.5.14-beta.1-1234").is_ok());
    }
}
