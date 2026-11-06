// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

#[cfg(windows)]
#[path = "file_digests/windows.rs"]
mod windows;

/// Reuse only within one publication transaction. Identity and change time fence reuse.
#[derive(Default)]
pub(super) struct FileDigests {
    entries: BTreeMap<PathBuf, (FileStamp, String)>,
    pub hashed_files: usize,
    pub hashed_bytes: u64,
    pub reused_hashes: usize,
}

impl FileDigests {
    pub fn read(&mut self, path: &Path) -> io::Result<String> {
        let mut file = File::open(path)?;
        let before = FileStamp::read(&file)?;
        if let Some(stamp) = &before {
            if let Some((cached, digest)) = self.entries.get(path) {
                if cached == stamp && before == FileStamp::read(&file)? {
                    self.reused_hashes += 1;
                    return Ok(digest.clone());
                }
            }
        }
        let mut digest = Sha256::new();
        let mut buffer = [0; 8192];
        self.hashed_files += 1;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            self.hashed_bytes += count as u64;
        }
        if before != FileStamp::read(&file)? {
            return Err(io::Error::other("File changed during capability detection"));
        }
        let digest = format!("sha256:{:x}", digest.finalize());
        if let Some(stamp) = before {
            self.entries
                .insert(path.to_owned(), (stamp, digest.clone()));
        }
        Ok(digest)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    identity: [u64; 3],
    length: u64,
    modified: [i64; 2],
    changed: [i64; 2],
}

impl FileStamp {
    #[cfg(unix)]
    fn read(file: &File) -> io::Result<Option<Self>> {
        use std::os::unix::fs::MetadataExt;
        let metadata = file.metadata()?;
        // Second-resolution timestamps cannot fence same-length edits within a second.
        if metadata.ctime_nsec() == 0 {
            return Ok(None);
        }
        Ok(Some(Self {
            identity: [metadata.dev(), metadata.ino(), 0],
            length: metadata.len(),
            modified: [metadata.mtime(), metadata.mtime_nsec()],
            changed: [metadata.ctime(), metadata.ctime_nsec()],
        }))
    }

    #[cfg(windows)]
    fn read(file: &File) -> io::Result<Option<Self>> {
        windows::stamp(file)
    }

    #[cfg(not(any(unix, windows)))]
    fn read(_file: &File) -> io::Result<Option<Self>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_files_are_hashed_once_per_transaction() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("payload");
        std::fs::write(&path, b"verified content").unwrap();
        let reusable = FileStamp::read(&File::open(&path).unwrap())
            .unwrap()
            .is_some();
        let mut digests = FileDigests::default();
        let expected = digests.read(&path).unwrap();
        assert_eq!(digests.read(&path).unwrap(), expected);
        assert_eq!(digests.hashed_files, if reusable { 1 } else { 2 });
        assert_eq!(digests.reused_hashes, usize::from(reusable));
        let mut next = FileDigests::default();
        assert_eq!(next.read(&path).unwrap(), expected);
        assert_eq!(next.hashed_files, 1);
    }

    #[test]
    fn rewriting_same_length_content_with_restored_mtime_is_not_cached() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("payload");
        std::fs::write(&path, b"before").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut digests = FileDigests::default();
        let before = digests.read(&path).unwrap();
        std::fs::write(&path, b"after!").unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_ne!(digests.read(&path).unwrap(), before);
        assert_eq!(digests.hashed_files, 2);
    }

    #[test]
    fn replacement_files_and_missing_files_do_not_reuse_a_digest() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("payload");
        std::fs::write(&path, b"before").unwrap();
        let mut digests = FileDigests::default();
        let before = digests.read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            digests.read(&path).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
        std::fs::write(&path, b"after!").unwrap();
        assert_ne!(digests.read(&path).unwrap(), before);
        assert_eq!(digests.hashed_files, 2);
    }
}
