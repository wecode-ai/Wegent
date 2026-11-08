//! Bounded document evidence shared by conversation uploads and project deliveries.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;

pub(crate) const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
pub(crate) const CHUNK_BYTES: usize = 8 * 1024;
const DOCUMENT_BYTE_BUDGET: usize = 64 * 1024 * 1024;

pub(crate) fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("attachment_evidence_unavailable", message)
}

fn require_document_text(format: &str, text: String) -> Result<String, AppIpcError> {
    if text.trim().is_empty() {
        return Err(invalid(&format!(
            "{format} has no extractable text; visual content has not been read and may require OCR",
        )));
    }
    Ok(text)
}

pub(crate) fn decode_attachment_text(
    bytes: Vec<u8>,
    control: wegent_document_parser::ParseControl,
) -> Result<String, AppIpcError> {
    if bytes.starts_with(b"%PDF-") {
        let pages = wegent_document_parser::pdf::page_texts_controlled(
            &bytes,
            DOCUMENT_BYTE_BUDGET,
            control,
        )
        .map_err(|error| {
            invalid(&format!(
                "PDF evidence could not be read completely: {error:?}"
            ))
        })?;
        return require_document_text("PDF", pages.join("\n"));
    }
    if bytes.starts_with(b"PK\x03\x04") {
        let archive = wegent_document_parser::office::zip::ZipArchive::controlled(
            &bytes,
            DOCUMENT_BYTE_BUDGET,
            control,
        )
        .map_err(|_| invalid("Office archive is unreadable, cancelled or exceeds its budget"))?;
        if archive.names().contains(&"word/document.xml") {
            let word = wegent_document_parser::office::word::extract_with_text_limit(
                &archive,
                DOCUMENT_BYTE_BUDGET,
            )
            .map_err(|_| invalid("Word evidence could not be read completely"))?;
            return require_document_text("Word document", word.document_text());
        }
        if archive.names().contains(&"ppt/presentation.xml") {
            return wegent_document_parser::office::powerpoint::extract_with_text_limit(
                &archive,
                DOCUMENT_BYTE_BUDGET,
            )
            .map_err(|_| invalid("PowerPoint evidence could not be read completely"))
            .and_then(|presentation| {
                require_document_text("PowerPoint document", presentation.slides.join("\n"))
            });
        }
        if archive.names().contains(&"xl/workbook.xml") {
            return wegent_document_parser::office::excel::read_text_with_limits(
                &archive,
                DOCUMENT_BYTE_BUDGET,
                DOCUMENT_BYTE_BUDGET,
            )
            .map_err(|_| invalid("Excel evidence could not be read completely"))
            .and_then(|text| require_document_text("Excel workbook", text));
        }
        return Err(invalid(
            "Attachment requires another document or archive reader",
        ));
    }
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little_endian = bytes[0] == 0xff;
        let payload = &bytes[2..];
        if payload.len() % 2 != 0 {
            return Err(invalid("Attachment contains incomplete UTF-16 text"));
        }
        let units: Vec<_> = payload
            .chunks_exact(2)
            .map(|pair| {
                if little_endian {
                    u16::from_le_bytes([pair[0], pair[1]])
                } else {
                    u16::from_be_bytes([pair[0], pair[1]])
                }
            })
            .collect();
        String::from_utf16(&units)
            .map_err(|_| invalid("Attachment contains invalid UTF-16 text"))?
    } else {
        String::from_utf8(bytes)
            .map_err(|_| invalid("Attachment is not UTF-8 or BOM-marked UTF-16 text"))?
    };
    if text.contains('\0') {
        return Err(invalid("Attachment requires a document or binary reader"));
    }
    Ok(text)
}

#[cfg(test)]
pub(crate) async fn read_document(path: String) -> Result<Value, AppIpcError> {
    read_document_input(path, false).await
}

/// Image bytes stay inside the host; callers must never return data URLs as tool output.
pub(crate) async fn read_document_input(path: String, images: bool) -> Result<Value, AppIpcError> {
    super::transcript_work::run(move |cancel| {
        use std::io::Read;
        cancel.check()?;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options
            .open(path)
            .map_err(|_| invalid("Attachment file is unavailable"))?;
        let metadata = file
            .metadata()
            .map_err(|_| invalid("Attachment metadata is unavailable"))?;
        if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
            return Err(invalid(
                "Attachment is not a regular file within the 8 MiB read limit",
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_TEXT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("Attachment could not be read"))?;
        cancel.check()?;
        if bytes.len() as u64 > MAX_TEXT_BYTES {
            return Err(invalid("Attachment exceeds the 8 MiB read limit"));
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        if images {
            if let Some(mime) = static_image_mime(&bytes)? {
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                return Ok(json!({"kind":"image","contentHash":hash,
                    "dataUrl":format!("data:{mime};base64,{encoded}")}));
            }
        }
        let cancellation = cancel.clone();
        let control = wegent_document_parser::ParseControl::new(
            Some(std::time::Instant::now() + std::time::Duration::from_secs(30)),
            move || cancellation.check().is_err(),
        );
        let text = decode_attachment_text(bytes, control)?;
        cancel.check()?;
        Ok(json!({"content":text,"contentHash":hash}))
    })
    .await
}
#[cfg(test)]
pub(crate) async fn read_text(
    path: String,
    offset: usize,
    expected_hash: Option<String>,
) -> Result<Value, AppIpcError> {
    let document = read_document(path).await?;
    document_chunk(&document, offset, expected_hash)
}

pub(crate) fn document_chunk(
    document: &Value,
    offset: usize,
    expected_hash: Option<String>,
) -> Result<Value, AppIpcError> {
    if expected_hash
        .as_ref()
        .is_some_and(|expected| document["contentHash"] != *expected)
    {
        return Err(invalid(
            "Attachment changed; restart reading at offset zero",
        ));
    }
    let text = document["content"]
        .as_str()
        .expect("Document content is text");
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err(invalid("Invalid attachment content offset"));
    }
    let mut end = offset.saturating_add(CHUNK_BYTES).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut chunk = json!({"content":&text[offset..end],"contentHash":document["contentHash"],"offset":offset,
        "nextOffset":(end < text.len()).then_some(end),"contentComplete":end == text.len(),
        "totalContentBytes":text.len()});
    if document["evidenceKind"].is_string() {
        chunk["evidenceKind"] = document["evidenceKind"].clone();
    }
    Ok(chunk)
}

fn static_image_mime(bytes: &[u8]) -> Result<Option<&'static str>, AppIpcError> {
    use image::{ImageDecoder, ImageFormat, ImageReader};
    use std::io::Cursor;
    let Ok(format) = image::guess_format(bytes) else {
        return Ok(None);
    };
    let mime = match format {
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes))
                .map_err(|_| invalid("Image header is unreadable"))?;
            if decoder
                .is_apng()
                .map_err(|_| invalid("Image animation metadata is unreadable"))?
            {
                return Err(invalid("Animated images require a multi-frame reader"));
            }
            "image/png"
        }
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => {
            let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
                .map_err(|_| invalid("Image header is unreadable"))?;
            if decoder.has_animation() {
                return Err(invalid("Animated images require a multi-frame reader"));
            }
            "image/webp"
        }
        _ => return Err(invalid("This image format requires another image reader")),
    };
    let decoder = ImageReader::with_format(Cursor::new(bytes), format)
        .into_decoder()
        .map_err(|_| invalid("Image header is unreadable"))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16_000_000
    {
        return Err(invalid(
            "Image exceeds the 8192-side or 16-megapixel read limit",
        ));
    }
    Ok(Some(mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_webp_animation_requires_all_frames_not_a_static_observation() {
        use image::AnimationDecoder;
        use std::io::Cursor;

        fn chunk(output: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
            output.extend_from_slice(kind);
            output.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            output.extend_from_slice(payload);
            if payload.len() % 2 != 0 {
                output.push(0);
            }
        }

        let mut still = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(1, 1)
            .write_to(&mut still, image::ImageFormat::WebP)
            .unwrap();
        assert_eq!(&still.get_ref()[12..16], b"VP8L");
        let mut body = b"WEBP".to_vec();
        chunk(&mut body, b"VP8X", &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        chunk(&mut body, b"ANIM", &[0; 6]);
        let mut frame = vec![0; 16];
        frame.extend_from_slice(&still.get_ref()[12..]);
        chunk(&mut body, b"ANMF", &frame);
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend(body);

        let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(&bytes)).unwrap();
        assert!(decoder.has_animation());
        assert_eq!(decoder.into_frames().collect_frames().unwrap().len(), 1);
        let error = static_image_mime(&bytes).unwrap_err();
        assert!(error.message.contains("multi-frame reader"));
    }

    #[test]
    fn memory_office_without_extractable_text_is_not_complete_evidence() {
        use wegent_document_parser::office::zip::stored_archive;
        let word = stored_archive(&[(
            "word/document.xml",
            b"<w:document><w:body><w:p><w:r><w:drawing/></w:r></w:p></w:body></w:document>",
        )]);
        let slides = stored_archive(&[
            ("ppt/presentation.xml", b"<p:presentation><p:sldIdLst><p:sldId id=\"1\" r:id=\"slide\"/></p:sldIdLst></p:presentation>"),
            ("ppt/_rels/presentation.xml.rels", b"<Relationships><Relationship Id=\"slide\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/></Relationships>"),
            ("ppt/slides/slide1.xml", b"<p:sld><p:cSld><p:spTree><p:pic/></p:spTree></p:cSld></p:sld>"),
        ]);
        for bytes in [word, slides] {
            let error = decode_attachment_text(bytes, Default::default()).unwrap_err();
            assert_eq!(error.code, "attachment_evidence_unavailable");
            assert!(
                error.message.contains("no extractable text"),
                "{}",
                error.message
            );
        }
    }

    #[tokio::test]
    async fn memory_pdf_without_extractable_text_is_incomplete_not_empty_evidence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("document.pdf");
        for contents in [
            "",
            "BT /F1 12 Tf (   ) Tj ET",
            "q 100 0 0 100 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI Q",
        ] {
            let bytes = wegent_document_parser::pdf::pdf_bytes_with_page_contents(&[contents]);
            // The text-only parser succeeds; memory must not mistake that for coverage.
            assert!(wegent_document_parser::pdf::page_texts(&bytes).is_ok());
            fs::write(&path, bytes).unwrap();
            let error = read_document_input(path.to_str().unwrap().into(), true)
                .await
                .unwrap_err();
            assert_eq!(error.code, "attachment_evidence_unavailable");
            assert!(error.message.contains("no extractable text"));
            assert!(error.message.contains("visual content has not been read"));
        }
        fs::write(&path, wegent_document_parser::pdf::simple_pdf_bytes()).unwrap();
        let document = read_document_input(path.to_str().unwrap().into(), true)
            .await
            .unwrap();
        assert_eq!(document["content"], "A");
        // Empty plain text is genuinely empty, unlike an unrendered PDF.
        fs::write(&path, b"").unwrap();
        assert_eq!(
            read_document_input(path.to_str().unwrap().into(), true)
                .await
                .unwrap()["content"],
            ""
        );
    }

    #[tokio::test]
    async fn memory_image_snapshot_preserves_bytes_and_enforces_format_and_dimension_limits() {
        use base64::Engine;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("registered-upload");
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::WebP,
        ] {
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(2, 1)
                .write_to(&mut bytes, format)
                .unwrap();
            fs::write(&path, bytes.get_ref()).unwrap();
            let snapshot = read_document_input(path.to_str().unwrap().into(), true)
                .await
                .unwrap();
            assert_eq!(
                snapshot["contentHash"],
                format!("{:x}", Sha256::digest(bytes.get_ref()))
            );
            let data = snapshot["dataUrl"]
                .as_str()
                .unwrap()
                .split_once(',')
                .unwrap()
                .1;
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .unwrap(),
                *bytes.get_ref()
            );
            assert!(read_document(path.to_str().unwrap().into()).await.is_err());
        }
        let mut large = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(8193, 1)
            .write_to(&mut large, image::ImageFormat::Png)
            .unwrap();
        fs::write(&path, large.get_ref()).unwrap();
        assert!(read_document_input(path.to_str().unwrap().into(), true)
            .await
            .is_err());
        for bytes in [b"GIF89a".as_slice(), b"\x89PNG\r\n\x1a\n"] {
            fs::write(&path, bytes).unwrap();
            assert!(read_document_input(path.to_str().unwrap().into(), true)
                .await
                .is_err());
        }
        fs::write(&path, "ordinary text").unwrap();
        assert_eq!(
            read_document_input(path.to_str().unwrap().into(), true)
                .await
                .unwrap()["content"],
            "ordinary text"
        );
    }
}
