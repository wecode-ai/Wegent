//! Synchronized same-directory replacement that preserves existing permissions.

use std::{fs, io, io::Write, path::Path};

/// The operation that failed while preparing or publishing a replacement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteStage {
    CreateTemporary,
    Write,
    Sync,
    PreservePermissions,
    Publish,
}

/// A filesystem failure with enough context for the caller's own diagnostics.
#[derive(Debug)]
pub struct AtomicWriteError {
    pub stage: WriteStage,
    pub source: io::Error,
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.stage, self.source)
    }
}

impl std::error::Error for AtomicWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Replace a file after syncing its contents and preserving any existing mode.
///
/// The parent must exist. Path authorization and directory creation belong to
/// the caller. Existing readers retain the old file, including on Windows.
/// This operation does not sync the parent directory.
pub fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), AtomicWriteError> {
    let failure = |stage| move |source| AtomicWriteError { stage, source };
    let parent = path.parent().ok_or_else(|| AtomicWriteError {
        stage: WriteStage::CreateTemporary,
        source: io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"),
    })?;
    // Windows native tempfile APIs require the verbatim path from canonicalize.
    let parent = fs::canonicalize(parent).map_err(failure(WriteStage::CreateTemporary))?;
    let name = path.file_name().ok_or_else(|| AtomicWriteError {
        stage: WriteStage::CreateTemporary,
        source: io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"),
    })?;
    let destination = parent.join(name);
    let mut temporary =
        tempfile::NamedTempFile::new_in(&parent).map_err(failure(WriteStage::CreateTemporary))?;
    temporary
        .write_all(bytes)
        .map_err(failure(WriteStage::Write))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(failure(WriteStage::Sync))?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions())
            .map_err(failure(WriteStage::PreservePermissions))?;
    }
    // Clear the temporary attribute using tempfile's own publication preparation,
    // but use the same reader-safe replacement primitive as runtime indexes.
    let (_file, staged_path) = temporary.keep().map_err(|error| AtomicWriteError {
        stage: WriteStage::Publish,
        source: error.error,
    })?;
    let staged_path =
        tempfile::TempPath::try_from_path(staged_path).map_err(failure(WriteStage::Publish))?;
    replace_file(&staged_path, &destination).map_err(failure(WriteStage::Publish))?;
    Ok(())
}

/// Atomically replace a destination without invalidating its existing readers.
#[cfg(not(windows))]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

/// Atomically replace a destination without invalidating its existing readers.
#[cfg(windows)]
pub fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::fs::OpenOptions;
    use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfoEx, SetFileInformationByHandle, DELETE, FILE_RENAME_INFO,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        FILE_RENAME_FLAG_POSIX_SEMANTICS, FILE_RENAME_FLAG_REPLACE_IF_EXISTS,
    };

    let source = OpenOptions::new().access_mode(DELETE).open(source)?;
    let parent = destination
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    // Direct Win32 calls need the canonical parent's verbatim prefix for long paths.
    let destination = fs::canonicalize(parent)?.join(destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no file name")
    })?);
    let name = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let buffer_size = std::mem::size_of::<FILE_RENAME_INFO>() + name.len() * 2;
    // Word storage aligns the variable-length FILE_RENAME_INFO and owns its tail.
    let mut buffer = vec![0usize; buffer_size.div_ceil(std::mem::size_of::<usize>())];
    let information = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // MoveFileExW rejects an open destination even when readers share DELETE.
    // POSIX replacement keeps those readers on the old file and publishes the new one.
    let result = unsafe {
        (*information).Anonymous.Flags =
            FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
        (*information).FileNameLength = ((name.len() - 1) * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*information).FileName).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            source.as_raw_handle(),
            FileRenameInfoEx,
            information.cast(),
            buffer_size as u32,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_preserves_open_readers() {
        use std::io::Read;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.ts");
        fs::write(&path, b"before").unwrap();
        let mut reader = fs::File::open(&path).unwrap();

        write_atomic_file(&path, b"after").unwrap();

        let mut original = Vec::new();
        reader.read_to_end(&mut original).unwrap();
        assert_eq!(original, b"before");
        assert_eq!(fs::read(&path).unwrap(), b"after");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn replacement_does_not_override_a_read_only_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.ts");
        fs::write(&path, b"before").unwrap();
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();

        let result = write_atomic_file(&path, b"after");

        fs::set_permissions(&path, original_permissions).unwrap();
        assert_eq!(result.unwrap_err().stage, WriteStage::Publish);
        assert_eq!(fs::read(&path).unwrap(), b"before");
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn replacement_supports_paths_beyond_windows_max_path() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory
            .path()
            .join("long-policy-home-".repeat(5))
            .join("long-agent-namespace-".repeat(5))
            .join("a".repeat(64));
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("SKILL.md");
        assert!(path.as_os_str().len() > 260);
        fs::write(&path, b"before").unwrap();

        write_atomic_file(&path, b"after").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"after");
        assert_eq!(fs::read_dir(parent).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn replacement_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config");
        fs::write(&path, b"before").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();

        write_atomic_file(&path, b"after").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"after");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn failed_publication_preserves_destination_and_removes_staging_file() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("destination");
        fs::create_dir(&destination).unwrap();

        let error = write_atomic_file(&destination, b"replacement").unwrap_err();

        assert_eq!(error.stage, WriteStage::Publish);
        assert!(destination.is_dir());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
