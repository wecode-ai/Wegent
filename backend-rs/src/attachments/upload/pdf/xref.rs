// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cross-reference reading: classic `xref` tables, cross-reference streams,
//! and object streams (PyPDF2 `_reader`'s xref handling). Each entry records
//! where the object's bytes live, so `Document::load` can materialize both
//! plain and compressed objects.
use std::collections::HashMap;

use super::object::{Cursor, Dictionary, Object, Stream, decoded_stream_data};

#[derive(Debug, Clone, Copy)]
pub(crate) enum Entry {
    /// The object starts at this byte offset.
    InFile(usize),
    /// The object is entry `index` of object stream `stream`.
    InStream { stream: u32, index: u32 },
}

pub(crate) struct Xref {
    pub entries: HashMap<u32, Entry>,
    pub trailer: Dictionary,
}

/// Read every cross-reference section reachable from the last `startxref`.
pub(crate) fn read(bytes: &[u8]) -> Result<Xref, String> {
    let start = find_last_startxref(bytes).ok_or("missing startxref")?;
    let mut pending = vec![start];
    let mut entries = HashMap::new();
    let mut trailer = Dictionary::new();
    let mut visited = Vec::new();
    while let Some(offset) = pending.pop() {
        if visited.contains(&offset) || offset >= bytes.len() {
            continue;
        }
        visited.push(offset);
        let mut cursor = Cursor::at(bytes, offset);
        cursor.skip_whitespace();
        let section = if cursor.match_keyword("xref") {
            parse_classic_section(cursor, &mut entries)?
        } else {
            parse_stream_section(bytes, offset, &mut entries)?
        };
        let next = section_next(&section);
        merge_trailer(&mut trailer, section);
        pending.extend(next);
    }
    if entries.is_empty() {
        return Err("empty cross-reference table".to_owned());
    }
    Ok(Xref { entries, trailer })
}

fn merge_trailer(trailer: &mut Dictionary, section: Dictionary) {
    for (key, value) in section {
        trailer.entry(key).or_insert(value);
    }
}

/// A trailer may carry `/XRefStm` (hybrid files) and/or `/Prev`.
fn section_next(trailer: &Dictionary) -> Vec<usize> {
    let mut next = Vec::new();
    for key in ["/XRefStm", "/Prev"] {
        if let Some(Object::Integer(offset)) = trailer.get(key)
            && *offset >= 0
        {
            next.push(*offset as usize);
        }
    }
    next
}

fn parse_classic_section(
    mut cursor: Cursor<'_>,
    entries: &mut HashMap<u32, Entry>,
) -> Result<Dictionary, String> {
    loop {
        cursor.skip_whitespace();
        if cursor.match_keyword("trailer") {
            cursor.skip_whitespace();
            let Object::Dictionary(section) = cursor.parse_object()? else {
                return Err("invalid trailer dictionary".to_owned());
            };
            return Ok(section);
        }
        let first = cursor.read_integer()?;
        let count = cursor.read_integer()?;
        if !(0..=1_000_000).contains(&count) {
            return Err("invalid cross-reference subsection".to_owned());
        }
        for index in 0..count {
            let object_offset = cursor.read_integer()?;
            let _generation = cursor.read_integer()?;
            cursor.skip_whitespace();
            let kind = cursor.next().ok_or("truncated cross-reference entry")?;
            if kind == b'n' && object_offset > 0 {
                entries
                    .entry((first + index) as u32)
                    .or_insert(Entry::InFile(object_offset as usize));
            }
        }
    }
}

/// A section at `startxref` that is itself an indirect stream object
/// (`/Type /XRef`).
fn parse_stream_section(
    bytes: &[u8],
    offset: usize,
    entries: &mut HashMap<u32, Entry>,
) -> Result<Dictionary, String> {
    let object = parse_indirect(bytes, offset, &HashMap::new())?;
    let Object::Stream(stream) = object else {
        return Err("unsupported cross-reference section".to_owned());
    };
    if stream.dict.get("/Type") != Some(&Object::Name("/XRef".to_owned())) {
        return Err("unsupported cross-reference section".to_owned());
    }
    for (number, entry) in parse_xref_stream(&stream)? {
        entries.entry(number).or_insert(entry);
    }
    Ok(stream.dict)
}

/// `/W [w1 w2 w3]` entries with `/Index` (default `[0 Size]`).
fn parse_xref_stream(stream: &Stream) -> Result<Vec<(u32, Entry)>, String> {
    let data = decoded_stream_data(&stream.dict, &stream.data)?;
    let widths: Vec<usize> = match stream.dict.get("/W") {
        Some(Object::Array(items)) => items
            .iter()
            .map(|item| match item {
                Object::Integer(value) if *value >= 0 => Ok(*value as usize),
                _ => Err("invalid /W entry".to_owned()),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err("missing /W in cross-reference stream".to_owned()),
    };
    if widths.len() != 3 {
        return Err("invalid /W in cross-reference stream".to_owned());
    }
    let size = match stream.dict.get("/Size") {
        Some(Object::Integer(value)) if *value >= 0 => *value as usize,
        _ => return Err("missing /Size in cross-reference stream".to_owned()),
    };
    let index: Vec<usize> = match stream.dict.get("/Index") {
        Some(Object::Array(items)) => items
            .iter()
            .map(|item| match item {
                Object::Integer(value) if *value >= 0 => Ok(*value as usize),
                _ => Err("invalid /Index entry".to_owned()),
            })
            .collect::<Result<_, _>>()?,
        _ => vec![0, size],
    };
    let entry_size: usize = widths.iter().sum();
    if entry_size == 0 {
        return Err("invalid /W in cross-reference stream".to_owned());
    }
    let mut entries = Vec::new();
    let mut position = 0usize;
    for pair in index.chunks(2) {
        let (Some(&first), Some(&count)) = (pair.first(), pair.get(1)) else {
            return Err("invalid /Index in cross-reference stream".to_owned());
        };
        for item in 0..count {
            if position + entry_size > data.len() {
                return Err("truncated cross-reference stream".to_owned());
            }
            let kind = read_width(&data[position..], widths[0]);
            let field2 = read_width(&data[position + widths[0]..], widths[1]);
            let field3 = read_width(&data[position + widths[0] + widths[1]..], widths[2]);
            position += entry_size;
            let number = (first + item) as u32;
            match kind {
                0 => {}
                1 => {
                    entries.push((number, Entry::InFile(field2 as usize)));
                }
                2 => entries.push((
                    number,
                    Entry::InStream {
                        stream: field2 as u32,
                        index: field3 as u32,
                    },
                )),
                _ => {}
            }
        }
    }
    Ok(entries)
}

fn read_width(bytes: &[u8], width: usize) -> u64 {
    bytes
        .iter()
        .take(width)
        .fold(0u64, |value, &byte| value << 8 | u64::from(byte))
}

fn find_last_startxref(bytes: &[u8]) -> Option<usize> {
    let marker = b"startxref";
    let mut index = bytes.len().saturating_sub(marker.len());
    loop {
        if &bytes[index..index + marker.len()] == marker {
            let mut cursor = Cursor::at(bytes, index + marker.len());
            if let Ok(value) = cursor.read_integer() {
                return Some(value as usize);
            }
            return None;
        }
        if index == 0 {
            return None;
        }
        index -= 1;
    }
}

/// Parse `number generation obj ... endobj` at a byte offset.
pub(crate) fn parse_indirect(
    bytes: &[u8],
    offset: usize,
    offsets: &HashMap<u32, usize>,
) -> Result<Object, String> {
    if offset >= bytes.len() {
        return Err("object offset past end of file".to_owned());
    }
    let mut cursor = Cursor::at(bytes, offset);
    cursor.skip_whitespace();
    let _number = cursor.read_integer()?;
    let _generation = cursor.read_integer()?;
    cursor.skip_whitespace();
    if !cursor.match_keyword("obj") {
        return Err("missing obj keyword".to_owned());
    }
    let object = cursor.parse_object()?;
    let Object::Dictionary(dict) = object else {
        return Ok(object);
    };
    cursor.skip_whitespace();
    if !cursor.match_keyword("stream") {
        return Ok(Object::Dictionary(dict));
    }
    match cursor.next() {
        Some(b'\r') => {
            if cursor.peek() == Some(b'\n') {
                cursor.next();
            }
        }
        Some(b'\n') => {}
        _ => return Err("invalid stream start".to_owned()),
    }
    let data_start = cursor.position();
    let length = match dict.get("/Length") {
        Some(Object::Integer(length)) if *length >= 0 => Some(*length as usize),
        Some(Object::Reference(number)) => offsets
            .get(number)
            .and_then(|offset| parse_direct_integer(bytes, *offset)),
        _ => None,
    };
    let data = match length {
        Some(length) if data_start + length <= bytes.len() => {
            bytes[data_start..data_start + length].to_vec()
        }
        _ => {
            let mut end = find_endstream(bytes, data_start).ok_or("missing endstream")?;
            if end > data_start && bytes[end - 1] == b'\n' {
                end -= 1;
            }
            if end > data_start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            bytes[data_start..end].to_vec()
        }
    };
    Ok(Object::Stream(Stream { dict, data }))
}

fn parse_direct_integer(bytes: &[u8], offset: usize) -> Option<usize> {
    let mut cursor = Cursor::at(bytes, offset);
    cursor.skip_whitespace();
    let _number = cursor.read_integer().ok()?;
    let _generation = cursor.read_integer().ok()?;
    cursor.skip_whitespace();
    if !cursor.match_keyword("obj") {
        return None;
    }
    let value = cursor.read_integer().ok()?;
    if value < 0 {
        return None;
    }
    Some(value as usize)
}

fn find_endstream(bytes: &[u8], start: usize) -> Option<usize> {
    let marker = b"endstream";
    let mut index = start;
    while index + marker.len() <= bytes.len() {
        if &bytes[index..index + marker.len()] == marker {
            return Some(index);
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn width_fields_decode_big_endian_entries() {
        assert_eq!(read_width(&[0x00, 0x00, 0x2A], 3), 42);
        assert_eq!(read_width(&[0xFF], 1), 255);
    }
}
