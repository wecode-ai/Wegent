//! Git's prepared reference transaction enforces the reviewed baseline atomically.
use super::*;

const FORWARD_HOOK: &str = r#"#!/bin/sh
hook_name=${0##*/}
original="$WEGENT_ORIGINAL_HOOKS_PATH/$hook_name"
if [ ! -x "$original" ] && [ -x "$original.exe" ]; then original="$original.exe"; fi
exec "$original" "$@"
"#;

const REFERENCE_GUARD: &str = r#"#!/bin/sh
input=$(cat) || exit 1
if [ "$1" = prepared ]; then
  printf '%s\n' "$input" | while read -r old new reference; do
    if [ "$reference" = "$WEGENT_MERGE_TARGET_REF" ] || [ "$reference" = HEAD ]; then
      if [ "$old" != "$WEGENT_MERGE_EXPECTED_BASE" ] || [ "$new" != "$WEGENT_MERGE_CANDIDATE" ]; then
        printf '%s\n' 'worktree_merge_target_changed: The reviewed baseline changed' >&2
        exit 1
      fi
    fi
  done || exit 1
fi
original="$WEGENT_ORIGINAL_HOOKS_PATH/reference-transaction"
if [ ! -x "$original" ] && [ -x "$original.exe" ]; then original="$original.exe"; fi
if [ -x "$original" ]; then
  printf '%s\n' "$input" | "$original" "$@"
fi
"#;

pub(in crate::runtime_work::worktrees) fn guarded_fast_forward(
    source: &Path,
    state_path: &Path,
    evidence: &RequestMergeEvidence,
    candidate: &str,
) -> Result<(), String> {
    let version = git_output(source, &["--version"], None)?;
    let mut version = version
        .split_whitespace()
        .nth(2)
        .unwrap_or_default()
        .split('.');
    let major = version
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let minor = version
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    if major < 2 || (major == 2 && minor < 29) {
        return Err("worktree_merge_guard_unavailable: Git 2.29 or newer is required for atomic baseline checks".to_owned());
    }
    let hooks_root = state_path
        .parent()
        .ok_or("Missing registry directory")?
        .join("merge-publish-guards");
    fs::create_dir_all(&hooks_root).map_err(|error| error.to_string())?;
    let guard = tempfile::tempdir_in(&hooks_root).map_err(|error| error.to_string())?;
    let original = git_output_raw(source, &["rev-parse", "--git-path", "hooks"], None)?;
    let original = PathBuf::from(original.trim_end_matches(['\r', '\n']));
    let original = if original.is_absolute() {
        original
    } else {
        source.join(original)
    };
    forward_original_hooks(&original, guard.path())?;
    let original = original.to_str().ok_or("Invalid original Git hooks path")?;
    write_hook(&guard.path().join("reference-transaction"), REFERENCE_GUARD)?;
    let config = format!("core.hooksPath={}", guard.path().display());
    let environment = [
        ("WEGENT_ORIGINAL_HOOKS_PATH", original),
        ("WEGENT_MERGE_TARGET_REF", evidence.target_ref.as_str()),
        (
            "WEGENT_MERGE_EXPECTED_BASE",
            evidence.target_revision.as_str(),
        ),
        ("WEGENT_MERGE_CANDIDATE", candidate),
    ];
    git_output(
        source,
        &["-c", &config, "merge", "--ff-only", "--no-edit", candidate],
        Some(&environment),
    )?;
    Ok(())
}

fn forward_original_hooks(original: &Path, destination: &Path) -> Result<(), String> {
    let hooks = match fs::read_dir(original) {
        Ok(hooks) => hooks,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for hook in hooks {
        let hook = hook.map_err(|error| error.to_string())?;
        let metadata = fs::metadata(hook.path()).map_err(|error| error.to_string())?;
        if !metadata.is_file() || !hook_is_executable(&metadata) {
            continue;
        }
        let name = hook.file_name();
        #[cfg(windows)]
        let name = if hook
            .path()
            .extension()
            .is_some_and(|extension| extension == "exe")
        {
            std::ffi::OsString::from(hook.path().file_stem().ok_or("Invalid hook name")?)
        } else {
            name
        };
        write_hook(&destination.join(name), FORWARD_HOOK)?;
    }
    Ok(())
}

fn write_hook(path: &Path, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn hook_is_executable(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}
