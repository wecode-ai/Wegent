// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus},
    sync::mpsc,
    thread,
    time::Duration,
};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

const DEBOUNCE_DELAY: Duration = Duration::from_millis(350);
const EXIT_RESTART_DELAY: Duration = Duration::from_secs(1);

enum DevEvent {
    FileChanged,
    Shutdown,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("wegent-executor dev reload failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest_path = manifest_dir.join("Cargo.toml");
    let executor_args = env::args().skip(1).collect::<Vec<_>>();
    let (tx, rx) = mpsc::channel::<DevEvent>();
    let _watcher = watch_executor_sources(&manifest_dir, tx.clone())?;
    install_shutdown_handler(tx)?;

    eprintln!(
        "wegent-executor dev reload watching {}",
        manifest_dir.display()
    );

    let mut child: Option<Child> = None;
    let mut restart_requested = true;

    loop {
        if restart_requested {
            stop_child(&mut child);
            child = rebuild_and_spawn(&manifest_dir, &manifest_path, &executor_args)?;
            restart_requested = false;
        }

        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(DevEvent::FileChanged) => {
                if drain_debounced_events(&rx) {
                    stop_child(&mut child);
                    return Ok(());
                }
                eprintln!("executor source changed; restarting");
                restart_requested = true;
            }
            Ok(DevEvent::Shutdown) => {
                stop_child(&mut child);
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stop_child(&mut child);
                return Err("dev reload event channel disconnected".to_owned());
            }
        }

        if child_exited(&mut child)? {
            thread::sleep(EXIT_RESTART_DELAY);
            restart_requested = true;
        }
    }
}

fn watch_executor_sources(
    manifest_dir: &Path,
    tx: mpsc::Sender<DevEvent>,
) -> Result<RecommendedWatcher, String> {
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            if let Ok(event) = event {
                if is_reload_event(&event) {
                    let _ = tx.send(DevEvent::FileChanged);
                }
            }
        },
        Config::default(),
    )
    .map_err(|error| error.to_string())?;

    watch_path(
        &mut watcher,
        &manifest_dir.join("src"),
        RecursiveMode::Recursive,
    )?;
    watch_path(
        &mut watcher,
        &manifest_dir.join("Cargo.toml"),
        RecursiveMode::NonRecursive,
    )?;
    watch_path(
        &mut watcher,
        &manifest_dir.join("Cargo.lock"),
        RecursiveMode::NonRecursive,
    )?;
    Ok(watcher)
}

fn watch_path(
    watcher: &mut RecommendedWatcher,
    path: &Path,
    mode: RecursiveMode,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    watcher
        .watch(path, mode)
        .map_err(|error| format!("failed to watch {}: {error}", path.display()))
}

fn install_shutdown_handler(tx: mpsc::Sender<DevEvent>) -> Result<(), String> {
    ctrlc::set_handler(move || {
        let _ = tx.send(DevEvent::Shutdown);
    })
    .map_err(|error| error.to_string())
}

fn rebuild_and_spawn(
    manifest_dir: &Path,
    manifest_path: &Path,
    executor_args: &[String],
) -> Result<Option<Child>, String> {
    if !build_executor(manifest_path)? {
        eprintln!("executor build failed; waiting for the next source change");
        return Ok(None);
    }

    let binary = debug_binary_path(manifest_dir);
    let child = Command::new(&binary)
        .args(executor_args)
        .current_dir(manifest_dir)
        .spawn()
        .map_err(|error| format!("failed to start {}: {error}", binary.display()))?;
    Ok(Some(child))
}

fn build_executor(manifest_path: &Path) -> Result<bool, String> {
    let status = Command::new("cargo")
        .arg("build")
        .arg("--manifest-path")
        .arg(manifest_path)
        .arg("--bin")
        .arg("wegent-executor")
        .status()
        .map_err(|error| format!("failed to run cargo build: {error}"))?;
    Ok(status.success())
}

fn debug_binary_path(manifest_dir: &Path) -> PathBuf {
    let executable = if cfg!(windows) {
        "wegent-executor.exe"
    } else {
        "wegent-executor"
    };
    manifest_dir.join("target").join("debug").join(executable)
}

fn stop_child(child: &mut Option<Child>) {
    let Some(mut process) = child.take() else {
        return;
    };
    let _ = process.kill();
    let _ = process.wait();
}

fn child_exited(child: &mut Option<Child>) -> Result<bool, String> {
    let Some(process) = child.as_mut() else {
        return Ok(false);
    };
    match process.try_wait() {
        Ok(Some(status)) => {
            report_exit(status);
            *child = None;
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(error) => Err(format!("failed to inspect executor process: {error}")),
    }
}

fn report_exit(status: ExitStatus) {
    if status.success() {
        eprintln!("executor exited; restarting");
    } else {
        eprintln!("executor exited with {status}; restarting");
    }
}

fn drain_debounced_events(rx: &mpsc::Receiver<DevEvent>) -> bool {
    thread::sleep(DEBOUNCE_DELAY);
    while let Ok(event) = rx.try_recv() {
        match event {
            DevEvent::FileChanged => {}
            DevEvent::Shutdown => return true,
        }
    }
    false
}

fn is_reload_event(event: &Event) -> bool {
    !matches!(event.kind, EventKind::Access(_))
}
