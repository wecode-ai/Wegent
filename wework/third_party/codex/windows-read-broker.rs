//! Handle-bound reads for hosts without native MXC. This is a trusted filesystem
//! broker, never a command launcher. Every returned byte comes from a handle
//! checked against the original managed permission profile.

use std::fs::File;
use std::io;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use codex_exec_server_protocol::JSONRPCErrorError;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_protocol::permissions::ReadDenyMatcher;
use codex_utils_path_uri::PathUri;
use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

use crate::FileSystemSandboxContext;
use crate::fs_helper::FsHelperPayload;
use crate::fs_helper::FsHelperRequest;
use crate::fs_helper::map_fs_error;
use crate::protocol::FsGetMetadataResponse;
use crate::protocol::FsReadFileResponse;

pub(super) fn supports(request: &FsHelperRequest) -> bool {
    matches!(
        request,
        FsHelperRequest::ReadFile(_) | FsHelperRequest::GetMetadata(_)
    )
}

pub(super) async fn run(
    sandbox: &FileSystemSandboxContext,
    request: FsHelperRequest,
) -> Result<FsHelperPayload, JSONRPCErrorError> {
    sandbox
        .validate_file_system_paths_for_current_host()
        .map_err(map_fs_error)?;
    let roots = sandbox
        .workspace_roots
        .iter()
        .map(PathUri::to_abs_path)
        .collect::<io::Result<Vec<_>>>()
        .map_err(map_fs_error)?;
    let cwd = sandbox.cwd.to_abs_path().map_err(map_fs_error)?;
    let policy = sandbox
        .permissions
        .clone()
        .materialize_project_roots_with_workspace_roots(&roots)
        .file_system_sandbox_policy();
    tokio::task::spawn_blocking(move || execute(policy, cwd.as_path(), request))
        .await
        .map_err(|_| crate::rpc::internal_error("Windows read broker failed".to_owned()))?
        .map_err(map_fs_error)
}

fn execute(
    policy: FileSystemSandboxPolicy,
    cwd: &Path,
    request: FsHelperRequest,
) -> io::Result<FsHelperPayload> {
    let (path, read_data) = match &request {
        FsHelperRequest::ReadFile(params) => (&params.path, true),
        FsHelperRequest::GetMetadata(params) => (&params.path, false),
        _ => return Err(denied()),
    };
    let path = path.to_abs_path()?;
    if path.components().any(|component| {
        matches!(component,
        std::path::Component::Normal(name) if name.to_string_lossy().contains(':'))
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows read broker does not accept alternate data streams",
        ));
    }
    // Complex policies still require the native backend. In particular, a glob
    // may contain a DOS short-name alias that a lexical matcher cannot equate
    // with the opened handle's canonical name. Never approximate that denial.
    if policy.entries.iter().any(|entry| match &entry.path {
        FileSystemPath::GlobPattern { .. } => true,
        FileSystemPath::Special { value } => !matches!(
            value,
            FileSystemSpecialPath::Root | FileSystemSpecialPath::Minimal
        ),
        FileSystemPath::Path { .. } => false,
    }) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Windows read broker requires native MXC for this permission profile",
        ));
    }
    let mut canonical_policy = policy.clone();
    super::normalize_file_system_policy_root_aliases(&mut canonical_policy)
        .map_err(|_| denied())?;
    let canonical_matcher = ReadDenyMatcher::try_new_for_local_paths(&canonical_policy, cwd)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let matcher = ReadDenyMatcher::try_new_for_local_paths(&policy, cwd)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    if check(&policy, matcher.as_ref(), cwd, path.as_path()).is_err()
        && check(
            &canonical_policy,
            canonical_matcher.as_ref(),
            cwd,
            path.as_path(),
        )
        .is_err()
    {
        return Err(denied_path(path.as_path()));
    }
    let mut file = open_checked(
        &canonical_policy,
        canonical_matcher.as_ref(),
        cwd,
        path.as_path(),
        read_data,
    )
    .map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("Windows read broker: {}: {error}", path.display()),
        )
    })?;
    let metadata = file.metadata()?;
    if read_data {
        if !metadata.is_file() {
            return Err(denied());
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(FsHelperPayload::ReadFile(FsReadFileResponse {
            data_base64: STANDARD.encode(bytes),
        }))
    } else {
        Ok(FsHelperPayload::GetMetadata(FsGetMetadataResponse {
            is_directory: metadata.is_dir(),
            is_file: metadata.is_file(),
            is_symlink: metadata.file_type().is_symlink(),
            size: metadata.len(),
            created_at_ms: timestamp(metadata.created()),
            modified_at_ms: timestamp(metadata.modified()),
        }))
    }
}

fn open_checked(
    policy: &FileSystemSandboxPolicy,
    matcher: Option<&ReadDenyMatcher>,
    cwd: &Path,
    path: &Path,
    read_data: bool,
) -> io::Result<File> {
    // Never canonicalize an untrusted link here: resolving an outside UNC
    // target can contact another host before its permissions can be checked.
    // Native MXC is required for operations that must traverse reparse points.
    let file = if read_data {
        crate::no_follow::open_file(path)?
    } else {
        crate::no_follow::open_metadata_file(path)?
    };
    if !crate::regular_file::is_disk_file(&file) {
        return Err(denied());
    }
    check(policy, matcher, cwd, &handle_path(&file)?)?;
    Ok(file)
}

fn handle_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let mut buffer = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(denied());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length as usize],
    )))
}

fn check(
    policy: &FileSystemSandboxPolicy,
    matcher: Option<&ReadDenyMatcher>,
    cwd: &Path,
    path: &Path,
) -> io::Result<()> {
    if !policy.can_read_local_path_with_cwd(path, cwd)
        || matcher.is_some_and(|matcher| matcher.is_local_path_read_denied(path))
    {
        return Err(denied());
    }
    Ok(())
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "Windows read broker: filesystem permission denied",
    )
}

fn denied_path(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!(
            "Windows read broker: filesystem permission denied: {}",
            path.display()
        ),
    )
}

fn timestamp(time: io::Result<SystemTime>) -> i64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::permissions::FileSystemAccessMode;
    use codex_protocol::permissions::FileSystemPath;
    use codex_protocol::permissions::FileSystemSandboxEntry;
    use codex_protocol::permissions::FileSystemSpecialPath;
    use codex_utils_absolute_path::AbsolutePathBuf;

    struct Fixture {
        _root: tempfile::TempDir,
        project: PathBuf,
        private: PathBuf,
        policy: FileSystemSandboxPolicy,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let project = root.path().join("project");
            let private = root.path().join("private");
            std::fs::create_dir(&project).unwrap();
            std::fs::create_dir(&private).unwrap();
            std::fs::write(project.join("AGENTS.md"), "Project instructions").unwrap();
            std::fs::write(private.join("secret.txt"), "Never return this").unwrap();
            let project = std::fs::canonicalize(project).unwrap();
            let private = std::fs::canonicalize(private).unwrap();
            let mut policy = FileSystemSandboxPolicy::read_only();
            policy.entries = vec![
                FileSystemSandboxEntry::new(
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    },
                    FileSystemAccessMode::Deny,
                ),
                FileSystemSandboxEntry::new(
                    AbsolutePathBuf::from_absolute_path(&project)
                        .unwrap()
                        .into(),
                    FileSystemAccessMode::Read,
                ),
            ];
            Self {
                _root: root,
                project,
                private,
                policy,
            }
        }

        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            let request: FsHelperRequest = serde_json::from_value(serde_json::json!({
                "operation": "fs/readFile", "params": {
                    "path": PathUri::from_host_native_path(path).unwrap()
                }
            }))
            .unwrap();
            match execute(self.policy.clone(), &self.project, request)? {
                FsHelperPayload::ReadFile(response) => {
                    Ok(STANDARD.decode(response.data_base64).unwrap())
                }
                _ => panic!("unexpected read response"),
            }
        }

        fn junction(&self, name: &str, target: &Path) -> PathBuf {
            let link = self.project.join(name);
            let output = std::process::Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            link
        }
    }

    fn assert_short_alias(fixture: &Fixture) {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::ffi::OsStringExt;
        let name = fixture
            .project
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut buffer = vec![0u16; 32768];
        let length = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                name.as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
            )
        } as usize;
        assert!(length > 0 && length < buffer.len());
        let short = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]));
        let mut policy = fixture.policy.clone();
        policy.entries[1] = FileSystemSandboxEntry::new(
            AbsolutePathBuf::from_absolute_path(&short).unwrap().into(),
            FileSystemAccessMode::Read,
        );
        let request: FsHelperRequest = serde_json::from_value(serde_json::json!({
            "operation": "fs/readFile", "params": {
                "path": PathUri::from_host_native_path(short.join("AGENTS.md")).unwrap()
            }
        }))
        .unwrap();
        match execute(policy, &short, request).unwrap() {
            FsHelperPayload::ReadFile(response) => assert_eq!(
                STANDARD.decode(response.data_base64).unwrap(),
                b"Project instructions"
            ),
            _ => panic!("unexpected read response"),
        }
    }

    #[test]
    fn windows_read_broker_keeps_project_instructions_with_root_deny() {
        let fixture = Fixture::new();
        assert_short_alias(&fixture);
        assert_eq!(
            fixture.read(&fixture.project.join("AGENTS.md")).unwrap(),
            b"Project instructions"
        );
        assert_eq!(
            fixture
                .read(&fixture.private.join("secret.txt"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let metadata: FsHelperRequest = serde_json::from_value(serde_json::json!({
            "operation": "fs/getMetadata", "params": {
                "path": PathUri::from_host_native_path(fixture.private.join("secret.txt")).unwrap()
            }
        }))
        .unwrap();
        assert_eq!(
            execute(fixture.policy.clone(), &fixture.project, metadata)
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            fixture
                .read(&fixture.project.join("AGENTS.md::$DATA"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn windows_read_broker_rejects_junctions_before_resolving_any_target() {
        let fixture = Fixture::new();
        let outside = fixture.junction("outside", &fixture.private);
        assert_eq!(
            fixture
                .read(&outside.join("secret.txt"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            fixture
                .read(&outside.join("missing.txt"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        let inside = fixture.junction("inside", &fixture.project);
        assert_eq!(
            fixture.read(&inside.join("AGENTS.md")).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        std::fs::remove_dir(outside).unwrap();
        std::fs::remove_dir(inside).unwrap();
    }

    #[test]
    fn windows_read_broker_keeps_denials_and_rejects_unsupported_glob_profiles() {
        let mut fixture = Fixture::new();
        fixture.policy.entries.push(FileSystemSandboxEntry::new(
            AbsolutePathBuf::from_absolute_path(fixture.project.join("AGENTS.md"))
                .unwrap()
                .into(),
            FileSystemAccessMode::Deny,
        ));
        assert_eq!(
            fixture
                .read(&fixture.project.join("AGENTS.md"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        std::fs::write(fixture.project.join("public.txt"), "public").unwrap();
        assert_eq!(
            fixture.read(&fixture.project.join("public.txt")).unwrap(),
            b"public"
        );
        fixture.policy.entries.push(FileSystemSandboxEntry::new(
            FileSystemPath::GlobPattern {
                pattern: "**/AGENTS.md".to_owned(),
            },
            FileSystemAccessMode::Deny,
        ));
        assert_eq!(
            fixture
                .read(&fixture.project.join("AGENTS.md"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            fixture
                .read(&fixture.project.join("public.txt"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn windows_read_broker_data_handle_survives_path_replacement_without_reopening() {
        let fixture = Fixture::new();
        let path = fixture.project.join("AGENTS.md");
        let matcher =
            ReadDenyMatcher::try_new_for_local_paths(&fixture.policy, &fixture.project).unwrap();
        let mut file = open_checked(
            &fixture.policy,
            matcher.as_ref(),
            &fixture.project,
            &path,
            true,
        )
        .unwrap();
        std::fs::rename(&path, fixture.project.join("opened-instructions.md")).unwrap();
        std::fs::copy(fixture.private.join("secret.txt"), &path).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "Project instructions");
    }

    #[test]
    fn windows_read_broker_never_accepts_mutations_or_commands() {
        let fixture = Fixture::new();
        let request: FsHelperRequest = serde_json::from_value(serde_json::json!({
            "operation": "fs/writeFile", "params": {
                "path": PathUri::from_host_native_path(fixture.project.join("AGENTS.md")).unwrap(),
                "dataBase64": STANDARD.encode("overwrite")
            }
        }))
        .unwrap();
        assert!(!supports(&request));
        assert!(
            serde_json::from_value::<FsHelperRequest>(serde_json::json!({
                "operation": "process/exec", "params": {"command": "anything"}
            }))
            .is_err()
        );
        assert!(execute(fixture.policy.clone(), &fixture.project, request).is_err());
        assert_eq!(
            std::fs::read(fixture.project.join("AGENTS.md")).unwrap(),
            b"Project instructions"
        );
    }
}
