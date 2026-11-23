// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Font character maps (`PyPDF2._cmap.build_char_map`). A content stream's
//! `Tj` operands are byte strings; this module turns each font's `/Encoding`,
//! `/ToUnicode` CMap, and widths into the character and space-width decisions
//! the extractor makes.
use std::collections::HashMap;

use super::charsets::{Charset, default_font_space_width};
use super::object::{Cursor, Dictionary, Document, Object};

/// `extract_text(space_width=200)`'s default.
const DEFAULT_SPACE_WIDTH: f64 = 200.0;

/// How a byte string becomes text before the `/ToUnicode` override.
pub(crate) enum Encoding {
    Codec(Codec),
    Table {
        charset: Charset,
        overrides: HashMap<u32, String>,
    },
    /// `parse_encoding` returned the empty string; `build_char_map` resolves it
    /// from the CMap's code length.
    Empty,
}

pub(crate) enum Codec {
    /// Python's `charmap` codec: one Unicode scalar per byte.
    Charmap,
    Utf16Be,
    /// A codec name this port cannot decode; the source would use the named
    /// Python codec.
    Other,
}

/// A `/ToUnicode` CMap keyed by the numeric character code.
pub(crate) struct ToUnicode {
    pub code_bytes: usize,
    pub map: HashMap<u32, String>,
}

pub(crate) struct FontCharMap {
    /// `build_char_map`'s `sp_width / 2` (`_space_width`).
    pub space_width: f64,
    pub encoding: Encoding,
    pub to_unicode: ToUnicode,
}

/// The second value `parse_encoding` reports: a space character code, or a
/// standard-font space width when the fallback branch returned it directly.
enum SpaceBase {
    Code(i64),
    Width(f64),
}

/// `build_char_map`.
pub(crate) fn build(doc: &Document, font: &Dictionary) -> Result<FontCharMap, String> {
    let (encoding, space_base) = parse_encoding(doc, font)?;
    let initial_space_code = match space_base {
        SpaceBase::Code(code) => code,
        SpaceBase::Width(width) => width as i64,
    };
    let (to_unicode, space_code) = parse_to_unicode(doc, font, initial_space_code)?;
    let encoding = match encoding {
        Encoding::Empty => {
            if to_unicode.code_bytes <= 1 {
                Encoding::Codec(Codec::Charmap)
            } else {
                Encoding::Codec(Codec::Utf16Be)
            }
        }
        Encoding::Table {
            charset,
            mut overrides,
        } => {
            // PDF 1.7 §5.9.1: when the CMap covers a code, the byte-decoding
            // table is discarded for it, so the ToUnicode lookup sees the raw
            // character code.
            for code in to_unicode.map.keys() {
                if *code <= 255 {
                    overrides.insert(*code, char::from(*code as u8).to_string());
                }
            }
            Encoding::Table { charset, overrides }
        }
        other => other,
    };
    let default_space_width = doc
        .get(font, "/BaseFont")
        .and_then(|object| doc.name(object))
        .and_then(default_font_space_width)
        .unwrap_or(DEFAULT_SPACE_WIDTH);
    let space_width = compute_space_width(doc, font, space_code, default_space_width)?;
    Ok(FontCharMap {
        space_width: space_width / 2.0,
        encoding,
        to_unicode,
    })
}

impl FontCharMap {
    /// Decode one `Tj` operand: the font encoding, then the `/ToUnicode`
    /// override for every produced character.
    pub(crate) fn decode(&self, bytes: &[u8]) -> String {
        let intermediate = match &self.encoding {
            Encoding::Codec(Codec::Charmap) => bytes.iter().map(|&byte| u32::from(byte)).collect(),
            Encoding::Codec(Codec::Utf16Be) => utf16_code_points(bytes),
            Encoding::Codec(Codec::Other) => bytes.iter().map(|&byte| u32::from(byte)).collect(),
            Encoding::Table { charset, overrides } => {
                let table = charset.table();
                let mut points = Vec::new();
                for &byte in bytes {
                    let code = u32::from(byte);
                    match overrides.get(&code) {
                        Some(value) => points.extend(value.chars().map(u32::from)),
                        None => points.push(u32::from(table[usize::from(byte)])),
                    }
                }
                points
            }
            Encoding::Empty => unreachable!("empty encodings are resolved in build"),
        };
        let mut text = String::new();
        for point in intermediate {
            match self.to_unicode.map.get(&point) {
                Some(value) => text.push_str(value),
                None => {
                    if let Some(character) = char::from_u32(point) {
                        text.push(character);
                    }
                }
            }
        }
        text
    }
}

/// `utf-16-be` decoding with Python's `surrogatepass`: a surrogate pair is one
/// scalar, and an odd byte count falls back to `charmap` as the source's
/// `Tj` handler does.
fn utf16_code_points(bytes: &[u8]) -> Vec<u32> {
    if !bytes.len().is_multiple_of(2) {
        return bytes.iter().map(|&byte| u32::from(byte)).collect();
    }
    let mut points = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        let unit = u16::from(bytes[index]) << 8 | u16::from(bytes[index + 1]);
        if (0xD800..=0xDBFF).contains(&unit)
            && index + 3 < bytes.len()
            && (0xDC00..=0xDFFF)
                .contains(&(u16::from(bytes[index + 2]) << 8 | u16::from(bytes[index + 3])))
        {
            let low = u16::from(bytes[index + 2]) << 8 | u16::from(bytes[index + 3]);
            let combined =
                0x1_0000 + (u32::from(unit) - 0xD800) * 0x400 + (u32::from(low) - 0xDC00);
            points.push(combined);
            index += 4;
        } else {
            points.push(u32::from(unit));
            index += 2;
        }
    }
    points
}

/// `parse_encoding`.
fn parse_encoding(doc: &Document, font: &Dictionary) -> Result<(Encoding, SpaceBase), String> {
    let Some(encoding_object) = doc.get(font, "/Encoding") else {
        let fallback = || -> (Encoding, SpaceBase) {
            let subtype = doc
                .get(font, "/Subtype")
                .and_then(|object| doc.name(object))
                .unwrap_or("");
            if subtype == "/Type1" {
                (Encoding::Codec(Codec::Charmap), SpaceBase::Code(32))
            } else {
                (Encoding::Empty, SpaceBase::Code(32))
            }
        };
        let Some(base_font) = doc
            .get(font, "/BaseFont")
            .and_then(|object| doc.name(object))
        else {
            return Ok(fallback());
        };
        let Some(width) = default_font_space_width(base_font) else {
            return Ok(fallback());
        };
        let encoding = match Charset::from_name(base_font) {
            Some(charset) => Encoding::Table {
                charset,
                overrides: HashMap::new(),
            },
            None => Encoding::Codec(Codec::Charmap),
        };
        return Ok((encoding, SpaceBase::Width(width)));
    };
    let mut encoding = match doc.resolve(encoding_object) {
        Object::Name(name) => {
            if let Some(charset) = Charset::from_name(name) {
                Encoding::Table {
                    charset,
                    overrides: HashMap::new(),
                }
            } else if let Some(codec) = predefined_cmap(name) {
                Encoding::Codec(codec)
            } else {
                Encoding::Codec(Codec::Other)
            }
        }
        Object::Dictionary(dict) => {
            let charset = dict
                .get("/BaseEncoding")
                .and_then(|object| doc.name(object))
                .and_then(Charset::from_name)
                .unwrap_or(Charset::Standard);
            Encoding::Table {
                charset,
                overrides: HashMap::new(),
            }
        }
        _ => Encoding::Table {
            charset: Charset::Standard,
            overrides: HashMap::new(),
        },
    };
    if let (Object::Dictionary(dict), Encoding::Table { overrides, .. }) =
        (doc.resolve(encoding_object), &mut encoding)
        && let Some(differences) = dict.get("/Differences")
        && let Object::Array(entries) = doc.resolve(differences)
    {
        let mut code = 0u32;
        for entry in entries {
            match doc.resolve(entry) {
                Object::Integer(value) if *value >= 0 => code = *value as u32,
                Object::Name(name) => {
                    // `adobe_glyphs` maps standard glyph names to
                    // Unicode; a name outside that table stays as
                    // written, which is the source's fallback too.
                    overrides.insert(code, name.clone());
                    code += 1;
                }
                _ => {}
            }
        }
    }
    Ok((encoding, SpaceBase::Code(32)))
}

fn predefined_cmap(name: &str) -> Option<Codec> {
    match name {
        "/Identity-H" | "/Identity-V" => Some(Codec::Utf16Be),
        "/GB-EUC-H" | "/GB-EUC-V" | "/GBpc-EUC-H" | "/GBpc-EUC-V" => Some(Codec::Other),
        _ => None,
    }
}

/// `parse_to_unicode`: returns the map and the updated space code.
fn parse_to_unicode(
    doc: &Document,
    font: &Dictionary,
    mut space_code: i64,
) -> Result<(ToUnicode, i64), String> {
    let Some(to_unicode) = doc.get(font, "/ToUnicode") else {
        return Ok((
            ToUnicode {
                code_bytes: 0,
                map: HashMap::new(),
            },
            space_code,
        ));
    };
    let data = match doc.resolve(to_unicode) {
        Object::Stream(stream) => doc.decoded_stream(stream)?,
        Object::Name(name) if name.starts_with("/Identity") => {
            // `prepare_cm`'s synthesized Identity range.
            let mut map = HashMap::new();
            map.insert(0u32, "\u{0}".to_owned());
            map.insert(1u32, "\u{1}".to_owned());
            return Ok((ToUnicode { code_bytes: 2, map }, space_code));
        }
        _ => {
            return Ok((
                ToUnicode {
                    code_bytes: 0,
                    map: HashMap::new(),
                },
                space_code,
            ));
        }
    };
    let to_unicode = parse_cmap_stream(&data)?;
    for (code, value) in &to_unicode.map {
        if value == " " {
            space_code = i64::from(*code);
        }
    }
    Ok((to_unicode, space_code))
}

#[derive(Debug, PartialEq)]
enum Token {
    Hex(Vec<u8>),
    Word(String),
    OpenArray,
    CloseArray,
}

fn tokenize(data: &[u8]) -> Vec<Token> {
    let mut cursor = Cursor::new(data);
    let mut tokens = Vec::new();
    loop {
        cursor.skip_whitespace();
        match cursor.peek() {
            None => break,
            Some(b'<') if cursor.starts_with(b"<<") => {
                cursor.advance(2);
                tokens.push(Token::Word("<<".to_owned()));
            }
            Some(b'>') if cursor.starts_with(b">>") => {
                cursor.advance(2);
                tokens.push(Token::Word(">>".to_owned()));
            }
            Some(b'<') => {
                let mut digits = Vec::new();
                cursor.next();
                while let Some(byte) = cursor.next() {
                    if byte == b'>' {
                        break;
                    }
                    digits.push(byte);
                }
                tokens.push(Token::Hex(decode_hex(&digits)));
            }
            Some(b'[') => {
                cursor.next();
                tokens.push(Token::OpenArray);
            }
            Some(b']') => {
                cursor.next();
                tokens.push(Token::CloseArray);
            }
            Some(_) => {
                let mut word = String::new();
                while let Some(byte) = cursor.peek() {
                    if byte.is_ascii_whitespace() || matches!(byte, b'<' | b'>' | b'[' | b']') {
                        break;
                    }
                    word.push(char::from(byte));
                    cursor.next();
                }
                tokens.push(Token::Word(word));
            }
        }
    }
    tokens
}

fn decode_hex(digits: &[u8]) -> Vec<u8> {
    let mut digits: Vec<u8> = digits
        .iter()
        .copied()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if !digits.len().is_multiple_of(2) {
        digits.push(b'0');
    }
    digits
        .chunks(2)
        .map(|pair| (hex_digit(pair[0]) << 4) | hex_digit(pair[1]))
        .collect()
}

fn hex_digit(byte: u8) -> u8 {
    match byte {
        b'0'..=b'9' => byte - b'0',
        b'a'..=b'f' => byte - b'a' + 10,
        b'A'..=b'F' => byte - b'A' + 10,
        _ => 0,
    }
}

fn parse_cmap_stream(data: &[u8]) -> Result<ToUnicode, String> {
    let tokens = tokenize(data);
    let mut map = HashMap::new();
    let mut code_bytes = 0usize;
    let mut index = 0usize;
    while index < tokens.len() {
        match &tokens[index] {
            Token::Word(word) if word == "beginbfchar" => {
                index += 1;
                while index < tokens.len() {
                    if matches!(&tokens[index], Token::Word(word) if word == "endbfchar") {
                        index += 1;
                        break;
                    }
                    let Token::Hex(source) = &tokens[index] else {
                        return Err("invalid bfchar source".to_owned());
                    };
                    index += 1;
                    let Some(destination) = tokens.get(index) else {
                        return Err("truncated bfchar".to_owned());
                    };
                    index += 1;
                    code_bytes = source.len();
                    map.insert(code_of(source), decode_bfchar_destination(destination));
                }
            }
            Token::Word(word) if word == "beginbfrange" => {
                index += 1;
                while index < tokens.len() {
                    if matches!(&tokens[index], Token::Word(word) if word == "endbfrange") {
                        index += 1;
                        break;
                    }
                    let Token::Hex(start) = &tokens[index] else {
                        return Err("invalid bfrange start".to_owned());
                    };
                    let Token::Hex(end) = tokens.get(index + 1).ok_or("truncated bfrange")? else {
                        return Err("invalid bfrange end".to_owned());
                    };
                    index += 2;
                    code_bytes = start.len();
                    let start_code = code_of(start);
                    let end_code = code_of(end);
                    match tokens.get(index) {
                        Some(Token::Hex(destination)) => {
                            index += 1;
                            let width = destination.len();
                            let mut value = big_endian_value(destination);
                            let mut code = start_code;
                            while code <= end_code {
                                map.insert(code, decode_utf16_be(&encode_value(value, width)));
                                code += 1;
                                value = value.saturating_add(1);
                            }
                        }
                        Some(Token::OpenArray) => {
                            index += 1;
                            let mut code = start_code;
                            while let Some(token) = tokens.get(index) {
                                if *token == Token::CloseArray {
                                    index += 1;
                                    break;
                                }
                                if let Token::Hex(destination) = token {
                                    map.insert(code, decode_utf16_be(destination));
                                    code += 1;
                                }
                                index += 1;
                            }
                        }
                        _ => return Err("invalid bfrange destination".to_owned()),
                    }
                }
            }
            _ => index += 1,
        }
    }
    Ok(ToUnicode { code_bytes, map })
}

fn code_of(bytes: &[u8]) -> u32 {
    bytes
        .iter()
        .fold(0u32, |value, &byte| value << 8 | u32::from(byte))
}

fn big_endian_value(bytes: &[u8]) -> u32 {
    code_of(bytes)
}

fn encode_value(value: u32, width: usize) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let start = 4usize.saturating_sub(width);
    bytes[start..].to_vec()
}

/// bfchar destinations below three hex digits decode as one `charmap` byte;
/// everything else is `utf-16-be`.
fn decode_bfchar_destination(token: &Token) -> String {
    match token {
        Token::Hex(bytes) if bytes.len() == 1 => String::from(char::from(bytes[0])),
        Token::Hex(bytes) => decode_utf16_be(bytes),
        Token::Word(word) if word == "." => String::new(),
        _ => String::new(),
    }
}

fn decode_utf16_be(bytes: &[u8]) -> String {
    if !bytes.len().is_multiple_of(2) {
        return bytes.iter().map(|&byte| char::from(byte)).collect();
    }
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|pair| u16::from(pair[0]) << 8 | u16::from(pair[1]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// `compute_space_width`.
fn compute_space_width(
    doc: &Document,
    font: &Dictionary,
    space_code: i64,
    default_space_width: f64,
) -> Result<f64, String> {
    let mut space_width = default_space_width * 2.0;
    if let Some(descendants) = doc.get(font, "/DescendantFonts") {
        let descendant = doc
            .array(descendants)
            .and_then(|items| items.first())
            .and_then(|object| doc.dict(object))
            .ok_or("invalid descendant font")?;
        let default_width = doc
            .get(descendant, "/DW")
            .and_then(|object| doc.number(object))
            .unwrap_or(1000.0);
        let mut widths: HashMap<i64, f64> = HashMap::new();
        widths.insert(-1, default_width);
        if let Some(entries) = doc.get(descendant, "/W")
            && let Object::Array(entries) = doc.resolve(entries)
        {
            let mut index = 0usize;
            while index + 1 < entries.len() {
                let start = doc.integer(&entries[index]).ok_or("invalid /W start")?;
                match doc.resolve(&entries[index + 1]) {
                    Object::Integer(end) => {
                        let width = match entries.get(index + 2) {
                            Some(value) => doc.number(value).ok_or("invalid /W width")?,
                            None => break,
                        };
                        for code in start..*end {
                            widths.insert(code, width);
                        }
                        index += 3;
                    }
                    Object::Array(list) => {
                        for (offset, value) in list.iter().enumerate() {
                            widths.insert(
                                start + offset as i64,
                                doc.number(value).ok_or("invalid /W width")?,
                            );
                        }
                        index += 2;
                    }
                    _ => break,
                }
            }
        }
        space_width = widths
            .get(&space_code)
            .copied()
            .unwrap_or(default_width / 2.0);
        return Ok(space_width);
    }
    if let Some(widths) = doc.get(font, "/Widths") {
        let Some(entries) = doc.array(widths) else {
            return Ok(space_width);
        };
        let first = doc
            .get(font, "/FirstChar")
            .and_then(|object| doc.integer(object));
        let last = doc
            .get(font, "/LastChar")
            .and_then(|object| doc.integer(object));
        let in_range = matches!((first, last), (Some(first), Some(last))
            if first <= space_code && space_code <= last);
        if in_range {
            let index = (space_code - first.unwrap()) as usize;
            if let Some(value) = entries.get(index).and_then(|object| doc.number(object))
                && value != 0.0
            {
                return Ok(value);
            }
        }
        if let Some(missing) = doc
            .get(font, "/FontDescriptor")
            .and_then(|object| doc.dict(object))
            .and_then(|descriptor| doc.get(descriptor, "/MissingWidth"))
            .and_then(|object| doc.number(object))
        {
            return Ok(missing);
        }
        let mut total = 0.0;
        let mut count = 0usize;
        for entry in entries {
            if let Some(value) = doc.number(entry)
                && value > 0.0
            {
                total += value;
                count += 1;
            }
        }
        space_width = total / count.max(1) as f64 / 2.0;
        return Ok(space_width);
    }
    Ok(space_width)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmap_bfchar_maps_one_and_two_byte_codes() {
        let cmap = parse_cmap_stream(
            b"begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
              2 beginbfchar\n<0001> <0020>\n<001B> <0049>\nendbfchar\nendcmap",
        )
        .unwrap();
        assert_eq!(cmap.code_bytes, 2);
        assert_eq!(cmap.map[&0x0001], " ");
        assert_eq!(cmap.map[&0x001B], "I");
    }

    #[test]
    fn cmap_bfrange_arrays_assign_sequential_codes() {
        let cmap = parse_cmap_stream(
            b"2 beginbfrange\n<01> <03> [<0041> <0042> <0043>]\n\
              <10> <11> <0061>\nendbfrange",
        )
        .unwrap();
        assert_eq!(cmap.map[&0x01], "A");
        assert_eq!(cmap.map[&0x03], "C");
        assert_eq!(cmap.map[&0x10], "a");
        assert_eq!(cmap.map[&0x11], "b");
    }

    #[test]
    fn identity_h_decodes_two_byte_codes() {
        let font = FontCharMap {
            space_width: 200.0,
            encoding: Encoding::Codec(Codec::Utf16Be),
            to_unicode: ToUnicode {
                code_bytes: 2,
                map: [(0x0DDEu32, "\u{4E00}".to_owned())].into_iter().collect(),
            },
        };
        assert_eq!(font.decode(&[0x0D, 0xDE]), "\u{4E00}");
    }

    #[test]
    fn single_byte_tables_apply_glyph_names_until_to_unicode_overrides() {
        let font = FontCharMap {
            space_width: 200.0,
            encoding: Encoding::Table {
                charset: Charset::Standard,
                overrides: [(0u32, "/g0".to_owned())].into_iter().collect(),
            },
            to_unicode: ToUnicode {
                code_bytes: 1,
                map: [(1u32, "\u{9}".to_owned())].into_iter().collect(),
            },
        };
        assert_eq!(font.decode(&[0, 1]), "/g0\t");
    }
}
