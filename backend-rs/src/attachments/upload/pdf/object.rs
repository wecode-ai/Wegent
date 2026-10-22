// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The PDF object grammar the attachment parser needs: the cross-reference
//! table, indirect objects, streams, and the direct objects a content stream
//! contains. This mirrors PyPDF2's `generic` readers for the well-formed
//! classic-xref documents `DocumentParser` handles; it deliberately omits
//! encryption, object streams, and incremental-update repair paths the source
//! library implements for arbitrary files.
use std::collections::{BTreeMap, HashMap};
use std::io::Read;

use super::xref;

/// A PDF object. Dictionary keys keep the leading `/` the source readers
/// retain (`NameObject`), so resource lookups compare the same strings.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Object {
    Null,
    Bool(bool),
    Integer(i64),
    Real(f64),
    Name(String),
    String(Vec<u8>),
    Array(Vec<Object>),
    Dictionary(Dictionary),
    Reference(u32),
    Stream(Stream),
}

/// A stream's dictionary plus its still-encoded bytes.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Stream {
    pub dict: Dictionary,
    pub data: Vec<u8>,
}

pub(crate) type Dictionary = BTreeMap<String, Object>;

fn is_whitespace(byte: u8) -> bool {
    matches!(byte, 0 | 9 | 10 | 12 | 13 | 32)
}

fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn is_regular(byte: u8) -> bool {
    !is_whitespace(byte) && !is_delimiter(byte)
}

/// A byte cursor over one PDF buffer.
pub(crate) struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub(crate) fn at(bytes: &'a [u8], pos: usize) -> Self {
        Self { bytes, pos }
    }

    pub(crate) fn position(&self) -> usize {
        self.pos
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn advance(&mut self, count: usize) {
        self.pos = (self.pos + count).min(self.bytes.len());
    }

    /// Whether `token` starts at the cursor.
    pub(crate) fn starts_with(&self, token: &[u8]) -> bool {
        self.bytes.get(self.pos..self.pos + token.len()) == Some(token)
    }

    /// Whether `token` starts at the cursor and is followed by a delimiter.
    pub(crate) fn starts_with_delimited(&self, token: &[u8]) -> bool {
        let end = self.pos + token.len();
        if self.bytes.get(self.pos..end) != Some(token) {
            return false;
        }
        match self.bytes.get(end) {
            None => true,
            Some(byte) => is_whitespace(*byte) || is_delimiter(*byte),
        }
    }

    /// A content-stream operator token: regular characters, or the single
    /// `'` / `"` string-show operators.
    pub(crate) fn read_operator(&mut self) -> String {
        if let Some(byte @ (b'\'' | b'"')) = self.peek() {
            self.pos += 1;
            return char::from(byte).to_string();
        }
        let start = self.pos;
        while matches!(self.peek(), Some(byte) if is_regular(byte)) {
            self.pos += 1;
        }
        String::from_utf8_lossy(&self.bytes[start..self.pos]).into_owned()
    }

    pub(crate) fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    pub(crate) fn next(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.pos += 1;
        Some(byte)
    }

    /// Whitespace and `%` comments, as `read_non_whitespace` skips them.
    pub(crate) fn skip_whitespace(&mut self) {
        loop {
            match self.peek() {
                Some(byte) if is_whitespace(byte) => self.pos += 1,
                Some(b'%') => {
                    while let Some(byte) = self.peek() {
                        if byte == b'\r' || byte == b'\n' {
                            break;
                        }
                        self.pos += 1;
                    }
                }
                _ => break,
            }
        }
    }

    pub(crate) fn match_keyword(&mut self, keyword: &str) -> bool {
        let end = self.pos + keyword.len();
        if self.bytes.get(self.pos..end) == Some(keyword.as_bytes()) {
            self.pos = end;
            true
        } else {
            false
        }
    }

    pub(crate) fn read_integer(&mut self) -> Result<i64, String> {
        self.skip_whitespace();
        let start = self.pos;
        if matches!(self.peek(), Some(b'+') | Some(b'-')) {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(byte) if byte.is_ascii_digit()) {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "invalid integer token".to_owned())?;
        text.parse::<i64>()
            .map_err(|_| format!("invalid integer token {text:?} at {}", self.pos))
    }

    fn parse_name(&mut self) -> Result<String, String> {
        // The cursor is on '/'.
        self.pos += 1;
        let mut name = String::from("/");
        while let Some(byte) = self.peek() {
            if !is_regular(byte) {
                break;
            }
            self.pos += 1;
            if byte == b'#' {
                let high = self.next().ok_or("truncated name escape")?;
                let low = self.next().ok_or("truncated name escape")?;
                let value = (hex_value(high).ok_or("invalid name escape")? << 4)
                    | hex_value(low).ok_or("invalid name escape")?;
                name.push(char::from(value));
            } else {
                name.push(char::from(byte));
            }
        }
        Ok(name)
    }

    fn parse_literal_string(&mut self) -> Result<Vec<u8>, String> {
        // The cursor is on '('.
        self.pos += 1;
        let mut output = Vec::new();
        let mut depth = 1usize;
        while let Some(byte) = self.next() {
            match byte {
                b'(' => {
                    depth += 1;
                    output.push(byte);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Ok(output);
                    }
                    output.push(byte);
                }
                b'\\' => {
                    let escaped = self.next().ok_or("truncated string escape")?;
                    match escaped {
                        b'n' => output.push(b'\n'),
                        b'r' => output.push(b'\r'),
                        b't' => output.push(b'\t'),
                        b'b' => output.push(8),
                        b'f' => output.push(12),
                        b'0'..=b'7' => {
                            let mut value = u32::from(escaped - b'0');
                            for _ in 0..2 {
                                match self.peek() {
                                    Some(digit @ b'0'..=b'7') => {
                                        value = value * 8 + u32::from(digit - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            output.push((value & 0xFF) as u8);
                        }
                        b'\r' | b'\n' => {
                            // An escaped line break contributes nothing.
                            if escaped == b'\r' && self.peek() == Some(b'\n') {
                                self.pos += 1;
                            }
                        }
                        other => output.push(other),
                    }
                }
                other => output.push(other),
            }
        }
        Err("unterminated literal string".to_owned())
    }

    fn parse_hex_string(&mut self) -> Result<Vec<u8>, String> {
        // The cursor is on '<'.
        self.pos += 1;
        let mut digits = Vec::new();
        loop {
            let byte = self.next().ok_or("unterminated hex string")?;
            match byte {
                b'>' => break,
                byte if is_whitespace(byte) => {}
                byte => digits.push(byte),
            }
        }
        if digits.len() % 2 == 1 {
            digits.push(b'0');
        }
        let mut output = Vec::with_capacity(digits.len() / 2);
        for pair in digits.chunks(2) {
            let high = hex_value(pair[0]).ok_or("invalid hex string")?;
            let low = hex_value(pair[1]).ok_or("invalid hex string")?;
            output.push((high << 4) | low);
        }
        Ok(output)
    }

    fn parse_array(&mut self) -> Result<Vec<Object>, String> {
        // The cursor is on '['.
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some(b']') => {
                    self.pos += 1;
                    return Ok(items);
                }
                None => return Err("unterminated array".to_owned()),
                _ => items.push(self.parse_object()?),
            }
        }
    }

    fn parse_dictionary(&mut self) -> Result<Dictionary, String> {
        // The cursor is on the first '<' of '<<'.
        self.pos += 2;
        let mut entries = Dictionary::new();
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some(b'>') => {
                    self.pos += 1;
                    if self.peek() == Some(b'>') {
                        self.pos += 1;
                    }
                    return Ok(entries);
                }
                Some(b'/') => {
                    let key = self.parse_name()?;
                    let value = self.parse_object()?;
                    entries.insert(key, value);
                }
                None => return Err("unterminated dictionary".to_owned()),
                Some(_) => {
                    return Err("dictionary key is not a name".to_owned());
                }
            }
        }
    }

    fn parse_number(&mut self) -> Result<Object, String> {
        self.skip_whitespace();
        let start = self.pos;
        if matches!(self.peek(), Some(b'+') | Some(b'-')) {
            self.pos += 1;
        }
        let mut real = false;
        while let Some(byte) = self.peek() {
            match byte {
                b'0'..=b'9' => self.pos += 1,
                b'.' if !real => {
                    real = true;
                    self.pos += 1;
                }
                _ => break,
            }
        }
        let token = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "invalid numeric token".to_owned())?;
        if token.is_empty() || token == "+" || token == "-" || token == "." {
            return Err(format!("invalid numeric token {token:?}"));
        }
        let first = if real {
            Object::Real(
                token
                    .parse::<f64>()
                    .map_err(|_| format!("invalid real {token:?}"))?,
            )
        } else {
            match token.parse::<i64>() {
                Ok(value) => Object::Integer(value),
                Err(_) => Object::Real(
                    token
                        .parse::<f64>()
                        .map_err(|_| format!("invalid number {token:?}"))?,
                ),
            }
        };
        // `n g R` is an indirect reference; restore the cursor when it is not.
        if let Object::Integer(number) = first {
            let saved = self.pos;
            if let Ok(generation) = self.read_integer()
                && generation >= 0
            {
                self.skip_whitespace();
                if self.peek() == Some(b'R')
                    && self
                        .bytes
                        .get(self.pos + 1)
                        .is_none_or(|byte| is_whitespace(*byte) || is_delimiter(*byte))
                {
                    self.pos += 1;
                    return Ok(Object::Reference(number as u32));
                }
            }
            self.pos = saved;
            return Ok(first);
        }
        Ok(first)
    }

    /// Any direct object (`read_object`). Indirect references appear as
    /// `Object::Reference` for the document to resolve.
    pub(crate) fn parse_object(&mut self) -> Result<Object, String> {
        self.skip_whitespace();
        match self.peek() {
            None => Err("unexpected end of PDF data".to_owned()),
            Some(b'/') => Ok(Object::Name(self.parse_name()?)),
            Some(b'<') => {
                if self.bytes.get(self.pos + 1) == Some(&b'<') {
                    Ok(Object::Dictionary(self.parse_dictionary()?))
                } else {
                    Ok(Object::String(self.parse_hex_string()?))
                }
            }
            Some(b'[') => Ok(Object::Array(self.parse_array()?)),
            Some(b'(') => Ok(Object::String(self.parse_literal_string()?)),
            Some(b't') if self.match_keyword("true") => Ok(Object::Bool(true)),
            Some(b'f') if self.match_keyword("false") => Ok(Object::Bool(false)),
            Some(b'n') if self.match_keyword("null") => Ok(Object::Null),
            Some(byte) if byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.') => {
                self.parse_number()
            }
            Some(_) => Err(format!("invalid elementary object at offset {}", self.pos)),
        }
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// The objects reachable from the trailer's `/Root`.
pub(crate) struct Document {
    objects: HashMap<u32, Object>,
    trailer: Dictionary,
}

impl Document {
    pub(crate) fn load(bytes: &[u8]) -> Result<Self, String> {
        let xref = xref::read(bytes)?;
        if xref.trailer.contains_key("/Encrypt") {
            return Err("encrypted".to_owned());
        }
        // Objects stored directly in the file.
        let mut offsets = HashMap::new();
        for (&number, entry) in &xref.entries {
            if let xref::Entry::InFile(offset) = entry {
                offsets.insert(number, *offset);
            }
        }
        let mut objects = HashMap::with_capacity(xref.entries.len());
        for (&number, entry) in &xref.entries {
            if let xref::Entry::InFile(offset) = entry {
                let object = xref::parse_indirect(bytes, *offset, &offsets)
                    .map_err(|error| format!("object {number} at {offset}: {error}"))?;
                objects.insert(number, object);
            }
        }
        Self::load_object_streams(&mut objects, &xref.entries)?;
        Ok(Self {
            objects,
            trailer: xref.trailer,
        })
    }

    /// Expand `/Type /ObjStm` containers referenced by cross-reference
    /// streams.
    fn load_object_streams(
        objects: &mut HashMap<u32, Object>,
        entries: &HashMap<u32, xref::Entry>,
    ) -> Result<(), String> {
        let mut streams: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
        for (&target, entry) in entries {
            if let xref::Entry::InStream { stream, index } = entry {
                streams.entry(*stream).or_default().push((*index, target));
            }
        }
        for (stream_number, members) in streams {
            let stream = match objects.get(&stream_number) {
                Some(Object::Stream(stream)) => stream.clone(),
                _ => return Err(format!("object stream {stream_number} is missing")),
            };
            let data = decoded_stream_data(&stream.dict, &stream.data)?;
            let count = match stream.dict.get("/N") {
                Some(Object::Integer(value)) if *value >= 0 => *value as usize,
                _ => return Err("object stream is missing /N".to_owned()),
            };
            let first = match stream.dict.get("/First") {
                Some(Object::Integer(value)) if *value >= 0 => *value as usize,
                _ => return Err("object stream is missing /First".to_owned()),
            };
            let mut header = Cursor::new(&data[..first.min(data.len())]);
            let mut object_offsets = Vec::with_capacity(count);
            for _ in 0..count {
                header.read_integer()?;
                object_offsets.push(header.read_integer()?);
            }
            for (index, target) in members {
                let Some(offset) = object_offsets.get(index as usize) else {
                    return Err("object stream index out of range".to_owned());
                };
                let position = first.saturating_add(*offset as usize);
                if position > data.len() {
                    return Err("object stream offset out of range".to_owned());
                }
                let mut cursor = Cursor::at(&data, position);
                objects.insert(target, cursor.parse_object()?);
            }
        }
        Ok(())
    }

    /// Follow an indirect reference. Cycles resolve to the reference itself.
    pub(crate) fn resolve<'a>(&'a self, mut object: &'a Object) -> &'a Object {
        let mut seen = 0usize;
        while let Object::Reference(number) = object {
            seen += 1;
            if seen > 32 {
                break;
            }
            match self.objects.get(number) {
                Some(next) => object = next,
                None => break,
            }
        }
        object
    }

    pub(crate) fn get<'a>(&'a self, dict: &'a Dictionary, key: &str) -> Option<&'a Object> {
        dict.get(key).map(|object| self.resolve(object))
    }

    pub(crate) fn dict<'a>(&'a self, object: &'a Object) -> Option<&'a Dictionary> {
        match self.resolve(object) {
            Object::Dictionary(dict) => Some(dict),
            _ => None,
        }
    }

    pub(crate) fn array<'a>(&'a self, object: &'a Object) -> Option<&'a Vec<Object>> {
        match self.resolve(object) {
            Object::Array(items) => Some(items),
            _ => None,
        }
    }

    pub(crate) fn stream<'a>(&'a self, object: &'a Object) -> Option<&'a Stream> {
        match self.resolve(object) {
            Object::Stream(stream) => Some(stream),
            _ => None,
        }
    }

    pub(crate) fn integer(&self, object: &Object) -> Option<i64> {
        match self.resolve(object) {
            Object::Integer(value) => Some(*value),
            Object::Real(value) => Some(*value as i64),
            _ => None,
        }
    }

    pub(crate) fn number(&self, object: &Object) -> Option<f64> {
        match self.resolve(object) {
            Object::Integer(value) => Some(*value as f64),
            Object::Real(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn name<'a>(&'a self, object: &'a Object) -> Option<&'a str> {
        match self.resolve(object) {
            Object::Name(name) => Some(name),
            _ => None,
        }
    }

    /// `/Resources` (or another inheritable key) from a page or form, walking
    /// `/Parent` like `_extract_text` does.
    pub(crate) fn inherited<'a>(&'a self, dict: &'a Dictionary, key: &str) -> Option<&'a Object> {
        let mut current = dict;
        for _ in 0..32 {
            if let Some(value) = self.get(current, key) {
                return Some(value);
            }
            match self.get(current, "/Parent") {
                Some(Object::Dictionary(parent)) => current = parent,
                _ => return None,
            }
        }
        None
    }

    /// The page dictionaries in `/Pages` order.
    pub(crate) fn pages(&self) -> Vec<&Dictionary> {
        let mut pages = Vec::new();
        let Some(root) = self.get(&self.trailer, "/Root") else {
            return pages;
        };
        let Some(root) = self.dict(root) else {
            return pages;
        };
        let Some(node) = self.get(root, "/Pages") else {
            return pages;
        };
        self.collect_pages(node, &mut pages, 0);
        pages
    }

    fn collect_pages<'a>(
        &'a self,
        node: &'a Object,
        pages: &mut Vec<&'a Dictionary>,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        let Some(dict) = self.dict(node) else {
            return;
        };
        if let Some(kids) = self.get(dict, "/Kids")
            && let Some(kids) = self.array(kids)
        {
            for kid in kids {
                self.collect_pages(kid, pages, depth + 1);
            }
            return;
        }
        pages.push(dict);
    }

    /// A stream's decoded bytes (`DecodedStreamObject.get_data`).
    pub(crate) fn decoded_stream(&self, stream: &Stream) -> Result<Vec<u8>, String> {
        let filters = match self.get(&stream.dict, "/Filter") {
            None => return Ok(stream.data.clone()),
            Some(filter) => filter,
        };
        let mut chain: Vec<String> = Vec::new();
        match filters {
            Object::Name(name) => chain.push(name.clone()),
            Object::Array(items) => {
                for item in items {
                    match self.resolve(item) {
                        Object::Name(name) => chain.push(name.clone()),
                        _ => return Err("invalid stream filter list".to_owned()),
                    }
                }
            }
            _ => return Err("invalid stream filter".to_owned()),
        }
        apply_filters(chain, &stream.data).and_then(|data| {
            let parms = match self.get(&stream.dict, "/DecodeParms") {
                Some(Object::Dictionary(parms)) => Some(parms),
                Some(Object::Array(items)) => items.last().and_then(|item| self.dict(item)),
                _ => None,
            };
            apply_predictor(parms, data)
        })
    }
}

/// Decode a stream whose filter entries are direct objects (cross-reference
/// streams and object streams).
pub(crate) fn decoded_stream_data(dict: &Dictionary, data: &[u8]) -> Result<Vec<u8>, String> {
    let mut chain: Vec<String> = Vec::new();
    match dict.get("/Filter") {
        None => return Ok(data.to_vec()),
        Some(Object::Name(name)) => chain.push(name.clone()),
        Some(Object::Array(items)) => {
            for item in items {
                match item {
                    Object::Name(name) => chain.push(name.clone()),
                    _ => return Err("invalid stream filter list".to_owned()),
                }
            }
        }
        _ => return Err("invalid stream filter".to_owned()),
    }
    let decoded = apply_filters(chain, data)?;
    let parms = match dict.get("/DecodeParms") {
        Some(Object::Dictionary(parms)) => Some(parms),
        _ => None,
    };
    apply_predictor(parms, decoded)
}

fn apply_filters(chain: Vec<String>, data: &[u8]) -> Result<Vec<u8>, String> {
    let mut data = data.to_vec();
    for filter in chain {
        data = match filter.as_str() {
            "/FlateDecode" | "/Fl" => decode_flate(&data)?,
            "/ASCIIHexDecode" | "/AHx" => decode_ascii_hex(&data),
            "/ASCII85Decode" | "/A85" => decode_ascii85(&data)?,
            other => return Err(format!("unsupported stream filter {other}")),
        };
    }
    Ok(data)
}

/// `/DecodeParms` PNG predictors (the form Flate-encoded cross-reference
/// streams use). TIFF predictor 2 is not implemented.
fn apply_predictor(parms: Option<&Dictionary>, data: Vec<u8>) -> Result<Vec<u8>, String> {
    let Some(parms) = parms else {
        return Ok(data);
    };
    let integer = |key: &str| match parms.get(key) {
        Some(Object::Integer(value)) if *value >= 0 => Some(*value as usize),
        _ => None,
    };
    let predictor = integer("/Predictor").unwrap_or(1);
    if predictor <= 1 {
        return Ok(data);
    }
    let colors = integer("/Colors").unwrap_or(1).max(1);
    let bits = integer("/BitsPerComponent").unwrap_or(8);
    let columns = integer("/Columns").unwrap_or(1).max(1);
    if bits != 8 || predictor < 10 {
        return Err(format!("unsupported predictor {predictor}"));
    }
    let row_length = columns * colors;
    let mut output = Vec::with_capacity(data.len());
    let mut previous = vec![0u8; row_length];
    for row in data.chunks(row_length + 1) {
        if row.len() != row_length + 1 {
            return Err("truncated predictor row".to_owned());
        }
        let mut current = row[1..].to_vec();
        for index in 0..row_length {
            let left = if index >= colors {
                current[index - colors]
            } else {
                0
            };
            let up = previous[index];
            let upper_left = if index >= colors {
                previous[index - colors]
            } else {
                0
            };
            current[index] = match row[0] {
                0 => current[index],
                1 => current[index].wrapping_add(left),
                2 => current[index].wrapping_add(up),
                3 => current[index].wrapping_add(((u16::from(left) + u16::from(up)) / 2) as u8),
                4 => current[index].wrapping_add(paeth(left, up, upper_left)),
                _ => return Err("invalid PNG predictor row".to_owned()),
            };
        }
        output.extend_from_slice(&current);
        previous = current;
    }
    Ok(output)
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let left = i32::from(left);
    let up = i32::from(up);
    let upper_left = i32::from(upper_left);
    let estimate = left + up - upper_left;
    let left_distance = (estimate - left).abs();
    let up_distance = (estimate - up).abs();
    let upper_left_distance = (estimate - upper_left).abs();
    if left_distance <= up_distance && left_distance <= upper_left_distance {
        left as u8
    } else if up_distance <= upper_left_distance {
        up as u8
    } else {
        upper_left as u8
    }
}

fn decode_flate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut decoder = flate2::read::ZlibDecoder::new(data);
    if decoder.read_to_end(&mut output).is_ok() {
        return Ok(output);
    }
    // PyPDF2 falls back to a raw deflate stream when the zlib header is absent.
    let mut output = Vec::new();
    let mut decoder = flate2::read::DeflateDecoder::new(data);
    decoder
        .read_to_end(&mut output)
        .map_err(|error| format!("FlateDecode failed: {error}"))?;
    Ok(output)
}

fn decode_ascii_hex(data: &[u8]) -> Vec<u8> {
    let mut digits = Vec::new();
    for &byte in data {
        match byte {
            b'>' => break,
            byte if is_whitespace(byte) => {}
            byte => digits.push(byte),
        }
    }
    if !digits.len().is_multiple_of(2) {
        digits.push(b'0');
    }
    digits
        .chunks(2)
        .filter_map(|pair| {
            let high = hex_value(pair[0])?;
            let low = hex_value(pair[1])?;
            Some((high << 4) | low)
        })
        .collect()
}

fn decode_ascii85(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut group = [0u8; 5];
    let mut count = 0usize;
    for &byte in data {
        if is_whitespace(byte) {
            continue;
        }
        if byte == b'~' {
            break;
        }
        if byte == b'z' && count == 0 {
            output.extend_from_slice(&[0, 0, 0, 0]);
            continue;
        }
        if !(b'!'..=b'u').contains(&byte) {
            return Err("invalid ASCII85 stream".to_owned());
        }
        group[count] = byte - b'!';
        count += 1;
        if count == 5 {
            let mut value = 0u32;
            for digit in group {
                value = value
                    .checked_mul(85)
                    .and_then(|value| value.checked_add(u32::from(digit)))
                    .ok_or("ASCII85 group overflow")?;
            }
            output.extend_from_slice(&value.to_be_bytes());
            count = 0;
        }
    }
    if count > 0 {
        for slot in group.iter_mut().skip(count) {
            *slot = 84;
        }
        let mut value = 0u32;
        for digit in group {
            value = value
                .checked_mul(85)
                .and_then(|value| value.checked_add(u32::from(digit)))
                .ok_or("ASCII85 group overflow")?;
        }
        output.extend_from_slice(&value.to_be_bytes()[..count - 1]);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_objects_round_trip() {
        let mut cursor = Cursor::new(b"/F5 36 Tf [1 0 R <00ff> (a\\053b)] << /A 1 >>");
        assert_eq!(
            cursor.parse_object().unwrap(),
            Object::Name("/F5".to_owned())
        );
        assert_eq!(cursor.parse_object().unwrap(), Object::Integer(36));
    }

    #[test]
    fn hex_strings_pad_an_odd_digit_count() {
        let mut cursor = Cursor::new(b"<4142 4>");
        assert_eq!(
            cursor.parse_object().unwrap(),
            Object::String(vec![0x41, 0x42, 0x40])
        );
    }

    #[test]
    fn literal_strings_decode_escapes() {
        let mut cursor = Cursor::new(b"(a\\n\\053\\(\\))");
        assert_eq!(
            cursor.parse_object().unwrap(),
            Object::String(b"a\n+()".to_vec())
        );
    }

    #[test]
    fn indirect_references_are_detected() {
        let mut cursor = Cursor::new(b"12 0 R");
        assert_eq!(cursor.parse_object().unwrap(), Object::Reference(12));
    }

    #[test]
    fn dictionaries_keep_the_leading_slash() {
        let mut cursor = Cursor::new(b"<< /Type /Page /Count 2 >>");
        let Object::Dictionary(dict) = cursor.parse_object().unwrap() else {
            panic!("expected dictionary");
        };
        assert_eq!(dict["/Type"], Object::Name("/Page".to_owned()));
    }

    #[test]
    fn png_predictor_rows_unfilter_against_the_previous_row() {
        let parms: Dictionary = [
            ("/Predictor".to_owned(), Object::Integer(12)),
            ("/Columns".to_owned(), Object::Integer(3)),
        ]
        .into_iter()
        .collect();
        // Row 1 uses Sub; row 2 uses Up over row 1.
        let data = vec![1, 1, 2, 3, 2, 1, 1, 1];
        assert_eq!(
            apply_predictor(Some(&parms), data).unwrap(),
            vec![1, 3, 6, 2, 4, 7]
        );
    }
}
