// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Native directory links without Windows symbolic-link privileges.

use std::{io, path::Path};

pub fn remove(link: &Path) -> io::Result<()> {
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
pub fn create(source: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
pub fn create(source: &Path, link: &Path) -> io::Result<()> {
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
    let buffer = junction_buffer(&source)?;
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
    let name = junction_target_name(source)?;
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

#[cfg(windows)]
fn junction_target_name(source: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetFullPathNameW;
    if source.as_os_str().encode_wide().any(|unit| unit == 0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Junction target contains NUL",
        ));
    }
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .map(|unit| if unit == 47 { 92 } else { unit })
        .chain([0])
        .collect();
    // Resolve lexically: recovery must preserve links whose targets have moved.
    // SAFETY: source is NUL-terminated and the first call only queries capacity.
    let capacity = unsafe {
        GetFullPathNameW(
            source.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if capacity == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut absolute = vec![0; capacity as usize];
    // SAFETY: the output buffer holds capacity UTF-16 code units.
    let length = unsafe {
        GetFullPathNameW(
            source.as_ptr(),
            capacity,
            absolute.as_mut_ptr(),
            std::ptr::null_mut(),
        )
    };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    if length >= capacity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Junction target changed while resolving its absolute path",
        ));
    }
    absolute.truncate(length as usize);
    let mut name = vec![92, 63, 63, 92];
    if absolute.starts_with(&[92, 92, 63, 92]) {
        name.extend_from_slice(&absolute[4..]);
    } else if absolute.starts_with(&[92, 92]) {
        name.extend("UNC\\".encode_utf16());
        name.extend_from_slice(&absolute[2..]);
    } else {
        name.extend(absolute);
    }
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn preserves_a_link_after_its_target_was_removed() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("package");
        let original = root.path().join("original");
        let snapshot = root.path().join("snapshot");
        fs::create_dir(&target).unwrap();
        create(&target, &original).unwrap();
        fs::remove_dir(&target).unwrap();

        create(&fs::read_link(&original).unwrap(), &snapshot).unwrap();

        assert_eq!(
            fs::read_link(&snapshot).unwrap(),
            fs::read_link(&original).unwrap()
        );
        remove(&original).unwrap();
        remove(&snapshot).unwrap();
        assert!(!target.exists());
    }

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
