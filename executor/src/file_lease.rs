// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs::File;

use fs2::FileExt;

/// An already acquired advisory lock owned by the enclosing operation.
#[derive(Debug)]
pub(crate) struct FileLease(pub(crate) File);

impl Drop for FileLease {
    fn drop(&mut self) {
        // A concurrent fork may retain this open file description after close.
        // The enclosing operation owns the lock lifetime, not inherited handles.
        let _ = FileExt::unlock(&self.0);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use fs2::FileExt;

    #[test]
    fn owner_drop_releases_lock_while_an_inherited_descriptor_remains_open() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("operation.lock");
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        file.try_lock_exclusive().unwrap();
        let owner = FileLease(file);
        let inherited = owner.0.try_clone().unwrap();
        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(contender.try_lock_exclusive().is_err());

        drop(owner);

        contender
            .try_lock_exclusive()
            .expect("an inherited descriptor must not extend the owner's lock lifetime");
        assert!(inherited.metadata().unwrap().is_file());
    }
}
