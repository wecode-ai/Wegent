//! Rollback of local plugin state.
use super::*;

#[derive(Debug)]
struct FileSnapshot {
    path: PathBuf,
    backup: Option<PathBuf>,
}

#[derive(Debug, Default)]
pub(super) struct LocalPluginStateTransaction {
    files: Vec<FileSnapshot>,
    moved_paths: Vec<(PathBuf, PathBuf)>,
    created_paths: Vec<PathBuf>,
}

impl LocalPluginStateTransaction {
    pub(super) fn begin(
        file_paths: impl IntoIterator<Item = PathBuf>,
        moved_paths: impl IntoIterator<Item = PathBuf>,
    ) -> Result<Self, CapabilitySyncError> {
        let mut transaction = Self::default();
        let result = (|| {
            for path in file_paths.into_iter().collect::<BTreeSet<_>>() {
                let backup = if path.exists() || path.is_symlink() {
                    let backup = rollback_temp_path(&path);
                    remove_existing_path(&backup)?;
                    fs::copy(&path, &backup)?;
                    Some(backup)
                } else {
                    None
                };
                transaction.files.push(FileSnapshot { path, backup });
            }
            for path in moved_paths.into_iter().collect::<BTreeSet<_>>() {
                if !path.exists() && !path.is_symlink() {
                    transaction.created_paths.push(path);
                    continue;
                }
                let backup = rollback_temp_path(&path);
                remove_existing_path(&backup)?;
                fs::rename(&path, &backup)?;
                transaction.moved_paths.push((path, backup));
            }
            Ok(())
        })();
        if let Err(error) = result {
            return Err(transaction.add_rollback_context(error));
        }
        Ok(transaction)
    }

    pub(super) fn commit(self) {
        for snapshot in self.files {
            if let Some(backup) = snapshot.backup {
                let _ = remove_existing_path(&backup);
            }
        }
        for (_, backup) in self.moved_paths {
            let _ = remove_existing_path(&backup);
        }
    }

    fn rollback(&mut self) -> Result<(), CapabilitySyncError> {
        let mut errors = Vec::new();
        for path in self.created_paths.iter().rev() {
            if let Err(error) = remove_existing_path(path) {
                errors.push(error.to_string());
            }
        }
        for (path, backup) in self.moved_paths.iter().rev() {
            if let Err(error) = remove_existing_path(path)
                .and_then(|()| fs::rename(backup, path).map_err(CapabilitySyncError::from))
            {
                errors.push(error.to_string());
            }
        }
        for snapshot in self.files.iter().rev() {
            let result = remove_existing_path(&snapshot.path).and_then(|()| {
                if let Some(backup) = &snapshot.backup {
                    fs::rename(backup, &snapshot.path).map_err(CapabilitySyncError::from)
                } else {
                    Ok(())
                }
            });
            if let Err(error) = result {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(CapabilitySyncError::invalid_payload(format!(
                "Local plugin state rollback failed: {}",
                errors.join("; ")
            )))
        }
    }

    pub(super) fn add_rollback_context(
        &mut self,
        error: CapabilitySyncError,
    ) -> CapabilitySyncError {
        match self.rollback() {
            Ok(()) => error,
            Err(rollback_error) => {
                CapabilitySyncError::invalid_payload(format!("{error}; {rollback_error}"))
            }
        }
    }
}

fn rollback_temp_path(path: &Path) -> PathBuf {
    let mut temporary = sibling_temp_path(path).into_os_string();
    temporary.push(".rollback");
    PathBuf::from(temporary)
}
