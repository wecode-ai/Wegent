// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Native directory links without Windows symbolic-link privileges.

use std::{io, path::Path};

pub(crate) fn remove(link: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if std::fs::symlink_metadata(link)?
            .file_type()
            .is_symlink_dir()
        {
            return std::fs::remove_dir(link);
        }
    }
    std::fs::remove_file(link)
}

#[cfg(unix)]
pub(crate) fn create(source: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
pub(crate) fn create(source: &Path, link: &Path) -> io::Result<()> {
    use std::{fs, os::windows::fs::OpenOptionsExt, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT},
        System::{Ioctl::FSCTL_SET_REPARSE_POINT, IO::DeviceIoControl},
    };

    let source = if source.is_absolute() {
        source.to_owned()
    } else {
        link.parent().unwrap_or_else(|| Path::new(".")).join(source)
    };
    let buffer = junction_buffer(&fs::canonicalize(source)?)?;
    fs::create_dir(link)?;
    let result = (|| {
        let handle = fs::OpenOptions::new()
            .write(true)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(link)?;
        let mut returned = 0;
        // SAFETY: the synchronous handle and both buffers remain valid for the call.
        let success = unsafe {
            DeviceIoControl(
                handle.as_raw_handle(),
                FSCTL_SET_REPARSE_POINT,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        if success == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    })();
    if result.is_err() {
        // Only remove the empty directory reserved by this call, never its target.
        let _ = fs::remove_dir(link);
    }
    result
}

#[cfg(windows)]
fn junction_buffer(source: &Path) -> io::Result<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    let mut name: Vec<u16> = source.as_os_str().encode_wide().collect();
    if !name.starts_with(&[92, 92, 63, 92]) {
        return Err(io::Error::other(
            "Junction target requires a canonical Windows path",
        ));
    }
    // Convert the canonical Win32 prefix to the NT substitute-name prefix.
    name[..4].copy_from_slice(&[92, 63, 63, 92]);
    let length = name.len() * 2;
    let data_length = 8 + length + 4;
    if data_length + 8 > 16 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Junction target is too long",
        ));
    }
    let mut buffer = Vec::with_capacity(data_length + 8);
    buffer.extend_from_slice(&0xa0000003_u32.to_le_bytes());
    for value in [
        data_length as u16,
        0,
        0,
        length as u16,
        (length + 2) as u16,
        0,
    ] {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    for value in name.into_iter().chain([0, 0]) {
        buffer.extend_from_slice(&value.to_le_bytes());
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn publishes_and_removes_a_directory_link_without_changing_its_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("package with spaces");
        let link = root.path().join("entry");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("payload"), "original").unwrap();
        create(&target, &link).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(link.join("payload")).unwrap(),
            "original"
        );
        assert!(create(&target, &link).is_err());
        remove(&link).unwrap();
        assert!(!link.exists());
        assert_eq!(
            fs::read_to_string(target.join("payload")).unwrap(),
            "original"
        );
    }

    #[test]
    fn does_not_replace_a_directory_owned_by_someone_else() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("package");
        let link = root.path().join("entry");
        fs::create_dir(&target).unwrap();
        fs::create_dir(&link).unwrap();
        fs::write(link.join("payload"), "unmanaged").unwrap();
        assert!(create(&target, &link).is_err());
        assert_eq!(
            fs::read_to_string(link.join("payload")).unwrap(),
            "unmanaged"
        );
    }
}
