// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The PKZIP reader the OOXML attachment parsers need.
//!
//! `python-docx`, `openpyxl` and the source's `zipfile`-based archive listing
//! all read the same container, so the port has to open it the same way: the
//! central directory is the authoritative index, entries are stored or
//! raw-deflated, and the entry order is the order the writer used. ZIP64 and
//! encryption are not produced by these writers; a package that uses them is
//! reported as unreadable, which the source surfaces as a `parse_failed`
//! document error.
use std::collections::HashMap;

use flate2::read::DeflateDecoder;
use std::io::Read;

/// The `PK\x03\x04`, `PK\x01\x02` and `PK\x05\x06` record signatures.
const LOCAL_FILE_HEADER: u32 = 0x0403_4b50;
const CENTRAL_DIRECTORY_HEADER: u32 = 0x0201_4b50;
const END_OF_CENTRAL_DIRECTORY: u32 = 0x0605_4b50;
const EOCD_MIN_LEN: usize = 22;
const EOCD_MAX_COMMENT: usize = 0xffff;
/// The ZIP64 sentinel in a 32-bit field.
const ZIP64_SENTINEL: u32 = 0xffff_ffff;

const METHOD_STORED: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

/// A container that could not be read.
#[derive(Debug)]
pub(crate) struct ZipError;

struct Entry {
    name: String,
    method: u16,
    compressed_size: usize,
    local_header_offset: usize,
}

/// An in-memory ZIP archive; `read` decompresses one entry at a time.
pub(crate) struct ZipArchive<'a> {
    data: &'a [u8],
    /// Entries in central-directory order, the order `zipfile.namelist` keeps.
    entries: Vec<Entry>,
    index: HashMap<String, usize>,
}

impl<'a> ZipArchive<'a> {
    /// Index the archive from its central directory.
    pub(crate) fn new(data: &'a [u8]) -> Result<Self, ZipError> {
        let eocd = find_end_of_central_directory(data).ok_or(ZipError)?;
        let entry_count = read_u16(data, eocd + 10)? as usize;
        let directory_offset = read_u32(data, eocd + 16)? as usize;
        if directory_offset == ZIP64_SENTINEL as usize {
            return Err(ZipError);
        }

        let mut entries = Vec::with_capacity(entry_count);
        let mut index = HashMap::with_capacity(entry_count);
        let mut cursor = directory_offset;
        for position in 0..entry_count {
            if read_u32(data, cursor)? != CENTRAL_DIRECTORY_HEADER {
                return Err(ZipError);
            }
            let method = read_u16(data, cursor + 10)?;
            let compressed_size = read_u32(data, cursor + 20)? as usize;
            let name_len = read_u16(data, cursor + 28)? as usize;
            let extra_len = read_u16(data, cursor + 30)? as usize;
            let comment_len = read_u16(data, cursor + 32)? as usize;
            let local_header_offset = read_u32(data, cursor + 42)? as usize;
            if compressed_size == ZIP64_SENTINEL as usize
                || local_header_offset == ZIP64_SENTINEL as usize
            {
                return Err(ZipError);
            }
            let name_bytes = data
                .get(cursor + 46..cursor + 46 + name_len)
                .ok_or(ZipError)?;
            let name = std::str::from_utf8(name_bytes)
                .map_err(|_| ZipError)?
                .to_string();
            index.insert(name.clone(), position);
            entries.push(Entry {
                name,
                method,
                compressed_size,
                local_header_offset,
            });
            cursor = cursor + 46 + name_len + extra_len + comment_len;
        }
        Ok(Self {
            data,
            entries,
            index,
        })
    }

    /// The entry names in archive order.
    pub(crate) fn names(&self) -> Vec<&str> {
        self.entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    /// The decompressed payload of one entry.
    pub(crate) fn read(&self, name: &str) -> Result<Vec<u8>, ZipError> {
        let entry = self
            .index
            .get(name)
            .map(|position| &self.entries[*position])
            .ok_or(ZipError)?;
        let data_offset = self.entry_data_offset(entry)?;
        let end = data_offset
            .checked_add(entry.compressed_size)
            .ok_or(ZipError)?;
        let compressed = self.data.get(data_offset..end).ok_or(ZipError)?;
        match entry.method {
            METHOD_STORED => Ok(compressed.to_vec()),
            METHOD_DEFLATE => {
                let mut decoded = Vec::new();
                let mut decoder = DeflateDecoder::new(compressed);
                decoder.read_to_end(&mut decoded).map_err(|_| ZipError)?;
                Ok(decoded)
            }
            _ => Err(ZipError),
        }
    }

    /// The payload offset: the local header repeats the name and extra fields.
    fn entry_data_offset(&self, entry: &Entry) -> Result<usize, ZipError> {
        let cursor = entry.local_header_offset;
        if read_u32(self.data, cursor)? != LOCAL_FILE_HEADER {
            return Err(ZipError);
        }
        let name_len = read_u16(self.data, cursor + 26)? as usize;
        let extra_len = read_u16(self.data, cursor + 28)? as usize;
        Ok(cursor + 30 + name_len + extra_len)
    }
}

/// Locate the end-of-central-directory record: it sits after the directory and
/// may be followed by a comment of up to 64 KiB.
fn find_end_of_central_directory(data: &[u8]) -> Option<usize> {
    if data.len() < EOCD_MIN_LEN {
        return None;
    }
    let lowest = data.len().saturating_sub(EOCD_MIN_LEN + EOCD_MAX_COMMENT);
    for offset in (lowest..=data.len() - EOCD_MIN_LEN).rev() {
        if read_u32(data, offset).ok()? == END_OF_CENTRAL_DIRECTORY {
            return Some(offset);
        }
    }
    None
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16, ZipError> {
    let bytes = data.get(offset..offset + 2).ok_or(ZipError)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32, ZipError> {
    let bytes = data.get(offset..offset + 4).ok_or(ZipError)?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

#[cfg(test)]
fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// Build a stored-method archive from named payloads, for parser fixtures.
#[cfg(test)]
pub(crate) fn stored_archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, payload) in entries {
        let offset = out.len();
        write_local_header(&mut out, name, payload.len(), METHOD_STORED);
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(payload);
        write_central_header(
            &mut central,
            name,
            payload.len(),
            payload.len(),
            METHOD_STORED,
            offset,
        );
    }
    let directory_offset = out.len();
    out.extend_from_slice(&central);
    push_u32(&mut out, END_OF_CENTRAL_DIRECTORY);
    push_u16(&mut out, 0);
    push_u16(&mut out, 0);
    push_u16(&mut out, entries.len() as u16);
    push_u16(&mut out, entries.len() as u16);
    push_u32(&mut out, central.len() as u32);
    push_u32(&mut out, directory_offset as u32);
    push_u16(&mut out, 0);
    out
}

#[cfg(test)]
fn write_local_header(out: &mut Vec<u8>, name: &str, stored_len: usize, method: u16) {
    push_u32(out, LOCAL_FILE_HEADER);
    push_u16(out, 20);
    push_u16(out, 0);
    push_u16(out, method);
    push_u16(out, 0);
    push_u16(out, 0);
    push_u32(out, 0);
    push_u32(out, stored_len as u32);
    push_u32(out, stored_len as u32);
    push_u16(out, name.len() as u16);
    push_u16(out, 0);
}

#[cfg(test)]
fn write_central_header(
    out: &mut Vec<u8>,
    name: &str,
    stored_len: usize,
    original_len: usize,
    method: u16,
    offset: usize,
) {
    push_u32(out, CENTRAL_DIRECTORY_HEADER);
    push_u16(out, 20);
    push_u16(out, 20);
    push_u16(out, 0);
    push_u16(out, method);
    push_u16(out, 0);
    push_u16(out, 0);
    push_u32(out, 0);
    push_u32(out, stored_len as u32);
    push_u32(out, original_len as u32);
    push_u16(out, name.len() as u16);
    push_u16(out, 0);
    push_u16(out, 0);
    push_u16(out, 0);
    push_u16(out, 0);
    push_u32(out, 0);
    push_u32(out, offset as u32);
    out.extend_from_slice(name.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal deflate-compressed archive holding one stored and one
    /// deflated entry, written with the record layout `zipfile` produces.
    fn sample_archive() -> Vec<u8> {
        let stored = b"hello";
        let plain = b"deflated payload";
        let mut compressed = Vec::new();
        {
            use flate2::write::DeflateEncoder;
            use std::io::Write;
            let mut encoder = DeflateEncoder::new(&mut compressed, flate2::Compression::default());
            encoder.write_all(plain).unwrap();
            encoder.finish().unwrap();
        }

        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, method, payload, original_len) in [
            ("stored.txt", METHOD_STORED, stored.to_vec(), stored.len()),
            (
                "deflated.txt",
                METHOD_DEFLATE,
                compressed.clone(),
                plain.len(),
            ),
        ] {
            let offset = out.len();
            write_local_header(&mut out, name, payload.len(), method);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&payload);
            write_central_header(
                &mut central,
                name,
                payload.len(),
                original_len,
                method,
                offset,
            );
        }
        let directory_offset = out.len();
        out.extend_from_slice(&central);
        push_u32(&mut out, END_OF_CENTRAL_DIRECTORY);
        push_u16(&mut out, 0);
        push_u16(&mut out, 0);
        push_u16(&mut out, 2);
        push_u16(&mut out, 2);
        push_u32(&mut out, central.len() as u32);
        push_u32(&mut out, directory_offset as u32);
        push_u16(&mut out, 0);
        out
    }

    #[test]
    fn stored_and_deflated_entries_are_read_back() {
        let archive = sample_archive();
        let zip = ZipArchive::new(&archive).expect("archive opens");
        assert_eq!(zip.names(), vec!["stored.txt", "deflated.txt"]);
        assert_eq!(zip.read("stored.txt").unwrap(), b"hello");
        assert_eq!(zip.read("deflated.txt").unwrap(), b"deflated payload");
        assert!(zip.read("missing.txt").is_err());
    }

    #[test]
    fn entry_names_keep_archive_order() {
        let archive = stored_archive(&[("b.txt", b"1"), ("a.txt", b"2"), ("c/", b"")]);
        let zip = ZipArchive::new(&archive).expect("archive opens");
        assert_eq!(zip.names(), vec!["b.txt", "a.txt", "c/"]);
    }

    #[test]
    fn a_body_without_an_end_record_is_rejected() {
        assert!(ZipArchive::new(b"not an archive").is_err());
    }
}
