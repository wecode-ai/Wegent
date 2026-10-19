// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PyPDF2._page._extract_text`: the text operator state machine. The source
//! document parser stores this text, so the newline/space decisions and the
//! matrix arithmetic are reproduced exactly rather than approximated.
use std::collections::HashMap;

use super::content::{self, Operation};
use super::font::{self, FontCharMap};
use super::object::{Dictionary, Document, Object, Stream};

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
/// Page text extraction orientations. Form XObjects inherit the caller's set
/// (`_extract_text`'s `Do` branch passes `orientations` to
/// `extract_xform_text`).
const PAGE_ORIENTATIONS: [i32; 4] = [0, 90, 180, 270];
const MAX_XOBJECT_DEPTH: usize = 16;

/// `_extract_text`'s `cmap` state: the current font resource plus the two
/// before-`Tf` states.
#[derive(Clone)]
enum CurrentFont {
    /// `("charmap", {}, "NotInitialized", None)`.
    Initial,
    /// A `Tf` naming a font the page resources do not define
    /// (`unknown_char_map`).
    Missing,
    Named(String),
}

struct Saved {
    cm: [f64; 6],
    font: CurrentFont,
    font_size: f64,
    char_scale: f64,
    space_scale: f64,
    space_width: f64,
    leading: f64,
}

pub(crate) struct Extractor<'a> {
    doc: &'a Document,
    output: String,
    text: String,
    rtl: bool,
    cm: [f64; 6],
    cm_stack: Vec<Saved>,
    tm: [f64; 6],
    tm_prev: [f64; 6],
    char_scale: f64,
    space_scale: f64,
    space_width: f64,
    leading: f64,
    font_size: f64,
    font: CurrentFont,
    cmaps: HashMap<String, FontCharMap>,
    orientations: &'static [i32; 4],
    resources: Option<&'a Dictionary>,
    depth: usize,
}

impl<'a> Extractor<'a> {
    fn new(
        doc: &'a Document,
        resources: Option<&'a Dictionary>,
        cmaps: HashMap<String, FontCharMap>,
        orientations: &'static [i32; 4],
        depth: usize,
    ) -> Self {
        Self {
            doc,
            output: String::new(),
            text: String::new(),
            rtl: false,
            cm: IDENTITY,
            cm_stack: Vec::new(),
            tm: IDENTITY,
            tm_prev: IDENTITY,
            char_scale: 1.0,
            space_scale: 1.0,
            space_width: 500.0,
            leading: 0.0,
            font_size: 12.0,
            font: CurrentFont::Initial,
            cmaps,
            orientations,
            resources,
            depth,
        }
    }

    /// `extract_text`: resources, `/Contents`, then the operator loop.
    pub(crate) fn extract_page(doc: &'a Document, page: &'a Dictionary) -> Result<String, String> {
        let Some(resources) = doc.inherited(page, "/Resources") else {
            return Ok(String::new());
        };
        let Some(resources) = doc.dict(resources) else {
            return Ok(String::new());
        };
        let Some(contents) = doc.get(page, "/Contents") else {
            return Ok(String::new());
        };
        let data = content_bytes(doc, contents)?;
        let operations = content::parse(&data)?;
        let cmaps = build_char_maps(doc, resources)?;
        let mut extractor = Extractor::new(doc, Some(resources), cmaps, &PAGE_ORIENTATIONS, 0);
        extractor.run(&operations)?;
        Ok(extractor.finish())
    }

    fn run(&mut self, operations: &[Operation]) -> Result<(), String> {
        for operation in operations {
            match operation.operator.as_str() {
                "'" => {
                    self.process("T*", &[])?;
                    self.process("Tj", &operation.operands)?;
                }
                "\"" => {
                    if let Some(spacing) = operation.operands.first() {
                        self.process("Tw", std::slice::from_ref(spacing))?;
                    }
                    if operation.operands.len() > 2 {
                        self.process("T*", &[])?;
                        self.process("Tj", &operation.operands[2..])?;
                    }
                }
                "TD" => {
                    if let Some(ty) = operation.operands.get(1) {
                        let value = direct_number(ty)?;
                        self.process("TL", &[Object::Real(-value)])?;
                    }
                    self.process("Td", &operation.operands)?;
                }
                "TJ" => self.show_adjusted(&operation.operands)?,
                "Do" => self.show_xobject(&operation.operands)?,
                other => self.process(other, &operation.operands)?,
            }
        }
        Ok(())
    }

    fn finish(mut self) -> String {
        self.output.push_str(&self.text);
        self.output
    }

    fn flush_text(&mut self) {
        self.output.push_str(&self.text);
        self.text.clear();
    }

    fn process(&mut self, operator: &str, operands: &[Object]) -> Result<(), String> {
        let mut check_crlf_space = false;
        match operator {
            "BT" => {
                self.tm = IDENTITY;
                self.flush_text();
            }
            "ET" => self.flush_text(),
            "q" => self.cm_stack.push(Saved {
                cm: self.cm,
                font: self.font.clone(),
                font_size: self.font_size,
                char_scale: self.char_scale,
                space_scale: self.space_scale,
                space_width: self.space_width,
                leading: self.leading,
            }),
            "Q" => {
                if let Some(saved) = self.cm_stack.pop() {
                    self.cm = saved.cm;
                    self.font = saved.font;
                    self.font_size = saved.font_size;
                    self.char_scale = saved.char_scale;
                    self.space_scale = saved.space_scale;
                    self.space_width = saved.space_width;
                    self.leading = saved.leading;
                } else {
                    self.cm = IDENTITY;
                }
            }
            "cm" => {
                self.flush_text();
                let matrix = [
                    direct_number(operands.first().ok_or("cm expects six operands")?)?,
                    direct_number(operands.get(1).ok_or("cm expects six operands")?)?,
                    direct_number(operands.get(2).ok_or("cm expects six operands")?)?,
                    direct_number(operands.get(3).ok_or("cm expects six operands")?)?,
                    direct_number(operands.get(4).ok_or("cm expects six operands")?)?,
                    direct_number(operands.get(5).ok_or("cm expects six operands")?)?,
                ];
                self.cm = mult(matrix, self.cm);
            }
            "Tz" => self.char_scale = direct_number(operands.first().ok_or("Tz operand")?)? / 100.0,
            "Tw" => {
                self.space_scale = 1.0 + direct_number(operands.first().ok_or("Tw operand")?)?;
            }
            "TL" => self.leading = direct_number(operands.first().ok_or("TL operand")?)?,
            "Tf" => {
                self.flush_text();
                let resource = match operands.first() {
                    Some(Object::Name(name)) => name.clone(),
                    _ => return Err("Tf expects a font name".to_owned()),
                };
                self.font = if self.cmaps.contains_key(&resource) {
                    CurrentFont::Named(resource)
                } else {
                    CurrentFont::Missing
                };
                self.space_width = match &self.font {
                    CurrentFont::Named(name) => self.cmaps[name].space_width,
                    CurrentFont::Missing => 9999.0,
                    CurrentFont::Initial => 500.0,
                };
                if let Some(size) = operands.get(1).and_then(|size| direct_number(size).ok()) {
                    self.font_size = size;
                }
            }
            "Td" => {
                check_crlf_space = true;
                let tx = direct_number(operands.first().ok_or("Td expects two operands")?)?;
                let ty = direct_number(operands.get(1).ok_or("Td expects two operands")?)?;
                self.tm[4] += tx * self.tm[0] + ty * self.tm[2];
                self.tm[5] += tx * self.tm[1] + ty * self.tm[3];
            }
            "Tm" => {
                check_crlf_space = true;
                self.tm = [
                    direct_number(operands.first().ok_or("Tm expects six operands")?)?,
                    direct_number(operands.get(1).ok_or("Tm expects six operands")?)?,
                    direct_number(operands.get(2).ok_or("Tm expects six operands")?)?,
                    direct_number(operands.get(3).ok_or("Tm expects six operands")?)?,
                    direct_number(operands.get(4).ok_or("Tm expects six operands")?)?,
                    direct_number(operands.get(5).ok_or("Tm expects six operands")?)?,
                ];
            }
            "T*" => {
                check_crlf_space = true;
                self.tm[5] -= self.leading;
            }
            "Tj" => {
                check_crlf_space = true;
                let matrix = mult(self.tm, self.cm);
                if self.orientations.contains(&orient(matrix)) {
                    let decoded = self.decode_operand(operands.first())?;
                    self.append(&decoded);
                }
            }
            _ => {}
        }
        if check_crlf_space {
            self.check_crlf_space();
        }
        Ok(())
    }

    /// `TJ`: strings shown in order, and adjustments at least one space wide
    /// insert a literal space.
    fn show_adjusted(&mut self, operands: &[Object]) -> Result<(), String> {
        let Some(Object::Array(items)) = operands.first() else {
            return Ok(());
        };
        for item in items {
            match item {
                Object::String(_) | Object::Name(_) => {
                    self.process("Tj", std::slice::from_ref(item))?
                }
                Object::Integer(value) => self.show_adjustment(*value as f64)?,
                Object::Real(value) => self.show_adjustment(*value)?,
                _ => {}
            }
        }
        Ok(())
    }

    fn show_adjustment(&mut self, value: f64) -> Result<(), String> {
        if value.abs() >= self.space_width && !self.text.is_empty() && !self.text.ends_with(' ') {
            // PyPDF2 passes a decoded Python string here, bypassing the font's
            // ToUnicode map. A synthetic byte string would remap the space.
            if self.orientations.contains(&orient(mult(self.tm, self.cm))) {
                self.append(" ");
            }
            self.check_crlf_space();
        }
        Ok(())
    }

    /// `Do`: a non-image form XObject contributes its own extracted text.
    fn show_xobject(&mut self, operands: &[Object]) -> Result<(), String> {
        self.flush_text();
        if self.output.chars().last().is_some_and(|last| last != '\n') {
            self.output.push('\n');
        }
        let resource = match operands.first() {
            Some(Object::Name(name)) => name.clone(),
            _ => return Err("Do expects an XObject name".to_owned()),
        };
        let xobject = self
            .resources
            .and_then(|resources| self.doc.get(resources, "/XObject"))
            .and_then(|object| self.doc.dict(object))
            .and_then(|xobjects| self.doc.get(xobjects, &resource));
        if let Some(xobject) = xobject
            && let Some(stream) = self.doc.stream(xobject)
        {
            let subtype = self
                .doc
                .get(&stream.dict, "/Subtype")
                .and_then(|object| self.doc.name(object));
            if subtype.is_some_and(|subtype| subtype != "/Image") {
                let text = self.extract_xform(stream)?;
                self.output.push_str(&text);
            }
        }
        self.text.clear();
        Ok(())
    }

    /// `extract_xform_text`: a fresh state machine over the form's own
    /// resources and contents.
    fn extract_xform(&self, stream: &'a Stream) -> Result<String, String> {
        if self.depth >= MAX_XOBJECT_DEPTH {
            return Ok(String::new());
        }
        let Some(resources) = self.doc.inherited(&stream.dict, "/Resources") else {
            return Ok(String::new());
        };
        let Some(resources) = self.doc.dict(resources) else {
            return Ok(String::new());
        };
        let data = self.doc.decoded_stream(stream)?;
        let operations = content::parse(&data)?;
        let cmaps = build_char_maps(self.doc, resources)?;
        let mut extractor = Extractor::new(
            self.doc,
            Some(resources),
            cmaps,
            self.orientations,
            self.depth + 1,
        );
        extractor.run(&operations)?;
        Ok(extractor.finish())
    }

    fn decode_operand(&self, operand: Option<&Object>) -> Result<String, String> {
        match operand {
            Some(Object::String(bytes)) => Ok(self.decode(bytes)),
            Some(Object::Name(name)) => Ok(name.clone()),
            _ => Err("text-showing operator expects a string".to_owned()),
        }
    }

    fn decode(&self, bytes: &[u8]) -> String {
        match &self.font {
            CurrentFont::Named(name) => self.cmaps[name].decode(bytes),
            CurrentFont::Missing => bytes.iter().map(|_| '\u{FFFD}').collect(),
            CurrentFont::Initial => bytes.iter().map(|&byte| char::from(byte)).collect(),
        }
    }

    /// `_handle_tj`'s direction handling: punctuation, numbers, then the
    /// bidirectional ranges.
    fn append(&mut self, decoded: &str) {
        for character in decoded.chars() {
            let code = character as u32;
            let neutral = code <= 0x2F
                || (0x3A..=0x40).contains(&code)
                || (0x2000..=0x206F).contains(&code)
                || (0x20A0..=0x21FF).contains(&code);
            let right_to_left = (0x0590..=0x08FF).contains(&code)
                || (0xFB1D..=0xFDFF).contains(&code)
                || (0xFE70..=0xFEFF).contains(&code);
            if neutral {
                if self.rtl {
                    self.text.insert(0, character);
                } else {
                    self.text.push(character);
                }
            } else if right_to_left {
                if !self.rtl {
                    self.rtl = true;
                    self.flush_text();
                }
                self.text.insert(0, character);
            } else {
                if self.rtl {
                    self.rtl = false;
                    self.flush_text();
                }
                self.text.push(character);
            }
        }
    }

    /// The `check_crlf_space` block: a new line when the text matrix jumped
    /// down (up in a flipped matrix), a space when it moved sideways far
    /// enough while staying on the same line.
    fn check_crlf_space(&mut self) {
        let matrix = mult(self.tm, self.cm);
        let orientation = orient(matrix);
        let delta_x = matrix[4] - self.tm_prev[4];
        let delta_y = matrix[5] - self.tm_prev[5];
        let scale = ((matrix[0] * matrix[3]).abs() + (matrix[1] * matrix[2]).abs()).sqrt();
        let size = self.font_size * scale;
        self.tm_prev = matrix;
        if !self.orientations.contains(&orientation) {
            return;
        }
        let space_width = self.space_width / 1000.0;
        let (newline, space) = match orientation {
            0 => (
                delta_y < -0.8 * size,
                delta_y.abs() < size * 0.3 && delta_x.abs() > space_width * size * 15.0,
            ),
            180 => (
                delta_y > 0.8 * size,
                delta_y.abs() < size * 0.3 && delta_x.abs() > space_width * size * 15.0,
            ),
            90 => (
                delta_x > 0.8 * size,
                delta_x.abs() < size * 0.3 && delta_y.abs() > space_width * size * 15.0,
            ),
            _ => (
                delta_x < -0.8 * size,
                delta_x.abs() < size * 0.3 && delta_y.abs() > space_width * size * 15.0,
            ),
        };
        if newline {
            match self.last_output_char() {
                Some(last) if last != '\n' => {
                    self.output.push_str(&self.text);
                    self.output.push('\n');
                    self.text.clear();
                }
                _ => {}
            }
        } else if space {
            match self.last_output_char() {
                Some(last) if last != ' ' => self.text.push(' '),
                _ => {}
            }
        }
    }

    fn last_output_char(&self) -> Option<char> {
        self.text
            .chars()
            .last()
            .or_else(|| self.output.chars().last())
    }
}

fn build_char_maps(
    doc: &Document,
    resources: &Dictionary,
) -> Result<HashMap<String, FontCharMap>, String> {
    let mut cmaps = HashMap::new();
    let Some(fonts) = doc.get(resources, "/Font") else {
        return Ok(cmaps);
    };
    let Some(fonts) = doc.dict(fonts) else {
        return Ok(cmaps);
    };
    for (name, object) in fonts {
        let font = doc.dict(object).ok_or("invalid font dictionary")?;
        cmaps.insert(name.clone(), font::build(doc, font)?);
    }
    Ok(cmaps)
}

/// `ContentStream`: a single stream, or an array of streams concatenated with
/// a newline after each part that does not already end with one.
fn content_bytes(doc: &Document, contents: &Object) -> Result<Vec<u8>, String> {
    if let Some(stream) = doc.stream(contents) {
        return doc.decoded_stream(stream);
    }
    let Some(parts) = doc.array(contents) else {
        return Err("invalid page contents".to_owned());
    };
    let mut data = Vec::new();
    for part in parts {
        let stream = doc.stream(part).ok_or("invalid page content stream")?;
        data.extend_from_slice(&doc.decoded_stream(stream)?);
        if data.last() != Some(&b'\n') {
            data.push(b'\n');
        }
    }
    Ok(data)
}

fn direct_number(object: &Object) -> Result<f64, String> {
    match object {
        Object::Integer(value) => Ok(*value as f64),
        Object::Real(value) => Ok(*value),
        _ => Err("expected a number".to_owned()),
    }
}

fn mult(left: [f64; 6], right: [f64; 6]) -> [f64; 6] {
    [
        left[0] * right[0] + left[1] * right[2],
        left[0] * right[1] + left[1] * right[3],
        left[2] * right[0] + left[3] * right[2],
        left[2] * right[1] + left[3] * right[3],
        left[4] * right[0] + left[5] * right[2] + right[4],
        left[4] * right[1] + left[5] * right[3] + right[5],
    ]
}

fn orient(matrix: [f64; 6]) -> i32 {
    if matrix[3] > 1e-6 {
        0
    } else if matrix[3] < -1e-6 {
        180
    } else if matrix[1] > 0.0 {
        90
    } else {
        270
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spacing_adjustments_bypass_the_font_character_map() {
        let document = Document::load(&super::super::simple_pdf_bytes()).unwrap();
        let cmap = FontCharMap {
            space_width: 200.0,
            encoding: font::Encoding::Codec(font::Codec::Charmap),
            to_unicode: font::ToUnicode {
                code_bytes: 1,
                map: HashMap::from([(32, "\u{2423}".to_owned())]),
            },
        };
        let mut extractor = Extractor::new(
            &document,
            None,
            HashMap::from([("F1".to_owned(), cmap)]),
            &[0, 90, 180, 270],
            0,
        );
        extractor.font = CurrentFont::Named("F1".to_owned());
        extractor.text = "word".to_owned();
        extractor.show_adjustment(500.0).unwrap();
        assert_eq!(extractor.text, "word ");
    }

    #[test]
    fn matrix_multiplication_matches_the_source_ordering() {
        let translated = mult([1.0, 0.0, 0.0, 1.0, 72.0, 39.0], IDENTITY);
        assert_eq!(translated, [1.0, 0.0, 0.0, 1.0, 72.0, 39.0]);
        let scaled = mult(
            [3.125, 0.0, 0.0, 3.125, 0.0, 300.0],
            [0.24, 0.0, 0.0, -0.24, 0.0, 841.92],
        );
        assert!((scaled[0] - 0.75).abs() < 1e-9);
        assert!((scaled[5] - 769.92).abs() < 1e-9);
    }

    #[test]
    fn orientation_follows_the_y_scale() {
        assert_eq!(orient([0.75, 0.0, 0.0, 0.75, 0.0, 0.0]), 0);
        assert_eq!(orient([0.75, 0.0, 0.0, -0.75, 0.0, 0.0]), 180);
    }
}
