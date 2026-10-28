//! Stable supervisor. It never loads code or opens data from the selected release.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::{
    env,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

#[cfg(unix)]
fn signal(pid: u32, value: i32) -> io::Result<()> {
    // ESRCH means the process exited before the signal; permission errors are fatal.
    if unsafe { kill(pid as i32, value) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(3) {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn process_table() -> io::Result<Vec<(u32, u32, String)>> {
    let output = Command::new("ps")
        .args(["-axo", "pid=,ppid=,stat="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            "Cannot inspect the supervised process tree",
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| {
            let values: Vec<_> = line.split_whitespace().collect();
            let invalid = || io::Error::other("Invalid process table entry");
            Ok((
                values
                    .first()
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                values
                    .get(1)
                    .ok_or_else(invalid)?
                    .parse()
                    .map_err(|_| invalid())?,
                values.get(2).ok_or_else(invalid)?.to_string(),
            ))
        })
        .collect()
}

fn terminate_runtime_tree(child: &mut Child) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .status()?;
        if !status.success() {
            return Err(io::Error::other("Cannot stop the supervised process tree"));
        }
    }
    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        const STOP: i32 = 17;
        #[cfg(not(target_os = "macos"))]
        const STOP: i32 = 19;
        let mut pids = vec![child.id()];
        signal(child.id(), STOP)?;
        // Runtimes own separate process groups. Follow parent identities and freeze
        // every discovered writer before stopping it, so no new children can escape.
        loop {
            let table = process_table()?;
            let added: Vec<_> = table
                .iter()
                .filter_map(|(pid, parent, _)| {
                    (pids.contains(parent) && !pids.contains(pid)).then_some(*pid)
                })
                .collect();
            if added.is_empty() {
                break;
            }
            for pid in added {
                signal(pid, STOP)?;
                pids.push(pid);
            }
        }
        for pid in pids.iter().rev() {
            signal(*pid, 9)?;
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let live = process_table()?
                .iter()
                .any(|(pid, _, state)| pids.contains(pid) && !state.starts_with('Z'));
            if !live {
                break;
            }
            if Instant::now() >= deadline {
                return Err(io::Error::other("Supervised writers are still running"));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    child.wait()?;
    Ok(())
}

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
                terminate_runtime_tree(&mut child)?;
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

    #[test]
    fn stops_writers_including_descendants_with_independent_process_groups() {
        let root = fixture();
        let mut command = Command::new(env::current_exe().unwrap());
        command
            .args(["--ignored", "--exact", "tests::runtime_tree_fixture"])
            .env("WEWORK_LAUNCHER_TREE_TEST_ROOT", &root)
            .env("WEWORK_LAUNCHER_TREE_TEST_ROLE", "root");
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("leaf-writes").exists() {
            assert!(Instant::now() < deadline, "Descendant did not start");
            thread::sleep(Duration::from_millis(20));
        }
        terminate_runtime_tree(&mut child).unwrap();
        let paths: Vec<_> = ["root", "branch", "leaf"]
            .iter()
            .map(|role| root.join(format!("{role}-writes")))
            .collect();
        let stopped: Vec<_> = paths.iter().map(|path| read(path).unwrap()).collect();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(
            stopped,
            paths
                .iter()
                .map(|path| read(path).unwrap())
                .collect::<Vec<_>>()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Subprocess fixture invoked by the process tree test"]
    fn runtime_tree_fixture() {
        let root = PathBuf::from(env::var_os("WEWORK_LAUNCHER_TREE_TEST_ROOT").unwrap());
        let role = env::var("WEWORK_LAUNCHER_TREE_TEST_ROLE").unwrap();
        if role != "leaf" {
            let mut command = Command::new(env::current_exe().unwrap());
            command
                .args(["--ignored", "--exact", "tests::runtime_tree_fixture"])
                .env(
                    "WEWORK_LAUNCHER_TREE_TEST_ROLE",
                    if role == "root" { "branch" } else { "leaf" },
                );
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            command.spawn().unwrap();
        }
        // Bound fixture lifetime even if the parent assertion fails.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut count = 0;
        while Instant::now() < deadline {
            fs::write(root.join(format!("{role}-writes")), count.to_string()).unwrap();
            count += 1;
            thread::sleep(Duration::from_millis(10));
        }
    }
}
