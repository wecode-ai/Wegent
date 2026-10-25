//! Handle-bound reads for hosts without native MXC. This is a trusted filesystem
//! broker, never a command launcher. Every returned byte comes from a handle
//! checked against the original managed permission profile.

use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use codex_exec_server_protocol::JSONRPCErrorError;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::ReadDenyMatcher;
use codex_utils_path_uri::PathUri;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::FILE_TYPE_DISK;
use windows_sys::Win32::Storage::FileSystem::GetFileType;
use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
use windows_sys::Win32::Storage::FileSystem::ReOpenFile;

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
    let (path, follow, read_data) = match &request {
        FsHelperRequest::ReadFile(params) => {
            (&params.path, params.follow_symlinks.unwrap_or(true), true)
        }
        FsHelperRequest::GetMetadata(params) => {
            (&params.path, params.follow_symlinks.unwrap_or(true), false)
        }
        _ => return Err(denied()),
    };
    let path = path.to_abs_path()?;
    let matcher = ReadDenyMatcher::try_new_for_local_paths(&policy, cwd)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    check(&policy, matcher.as_ref(), cwd, path.as_path())?;
    let mut file = open_checked(
        &policy,
        matcher.as_ref(),
        cwd,
        path.as_path(),
        follow,
        read_data,
    )?;
    let metadata = file.metadata()?;
    if read_data {
        if !metadata.is_file() || (!follow && metadata.file_type().is_symlink()) {
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
    follow: bool,
    read_data: bool,
) -> io::Result<File> {
    // Probe the canonical target before opening it. The subsequent handle check
    // also catches a junction or symlink replaced between these operations.
    if follow {
        check(policy, matcher, cwd, &std::fs::canonicalize(path)?)?;
    }
    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(
            FILE_FLAG_BACKUP_SEMANTICS
                | if follow {
                    0
                } else {
                    FILE_FLAG_OPEN_REPARSE_POINT
                },
        );
    // Do not permit replacement of the opened file during validation.
    let file = options.open(path)?;
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(denied());
    }
    check(policy, matcher, cwd, &handle_path(&file)?)?;
    if !read_data {
        return Ok(file);
    }
    let metadata = file.metadata()?;
    if !metadata.is_file() || (!follow && metadata.file_type().is_symlink()) {
        return Err(denied());
    }
    // ReOpenFile binds the data handle to the checked object. Reopening its
    // pathname here would introduce a check/use race with an untrusted writer.
    let handle = unsafe {
        ReOpenFile(
            file.as_raw_handle(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(handle) })
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
            let matcher =
                ReadDenyMatcher::try_new_for_local_paths(&self.policy, &self.project).unwrap();
            check(&self.policy, matcher.as_ref(), &self.project, path)?;
            let mut file = open_checked(
                &self.policy,
                matcher.as_ref(),
                &self.project,
                path,
                true,
                true,
            )?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
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

    #[test]
    fn windows_read_broker_keeps_project_instructions_with_root_deny() {
        let fixture = Fixture::new();
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
    }

    #[test]
    fn windows_read_broker_denies_junction_escape_and_allows_bound_targets() {
        let fixture = Fixture::new();
        let outside = fixture.junction("outside", &fixture.private);
        assert_eq!(
            fixture
                .read(&outside.join("secret.txt"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        let inside = fixture.junction("inside", &fixture.project);
        assert_eq!(
            fixture.read(&inside.join("AGENTS.md")).unwrap(),
            b"Project instructions"
        );
        std::fs::remove_dir(outside).unwrap();
        std::fs::remove_dir(inside).unwrap();
    }

    #[test]
    fn windows_read_broker_keeps_explicit_and_glob_denials() {
        let mut fixture = Fixture::new();
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
            io::ErrorKind::PermissionDenied
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
            true,
        )
        .unwrap();
        assert!(
            std::fs::remove_file(&path).is_err(),
            "checked file must remain pinned"
        );
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
        assert!(execute(fixture.policy.clone(), &fixture.project, request).is_err());
        assert_eq!(
            std::fs::read(fixture.project.join("AGENTS.md")).unwrap(),
            b"Project instructions"
        );
    }
}
