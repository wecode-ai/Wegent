// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::File,
    io,
    mem::{offset_of, size_of, MaybeUninit},
    os::windows::io::AsRawHandle,
};

use windows_sys::Win32::{
    Storage::FileSystem::{
        FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO, FILE_ID_INFO,
    },
    System::{
        Ioctl::{FSCTL_READ_FILE_USN_DATA, READ_FILE_USN_DATA, USN_RECORD_V2, USN_RECORD_V3},
        IO::DeviceIoControl,
    },
};

use super::FileStamp;

pub(super) fn stamp(file: &File) -> io::Result<Option<FileStamp>> {
    let mut basic = MaybeUninit::<FILE_BASIC_INFO>::uninit();
    let mut identity = MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: Both POD buffers have the sizes required by the information classes.
    let available = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            basic.as_mut_ptr().cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        ) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                identity.as_mut_ptr().cast(),
                size_of::<FILE_ID_INFO>() as u32,
            ) != 0
    };
    // ChangeTime can be explicitly restored on Windows. Require a filesystem
    // change-journal sequence as well; unsupported volumes receive full hashes.
    let Some(sequence) = available.then(|| change_sequence(file)).flatten() else {
        return Ok(None);
    };
    // SAFETY: Both native queries succeeded and initialized these buffers.
    let (basic, identity) = unsafe { (basic.assume_init(), identity.assume_init()) };
    let id = identity.FileId.Identifier;
    Ok(Some(FileStamp {
        identity: [
            identity.VolumeSerialNumber,
            u64::from_le_bytes(id[..8].try_into().unwrap()),
            u64::from_le_bytes(id[8..].try_into().unwrap()),
        ],
        length: file.metadata()?.len(),
        modified: [basic.LastWriteTime, 0],
        changed: [basic.ChangeTime, sequence],
    }))
}

fn change_sequence(file: &File) -> Option<i64> {
    let input = READ_FILE_USN_DATA {
        MinMajorVersion: 2,
        MaxMajorVersion: 3,
    };
    let mut bytes = [0_u8; 1024];
    let mut returned = 0;
    // SAFETY: The synchronous call only reads input and writes within the supplied buffers.
    let available = unsafe {
        DeviceIoControl(
            file.as_raw_handle(),
            FSCTL_READ_FILE_USN_DATA,
            (&input as *const READ_FILE_USN_DATA).cast(),
            size_of::<READ_FILE_USN_DATA>() as u32,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    if available == 0 {
        return None;
    }
    sequence(bytes.get(..returned as usize)?)
}

fn sequence(bytes: &[u8]) -> Option<i64> {
    let length = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let record = bytes.get(..length)?;
    let offset = match u16::from_le_bytes(record.get(4..6)?.try_into().ok()?) {
        2 => offset_of!(USN_RECORD_V2, Usn),
        3 => offset_of!(USN_RECORD_V3, Usn),
        _ => return None,
    };
    let value = i64::from_le_bytes(record.get(offset..offset + 8)?.try_into().ok()?);
    (value > 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_complete_supported_change_records() {
        for (major, offset) in [
            (2_u16, offset_of!(USN_RECORD_V2, Usn)),
            (3, offset_of!(USN_RECORD_V3, Usn)),
        ] {
            let mut bytes = [0_u8; 80];
            bytes[..4].copy_from_slice(&80_u32.to_le_bytes());
            bytes[4..6].copy_from_slice(&major.to_le_bytes());
            assert_eq!(sequence(&bytes), None);
            bytes[offset..offset + 8].copy_from_slice(&42_i64.to_le_bytes());
            assert_eq!(sequence(&bytes), Some(42));
            assert_eq!(sequence(&bytes[..10]), None);
            bytes[4..6].copy_from_slice(&4_u16.to_le_bytes());
            assert_eq!(sequence(&bytes), None);
        }
    }
}
