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
/// the caller. This operation does not sync the parent directory or promise
/// replacement of files held open by readers on Windows.
pub fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), AtomicWriteError> {
    let failure = |stage| move |source| AtomicWriteError { stage, source };
    let parent = path.parent().ok_or_else(|| AtomicWriteError {
        stage: WriteStage::CreateTemporary,
        source: io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"),
    })?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(failure(WriteStage::CreateTemporary))?;
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
    temporary.persist(path).map_err(|error| AtomicWriteError {
        stage: WriteStage::Publish,
        source: error.error,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
