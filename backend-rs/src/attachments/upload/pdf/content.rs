// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The content-stream tokenizer (`PyPDF2.generic.ContentStream`). Operands use
//! the PDF object grammar; a bare regular-character token is an operator.
//! Content streams are parsed with `forced_encoding="bytes"`, so every string
//! operand stays raw bytes for the font character map to decode.
use super::object::{Cursor, Object};

/// One content-stream operation and the operands preceding it.
#[derive(Debug, PartialEq)]
pub(crate) struct Operation {
    pub operands: Vec<Object>,
    pub operator: String,
}

fn is_operator_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'\'' || byte == b'"'
}

/// `ContentStream.__parse_content_stream`.
pub(crate) fn parse(bytes: &[u8]) -> Result<Vec<Operation>, String> {
    let mut cursor = Cursor::new(bytes);
    let mut operations = Vec::new();
    let mut operands: Vec<Object> = Vec::new();
    loop {
        cursor.skip_whitespace();
        let Some(byte) = cursor.peek() else {
            break;
        };
        if is_operator_start(byte) {
            let operator = cursor.read_operator();
            if operator == "BI" {
                skip_inline_image(&mut cursor)?;
                operations.push(Operation {
                    operands: Vec::new(),
                    operator: "INLINE IMAGE".to_owned(),
                });
            } else if operator == "true" || operator == "false" || operator == "null" {
                // `read_object` handles these; the source tokenizer treats an
                // alphabetic token as an operator, so they never appear here.
                operations.push(Operation { operands, operator });
                operands = Vec::new();
            } else {
                operations.push(Operation { operands, operator });
                operands = Vec::new();
            }
        } else {
            operands.push(cursor.parse_object()?);
        }
    }
    Ok(operations)
}

/// `BI ... ID <binary> EI`: the payload is skipped, and the source extractor
/// ignores the resulting operation.
fn skip_inline_image(cursor: &mut Cursor<'_>) -> Result<(), String> {
    loop {
        cursor.skip_whitespace();
        let Some(byte) = cursor.peek() else {
            return Err("unterminated inline image".to_owned());
        };
        if byte.is_ascii_alphabetic() {
            let token = cursor.read_operator();
            if token == "ID" {
                break;
            }
        } else {
            cursor.parse_object()?;
        }
    }
    // Consume the single whitespace byte after `ID`, then scan for an `EI`
    // token delimited by whitespace.
    cursor.next();
    while cursor.position() < cursor.len() {
        if cursor.starts_with_delimited(b"EI") {
            cursor.advance(2);
            return Ok(());
        }
        cursor.next();
    }
    Err("unterminated inline image".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operators_and_operands_split_like_the_source_tokenizer() {
        let operations = parse(b"BT /F5 36 Tf 1 0 0 -1 72 39 Tm <01> Tj ET").unwrap();
        assert_eq!(
            operations
                .iter()
                .map(|op| op.operator.as_str())
                .collect::<Vec<_>>(),
            vec!["BT", "Tf", "Tm", "Tj", "ET"]
        );
        assert_eq!(operations[1].operands[0], Object::Name("/F5".to_owned()));
        assert_eq!(operations[3].operands[0], Object::String(vec![1]));
    }

    #[test]
    fn marked_content_dictionaries_are_operands() {
        let operations = parse(b"/NonStruct <</MCID 2 >> BDC EMC").unwrap();
        assert_eq!(operations[0].operator, "BDC");
        assert!(matches!(operations[0].operands[1], Object::Dictionary(_)));
    }

    #[test]
    fn inline_image_payload_is_skipped() {
        let operations = parse(b"BI /W 2 /H 2 ID \x00\x01\x02 EI BT ET").unwrap();
        assert_eq!(operations[0].operator, "INLINE IMAGE");
        assert_eq!(operations[1].operator, "BT");
    }

    #[test]
    fn array_operands_support_tj_adjustments() {
        let operations = parse(b"[(a) -200 (b)] TJ").unwrap();
        assert_eq!(operations[0].operator, "TJ");
        assert!(matches!(operations[0].operands[0], Object::Array(_)));
    }
}
