// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! PDF text extraction for `DocumentParser._parse_pdf_smart`
//! (`app/services/attachment/parser.py`). The source reads each page with
//! PyPDF2's `PdfReader.pages` / `PageObject.extract_text()`; this module ports
//! the object grammar, the font character maps, and the text operator state
//! machine that produce the stored page text.
pub(crate) mod charsets;
mod content;
mod extract;
mod font;
mod object;
mod xref;

/// A PDF failure the endpoint distinguishes: the source reports encrypted
/// files with their own error code and every other failure as `parse_failed`.
pub(crate) enum PdfError {
    Encrypted,
    Other(String),
}

impl std::fmt::Debug for PdfError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Encrypted => formatter.write_str("Encrypted"),
            Self::Other(cause) => formatter.debug_tuple("Other").field(cause).finish(),
        }
    }
}

/// `_parse_pdf_smart`: the non-empty page texts in page order.
pub(crate) fn page_texts(binary_data: &[u8]) -> Result<Vec<String>, PdfError> {
    let document = object::Document::load(binary_data).map_err(|error| {
        if error == "encrypted" {
            PdfError::Encrypted
        } else {
            PdfError::Other(error)
        }
    })?;
    let mut texts = Vec::new();
    for page in document.pages() {
        let text = extract::Extractor::extract_page(&document, page).map_err(PdfError::Other)?;
        if !text.is_empty() {
            texts.push(text);
        }
    }
    Ok(texts)
}

/// A minimal single-page PDF whose content stream draws `A` in a
/// WinAnsi-encoded font. Shared with the document-dispatch test.
#[cfg(test)]
pub(crate) fn simple_pdf_bytes() -> Vec<u8> {
    let content = b"BT /F1 12 Tf 72 720 Td (A) Tj ET";
    let mut pdf = Vec::new();
    pdf.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = Vec::new();
    offsets.push(pdf.len());
    pdf.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    offsets.push(pdf.len());
    pdf.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n");
    offsets.push(pdf.len());
    pdf.extend_from_slice(
        b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    );
    offsets.push(pdf.len());
    pdf.extend_from_slice(
        b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n",
    );
    offsets.push(pdf.len());
    pdf.extend_from_slice(format!("5 0 obj\n<< /Length {} >>\nstream\n", content.len()).as_bytes());
    pdf.extend_from_slice(content);
    pdf.extend_from_slice(b"\nendstream\nendobj\n");
    let xref_start = pdf.len();
    pdf.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
    pdf.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_start}\n%%EOF\n",
            offsets.len() + 1
        )
        .as_bytes(),
    );
    pdf
}

/// A PDF 1.5 document that stores its catalog, page tree, page, and font in
/// an object stream and locates everything through a cross-reference stream.
#[cfg(test)]
fn xref_stream_pdf_bytes() -> Vec<u8> {
    let mut pdf = b"%PDF-1.5\n".to_vec();
    let content = b"BT /F1 12 Tf 72 720 Td (A) Tj ET\n";
    let content_object = format!(
        "5 0 obj\n<< /Length {} >>\nstream\n{}\nendstream\nendobj\n",
        content.len(),
        String::from_utf8_lossy(content)
    );
    let compressed: [(&str, &str); 4] = [
        ("1", "<< /Type /Catalog /Pages 2 0 R >>"),
        ("2", "<< /Type /Pages /Count 1 /Kids [3 0 R] >>"),
        (
            "3",
            "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        ),
        (
            "4",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        ),
    ];
    let mut header = String::new();
    let mut body = String::new();
    for (number, object) in compressed {
        header.push_str(&format!("{number} {} ", body.len()));
        body.push_str(object);
        body.push('\n');
    }
    let object_stream = format!(
        "6 0 obj\n<< /Type /ObjStm /N {} /First {} /Length {} >>\nstream\n{header}{body}\nendstream\nendobj\n",
        compressed.len(),
        header.len(),
        header.len() + body.len() + 1
    );
    let content_offset = pdf.len();
    pdf.extend_from_slice(content_object.as_bytes());
    let object_stream_offset = pdf.len();
    pdf.extend_from_slice(object_stream.as_bytes());
    let xref_offset = pdf.len();
    let mut entries = Vec::new();
    entries.extend_from_slice(&[0, 0, 0, 0, 0, 0xFF, 0xFF]);
    for index in 0..compressed.len() as u32 {
        entries.push(2);
        entries.extend_from_slice(&6u32.to_be_bytes());
        entries.extend_from_slice(&(index as u16).to_be_bytes());
    }
    for offset in [content_offset, object_stream_offset, xref_offset] {
        entries.push(1);
        entries.extend_from_slice(&(offset as u32).to_be_bytes());
        entries.extend_from_slice(&0u16.to_be_bytes());
    }
    let mut xref = format!(
        "7 0 obj\n<< /Type /XRef /Size 8 /W [1 4 2] /Root 1 0 R /Length {} >>\nstream\n",
        entries.len()
    )
    .into_bytes();
    xref.extend_from_slice(&entries);
    xref.extend_from_slice(b"\nendstream\nendobj\n");
    pdf.extend_from_slice(&xref);
    pdf.extend_from_slice(format!("startxref\n{xref_offset}\n%%EOF\n").as_bytes());
    pdf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cross_reference_stream_expands_its_object_stream() {
        assert_eq!(
            page_texts(&xref_stream_pdf_bytes()).unwrap(),
            vec!["A".to_owned()]
        );
    }

    #[test]
    fn a_simple_page_extracts_its_text() {
        assert_eq!(
            page_texts(&simple_pdf_bytes()).unwrap(),
            vec!["A".to_owned()]
        );
    }

    #[test]
    fn an_encrypted_trailer_is_reported_separately() {
        let mut pdf = simple_pdf_bytes();
        let trailer = b"/Root 1 0 R >>";
        let position = pdf
            .windows(trailer.len())
            .position(|window| window == trailer)
            .unwrap();
        pdf.splice(position..position, b"/Encrypt 9 0 R ".iter().copied());
        assert!(matches!(page_texts(&pdf), Err(PdfError::Encrypted)));
    }

    #[test]
    fn malformed_input_is_a_parse_failure() {
        assert!(matches!(page_texts(b"not a pdf"), Err(PdfError::Other(_))));
    }
}
