// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Minimal ZIP writer reproducing CPython `zipfile`'s output for the DOCX
//! package: deflate streams from the real zlib backend at the default level,
//! shared entry timestamps, `0o600 << 16` external attributes, and the
//! central-directory layout `ZipFile.writestr` produces.

use std::io::Write as _;

use chrono::{Datelike, Timelike};

/// One zip entry under construction.
struct Entry {
    name: String,
    crc: u32,
    compressed: Vec<u8>,
    uncompressed_size: u32,
    method: u16,
    dos_time: u16,
    dos_date: u16,
    offset: u32,
}

/// A zip archive written the way `zipfile.ZipFile(pkg, "w", ZIP_DEFLATED)`
/// writes `writestr(name, data)` calls.
pub(crate) struct ZipPackage {
    entries: Vec<Entry>,
    dos_time: u16,
    dos_date: u16,
    buffer: Vec<u8>,
}

impl ZipPackage {
    /// `date_time` is the shared `time.localtime(time.time())[:6]` used for
    /// every entry created in the same save.
    pub(crate) fn new(date_time: chrono::NaiveDateTime) -> Self {
        let (year, month, day) = (date_time.year(), date_time.month(), date_time.day());
        let (hour, minute, second) = (date_time.hour(), date_time.minute(), date_time.second());
        Self {
            entries: Vec::new(),
            dos_time: ((hour << 11) | (minute << 5) | (second / 2)) as u16,
            dos_date: (((year - 1980) << 9) | ((month as i32) << 5) | day as i32) as u16,
            buffer: Vec::new(),
        }
    }

    /// Write one entry: raw-deflate at zlib's default level (6), exactly as
    /// CPython's `_ZipWriteFile` compresses with `zlib.compressobj(-1, ...)`.
    pub(crate) fn add(&mut self, name: &str, data: &[u8]) {
        let mut compressor =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        compressor.write_all(data).expect("in-memory deflate");
        let compressed = compressor.finish().expect("in-memory deflate");
        let offset = self.buffer.len() as u32;
        let crc = crc32(data);
        let entry = Entry {
            name: name.to_string(),
            crc,
            compressed,
            uncompressed_size: data.len() as u32,
            method: 8,
            dos_time: self.dos_time,
            dos_date: self.dos_date,
            offset,
        };
        // Local file header (PK\x03\x04), version 20, no flags.
        self.buffer.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]);
        self.buffer.extend_from_slice(&20u16.to_le_bytes());
        self.buffer.extend_from_slice(&0u16.to_le_bytes());
        self.buffer.extend_from_slice(&entry.method.to_le_bytes());
        self.buffer.extend_from_slice(&entry.dos_time.to_le_bytes());
        self.buffer.extend_from_slice(&entry.dos_date.to_le_bytes());
        self.buffer.extend_from_slice(&entry.crc.to_le_bytes());
        self.buffer
            .extend_from_slice(&(entry.compressed.len() as u32).to_le_bytes());
        self.buffer
            .extend_from_slice(&entry.uncompressed_size.to_le_bytes());
        self.buffer
            .extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        self.buffer.extend_from_slice(&0u16.to_le_bytes()); // extra len
        self.buffer.extend_from_slice(entry.name.as_bytes());
        self.buffer.extend_from_slice(&entry.compressed);
        self.entries.push(entry);
    }

    /// Append the central directory and end record; returns the archive.
    pub(crate) fn finish(mut self) -> Vec<u8> {
        let cd_offset = self.buffer.len() as u32;
        let mut cd_size = 0u32;
        for entry in &self.entries {
            let record_len = 46 + entry.name.len() as u32;
            cd_size += record_len;
            self.buffer.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]);
            self.buffer.extend_from_slice(&0x0314u16.to_le_bytes()); // version made by: unix, 2.0
            self.buffer.extend_from_slice(&20u16.to_le_bytes()); // version needed
            self.buffer.extend_from_slice(&0u16.to_le_bytes()); // flags
            self.buffer.extend_from_slice(&entry.method.to_le_bytes());
            self.buffer.extend_from_slice(&entry.dos_time.to_le_bytes());
            self.buffer.extend_from_slice(&entry.dos_date.to_le_bytes());
            self.buffer.extend_from_slice(&entry.crc.to_le_bytes());
            self.buffer
                .extend_from_slice(&(entry.compressed.len() as u32).to_le_bytes());
            self.buffer
                .extend_from_slice(&entry.uncompressed_size.to_le_bytes());
            self.buffer
                .extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            self.buffer.extend_from_slice(&0u16.to_le_bytes()); // extra
            self.buffer.extend_from_slice(&0u16.to_le_bytes()); // comment
            self.buffer.extend_from_slice(&0u16.to_le_bytes()); // disk number
            self.buffer.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            self.buffer
                .extend_from_slice(&(0o600u32 << 16).to_le_bytes()); // external attrs
            self.buffer.extend_from_slice(&entry.offset.to_le_bytes());
            self.buffer.extend_from_slice(entry.name.as_bytes());
        }
        // End of central directory (PK\x05\x06).
        self.buffer.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        self.buffer.extend_from_slice(&0u16.to_le_bytes());
        self.buffer.extend_from_slice(&0u16.to_le_bytes());
        self.buffer
            .extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        self.buffer
            .extend_from_slice(&(self.entries.len() as u16).to_le_bytes());
        self.buffer.extend_from_slice(&cd_size.to_le_bytes());
        self.buffer.extend_from_slice(&cd_offset.to_le_bytes());
        self.buffer.extend_from_slice(&0u16.to_le_bytes()); // comment len
        self.buffer
    }
}

/// CRC-32 (IEEE), matching `zlib.crc32`.
fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc = table[((crc ^ *byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc32_matches_reference_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn package_round_trips_through_zip_reader() {
        let mut package = ZipPackage::new(
            chrono::NaiveDate::from_ymd_opt(2026, 9, 11)
                .unwrap()
                .and_hms_opt(16, 43, 50)
                .unwrap(),
        );
        package.add("a.txt", b"hello world hello world");
        let bytes = package.finish();
        // Local header sanity: signature, method 8, name.
        assert_eq!(&bytes[..4], &[0x50, 0x4b, 0x03, 0x04]);
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 8);
        assert_eq!(&bytes[30..35], b"a.txt");
        // EOCD present.
        assert!(
            bytes
                .windows(4)
                .rev()
                .any(|w| w == [0x50, 0x4b, 0x05, 0x06])
        );
    }
}
