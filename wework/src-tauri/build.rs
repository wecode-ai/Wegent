use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SIDECAR_NAME: &str = "wegent-executor";
const SIDECAR_ENV: &str = "WEWORK_EXECUTOR_SIDECAR";

fn main() {
    prepare_local_executor_sidecar();
    verify_bundled_codex_binary();
    ensure_codex_resource_glob_exists();
    tauri_build::build()
}

fn prepare_local_executor_sidecar() {
    println!("cargo:rerun-if-env-changed={SIDECAR_ENV}");

    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set by Cargo"),
    );
    let target = env::var("TARGET").expect("TARGET must be set by Cargo");
    let sidecar_path = manifest_dir
        .join("binaries")
        .join(sidecar_file_name(&target));
    let marker_path = sidecar_path.with_extension("debug-stub");

    fs::create_dir_all(
        sidecar_path
            .parent()
            .expect("sidecar path must have parent"),
    )
    .expect("failed to create Tauri sidecar directory");

    if let Some(source) = configured_sidecar_source() {
        copy_sidecar(&source, &sidecar_path);
        remove_debug_marker(&marker_path);
        return;
    }

    let default_source = default_executor_dist_path(&manifest_dir, &target);
    println!("cargo:rerun-if-changed={}", default_source.display());
    if default_source.exists() {
        copy_sidecar(&default_source, &sidecar_path);
        remove_debug_marker(&marker_path);
        return;
    }

    if env::var("PROFILE").as_deref() == Ok("release") {
        if sidecar_path.exists() && !marker_path.exists() {
            println!(
                "cargo:warning=Using preexisting Tauri sidecar at {}",
                sidecar_path.display()
            );
            return;
        }
        panic!(
            "Missing local executor sidecar. Build executor/dist/{default_name} or set {SIDECAR_ENV} before creating a release app bundle.",
            default_name = default_executor_file_name(&target)
        );
    }

    if !sidecar_path.exists() || marker_path.exists() {
        build_debug_stub(&sidecar_path, &marker_path, &target);
    }
}

fn verify_bundled_codex_binary() {
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile != "release" {
        return;
    }

    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set by Cargo"),
    );
    let target = env::var("TARGET").expect("TARGET must be set by Cargo");
    let Some(binary_relative_path) = codex_binary_relative_path(&target) else {
        println!("cargo:warning=No bundled Codex binary target mapping for {target}");
        return;
    };
    let binary_path = manifest_dir
        .join("binaries")
        .join("codex")
        .join(&target)
        .join(binary_relative_path);
    println!("cargo:rerun-if-changed={}", binary_path.display());
    if !binary_path.is_file() {
        panic!(
            "Missing bundled Codex binary for {target}: {}. Run `pnpm --filter wework run prepare:codex` with WEWORK_CODEX_TARGET={target} before creating a release app bundle.",
            binary_path.display()
        );
    }
    let code_mode_host_path = binary_path
        .parent()
        .expect("Codex binary path must have a parent")
        .join(if target.contains("windows") {
            "codex-code-mode-host.exe"
        } else {
            "codex-code-mode-host"
        });
    println!("cargo:rerun-if-changed={}", code_mode_host_path.display());
    if !code_mode_host_path.is_file() {
        panic!(
            "Missing bundled Codex code-mode host for {target}: {}. Run `pnpm --filter wework run prepare:codex` with WEWORK_CODEX_TARGET={target} before creating a release app bundle.",
            code_mode_host_path.display()
        );
    }
}

fn codex_binary_relative_path(target: &str) -> Option<&'static str> {
    match target {
        "aarch64-apple-darwin" => Some("vendor/aarch64-apple-darwin/bin/codex"),
        "x86_64-apple-darwin" => Some("vendor/x86_64-apple-darwin/bin/codex"),
        "x86_64-unknown-linux-gnu" => Some("vendor/x86_64-unknown-linux-musl/bin/codex"),
        "aarch64-unknown-linux-gnu" => Some("vendor/aarch64-unknown-linux-musl/bin/codex"),
        "x86_64-pc-windows-msvc" => Some("vendor/x86_64-pc-windows-msvc/bin/codex.exe"),
        _ => None,
    }
}

fn ensure_codex_resource_glob_exists() {
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be set by Cargo"),
    );
    let codex_dir = manifest_dir.join("binaries").join("codex");
    if directory_contains_file(&codex_dir) {
        return;
    }
    fs::create_dir_all(&codex_dir).expect("failed to create Codex resource placeholder directory");
    fs::write(
        codex_dir.join(".resource-placeholder"),
        b"Generated only so Tauri resource globs resolve in non-release builds.\n",
    )
    .expect("failed to write Codex resource placeholder");
}

fn directory_contains_file(path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() || (path.is_dir() && directory_contains_file(&path)) {
            return true;
        }
    }
    false
}

fn configured_sidecar_source() -> Option<PathBuf> {
    env::var_os(SIDECAR_ENV)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn default_executor_dist_path(manifest_dir: &Path, target: &str) -> PathBuf {
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("src-tauri must be inside the wework directory")
        .join("executor")
        .join("dist")
        .join(default_executor_file_name(target))
}

fn sidecar_file_name(target: &str) -> String {
    if target.contains("windows") {
        format!("{SIDECAR_NAME}-{target}.exe")
    } else {
        format!("{SIDECAR_NAME}-{target}")
    }
}

fn default_executor_file_name(target: &str) -> &'static str {
    if target.contains("windows") {
        "wegent-executor.exe"
    } else {
        "wegent-executor"
    }
}

fn copy_sidecar(source: &Path, destination: &Path) {
    if !source.exists() {
        panic!(
            "Configured local executor sidecar does not exist: {}",
            source.display()
        );
    }
    if source != destination {
        fs::copy(source, destination).unwrap_or_else(|error| {
            panic!(
                "Failed to copy local executor sidecar from {} to {}: {error}",
                source.display(),
                destination.display()
            )
        });
    }
    make_executable(destination);
}

fn remove_debug_marker(marker_path: &Path) {
    if marker_path.exists() {
        fs::remove_file(marker_path).unwrap_or_else(|error| {
            panic!(
                "Failed to remove local executor sidecar debug marker {}: {error}",
                marker_path.display()
            )
        });
    }
}

fn build_debug_stub(destination: &Path, marker_path: &Path, target: &str) {
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set by Cargo"));
    let source_path = out_dir.join("wegent_executor_debug_stub.rs");
    fs::write(&source_path, DEBUG_STUB_SOURCE).unwrap_or_else(|error| {
        panic!(
            "Failed to write local executor debug stub source {}: {error}",
            source_path.display()
        )
    });

    let rustc = env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
    let mut command = Command::new(rustc);
    command
        .arg("--edition=2021")
        .arg(&source_path)
        .arg("-o")
        .arg(destination);

    if env::var("HOST").as_deref() != Ok(target) {
        command.arg("--target").arg(target);
    }

    let status = command.status().unwrap_or_else(|error| {
        panic!("Failed to invoke rustc for local executor debug stub: {error}")
    });
    if !status.success() {
        panic!("Failed to compile local executor debug stub");
    }

    make_executable(destination);
    fs::write(marker_path, b"debug stub\n").unwrap_or_else(|error| {
        panic!(
            "Failed to write local executor debug marker {}: {error}",
            marker_path.display()
        )
    });
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = fs::metadata(path)
        .unwrap_or_else(|error| {
            panic!(
                "Failed to read sidecar metadata {}: {error}",
                path.display()
            )
        })
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap_or_else(|error| {
        panic!(
            "Failed to mark sidecar executable {}: {error}",
            path.display()
        )
    });
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

const DEBUG_STUB_SOURCE: &str = r##"
use std::io::{self, BufRead, Write};

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            other => vec![other],
        })
        .collect()
}

fn extract_id(line: &str) -> String {
    let Some(id_key_start) = line.find("\"id\"") else {
        return "unknown".to_string();
    };
    let Some(colon_offset) = line[id_key_start..].find(':') else {
        return "unknown".to_string();
    };
    let after_colon = &line[id_key_start + colon_offset + 1..];
    let Some(value_start) = after_colon.find('"') else {
        return "unknown".to_string();
    };
    let after_quote = &after_colon[value_start + 1..];
    let Some(value_end) = after_quote.find('"') else {
        return "unknown".to_string();
    };
    after_quote[..value_end].to_string()
}

fn main() {
    println!(r#"{{"type":"event","event":"executor.ready","payload":{{"deviceId":"local-device"}}}}"#);
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.unwrap_or_default();
        let id = json_escape(&extract_id(&line));
        println!(
            r#"{{"type":"response","id":"{}","ok":false,"error":{{"code":"SIDECAR_NOT_BUILT","message":"Local executor sidecar is not built. Run executor/local.sh build or set WEWORK_EXECUTOR_SIDECAR before launching WeWork local-first."}}}}"#,
            id
        );
        let _ = io::stdout().flush();
    }
}
"##;
