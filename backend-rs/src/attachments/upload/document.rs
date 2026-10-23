// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `DocumentParser` subset `POST /api/attachments/upload` exercises:
//! attachment input validation, plain-text/markdown extraction, the OOXML
//! Word/Excel parsers, PDF text extraction, and image metadata plus base64
//! inlining (`app/services/attachment/parser.py`).
//!
//! Dispatch mirrors the source's `parse()`: the special formats with a
//! dedicated parser (PDF, Word, Excel, PowerPoint, images, video/audio,
//! archives), the known text formats, and finally the source's documented
//! error codes — the legacy `.doc`/`.xls`/`.ppt` containers and
//! `unsupported_type`. Formats whose Python parser is a third-party engine
//! this port has not migrated (XMind, CSV, and image codecs other than
//! PNG/JPEG) report `unsupported_type` rather than inventing content: the
//! source library's message would otherwise have to be fabricated.
use super::model_image;
use super::model_jpeg;
use super::office;
use super::pdf;
use super::truncation;

/// `DocumentParser.SUPPORTED_EXTENSIONS`: extension -> MIME type.
pub fn supported_mime_type(extension: &str) -> Option<&'static str> {
    Some(match extension {
        ".pdf" => "application/pdf",
        ".doc" => "application/msword",
        ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".ppt" => "application/vnd.ms-powerpoint",
        ".pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xls" => "application/vnd.ms-excel",
        ".xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".csv" => "text/csv",
        ".xmind" => "application/vnd.xmind.workbook",
        ".txt" => "text/plain",
        ".md" => "text/markdown",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".webp" => "image/webp",
        ".tif" | ".tiff" => "image/tiff",
        ".mp4" => "video/mp4",
        ".mov" => "video/quicktime",
        ".avi" => "video/x-msvideo",
        ".webm" => "video/webm",
        ".mkv" => "video/x-matroska",
        ".flv" => "video/x-flv",
        ".wmv" => "video/x-ms-wmv",
        ".m4v" => "video/x-m4v",
        ".mp3" => "audio/mpeg",
        ".wav" => "audio/wav",
        ".m4a" => "audio/mp4",
        ".aac" => "audio/aac",
        ".ogg" => "audio/ogg",
        ".flac" => "audio/flac",
        ".zip" => "application/zip",
        _ => return None,
    })
}

/// `DocumentParser.is_supported_extension`.
///
/// The source accepts every extension: known extensions are validated by
/// `SUPPORTED_EXTENSIONS`, while unknown ones proceed to MIME detection in
/// `parse()` and only fail there when the detected MIME is not text-readable.
pub fn is_supported_extension(_extension: &str) -> bool {
    true
}

/// `DocumentParser.get_mime_type`.
pub fn mime_type(extension: &str) -> &'static str {
    supported_mime_type(extension).unwrap_or("application/octet-stream")
}

/// `os.path.splitext(filename)[1].lower()`.
pub fn extension_of(filename: &str) -> String {
    match filename.rfind('.') {
        Some(index) if !filename[index..].contains('/') => filename[index..].to_lowercase(),
        _ => String::new(),
    }
}

/// `settings.MAX_UPLOAD_FILE_SIZE_MB` (deployment default 100).
pub fn max_file_size() -> i64 {
    let megabytes = crate::config::env_or_dotenv("MAX_UPLOAD_FILE_SIZE_MB")
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(100);
    megabytes * 1024 * 1024
}

/// `settings.MAX_EXTRACTED_TEXT_LENGTH` (deployment default 500000).
pub fn max_extracted_text_length() -> usize {
    crate::config::env_or_dotenv("MAX_EXTRACTED_TEXT_LENGTH")
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(500_000)
}

/// `DocumentParser.validate_file_size`.
pub fn validate_file_size(size: i64) -> bool {
    size <= max_file_size()
}

/// `multimodal_media_type(extension) == "video"`: video is not text-parseable.
pub fn is_video(extension: &str) -> bool {
    matches!(
        extension,
        ".mp4" | ".avi" | ".mkv" | ".mov" | ".flv" | ".wmv"
    )
}

/// `ParseResult`.
#[derive(Debug)]
pub struct ParseResult {
    pub text: String,
    pub text_length: i64,
    pub image_base64: Option<String>,
    pub truncation_info: Option<serde_json::Value>,
}

/// `DocumentParseError` (message, error_code).
#[derive(Debug)]
pub struct DocumentParseError {
    pub message: String,
    pub error_code: &'static str,
}

impl DocumentParseError {
    fn unsupported(message: String) -> Self {
        Self {
            message,
            error_code: "unsupported_type",
        }
    }

    /// `parse()`'s MIME-detection rejection for an unknown non-text extension.
    fn unrecognized(extension: &str) -> Self {
        Self {
            message: format!(
                "Unrecognized file type: {extension} (detected MIME: application/octet-stream)"
            ),
            error_code: "unrecognized_type",
        }
    }

    /// `DocumentParseError.LEGACY_*`: the source rejects the pre-OOXML
    /// containers before it reaches a parser.
    fn legacy(format: &str, error_code: &'static str) -> Self {
        Self {
            message: format!(
                "Legacy {format} format is not fully supported. Please convert to {format}x"
            ),
            error_code,
        }
    }

    /// `parse()`'s `except Exception` branch, which wraps a library failure.
    fn parse_failed(document: &str, cause: &str) -> Self {
        Self {
            message: format!("Failed to parse {document}: {cause}"),
            error_code: "parse_failed",
        }
    }
}

/// `DocumentParser.parse(binary_data, extension)`: the special formats with a
/// dedicated parser this port still lacks, the known text extensions, and the
/// source's MIME-detected fallback for unknown extensions.
pub fn parse(binary_data: &[u8], extension: &str) -> Result<ParseResult, DocumentParseError> {
    let max_length = max_extracted_text_length();
    if is_video(extension) {
        return Ok(ParseResult {
            text: String::new(),
            text_length: 0,
            image_base64: None,
            truncation_info: None,
        });
    }
    match extension {
        // `SPECIAL_FORMAT_EXTENSIONS` with a dedicated parser.
        ".doc" => Err(DocumentParseError::legacy(".doc", "legacy_doc")),
        ".docx" => word_result(binary_data, max_length),
        ".xls" => Err(DocumentParseError::legacy(".xls", "legacy_xls")),
        ".xlsx" => excel_result(binary_data, max_length),
        ".ppt" => Err(DocumentParseError::legacy(".ppt", "legacy_ppt")),
        ".pptx" => powerpoint_result(binary_data, max_length),
        ".pdf" => pdf_result(binary_data, max_length),
        ".txt" | ".md" => Ok(text_result(binary_data, max_length)),
        ".zip" => Ok(archive_result(binary_data, extension)),
        _ => {
            if let Some(metadata) = image_metadata(binary_data, extension) {
                return Ok(metadata);
            }
            if matches!(
                extension,
                ".mp4"
                    | ".mov"
                    | ".avi"
                    | ".webm"
                    | ".mkv"
                    | ".m4v"
                    | ".mp3"
                    | ".wav"
                    | ".m4a"
                    | ".aac"
                    | ".ogg"
                    | ".flac"
            ) {
                // `text = ""`: binary media carry no text at this stage.
                return Ok(ParseResult {
                    text: String::new(),
                    text_length: 0,
                    image_base64: None,
                    truncation_info: None,
                });
            }
            // The remaining special formats still need a third-party engine this
            // port has not migrated: XMind, CSV, and the non-PNG/JPEG image
            // codecs.
            if matches!(
                extension,
                ".xmind"
                    | ".csv"
                    | ".jpg"
                    | ".jpeg"
                    | ".png"
                    | ".gif"
                    | ".bmp"
                    | ".webp"
                    | ".tif"
                    | ".tiff"
            ) {
                return Err(DocumentParseError::unsupported(format!(
                    "Unsupported file type: {extension}"
                )));
            }
            // Unknown extension: `detect_mime_type` plus `is_text_mime_type`.
            // The detected MIME for these files is `text/plain` or `text/html`
            // (both text-readable); binary content is rejected with the source's
            // `unrecognized_type`.
            if text_readable_content(binary_data) {
                return Ok(text_result(binary_data, max_length));
            }
            Err(DocumentParseError::unrecognized(extension))
        }
    }
}

/// Bound CPU-heavy document and image parsing on Tokio's blocking pool.
pub async fn parse_async(
    binary_data: &[u8],
    extension: &str,
) -> Result<ParseResult, DocumentParseError> {
    static PARSERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    let permit = PARSERS
        .acquire()
        .await
        .map_err(|_| DocumentParseError::parse_failed("attachment", "parser is shutting down"))?;
    let binary_data = binary_data.to_vec();
    let extension = extension.to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        parse(&binary_data, &extension)
    })
    .await
    .map_err(|_| DocumentParseError::parse_failed("attachment", "parser worker failed"))?
}

/// `detect_mime_type` + `is_text_mime_type`: whether libmagic would classify
/// the bytes as a text-readable MIME type. The source accepts the `text/*`
/// family plus a few structured suffixes; content without NUL bytes that
/// decodes as text is the set that matters here.
fn text_readable_content(binary_data: &[u8]) -> bool {
    // libmagic reports an empty buffer as `application/x-empty`, which the
    // source does not treat as text-readable.
    if binary_data.is_empty() {
        return false;
    }
    let sample = &binary_data[..binary_data.len().min(8192)];
    if sample.contains(&0) {
        return false;
    }
    let control = sample
        .iter()
        .filter(|byte| **byte < 0x20 && !matches!(**byte, b'\t' | b'\n' | b'\r' | 0x0c | 0x08))
        .count();
    control * 100 <= sample.len() * 5 && std::str::from_utf8(binary_data).is_ok()
}

/// `_parse_archive`: the archive's metadata text (`_parse_archive`).
fn archive_result(binary_data: &[u8], extension: &str) -> ParseResult {
    let mut text = format!(
        "[压缩文件]\n格式: {}\n文件大小: {} 字节",
        extension[1..].to_ascii_uppercase(),
        binary_data.len()
    );
    if extension == ".zip" {
        match office::zip::ZipArchive::new(binary_data) {
            Ok(archive) => {
                let names = archive.names();
                text.push_str(&format!("\n包含文件数: {}", names.len()));
                if !names.is_empty() {
                    let preview = names.len().min(10);
                    text.push_str(&format!("\n\n文件列表 (前 {preview} 个):"));
                    for name in &names[..preview] {
                        text.push_str(&format!("\n  - {name}"));
                    }
                    if names.len() > preview {
                        text.push_str(&format!("\n  ... 还有 {} 个文件", names.len() - preview));
                    }
                }
            }
            Err(_) => text.push_str("\n(无法读取压缩包内容)"),
        }
    }
    ParseResult {
        text_length: text.chars().count() as i64,
        text,
        image_base64: None,
        truncation_info: None,
    }
}

/// `_parse_word_smart`: paragraphs then table rows, joined with `\n\n`.
fn word_result(binary_data: &[u8], max_length: usize) -> Result<ParseResult, DocumentParseError> {
    let extracted = office::word::extract(binary_data)
        .map_err(|_| DocumentParseError::parse_failed("Word document", "unreadable package"))?;
    let truncated = truncation::word_paragraphs(&extracted.collected(), max_length);
    let (text, text_length) = (truncated.text.clone(), truncated.truncated_length as i64);
    Ok(ParseResult {
        text,
        text_length,
        image_base64: None,
        truncation_info: truncated_info(&truncated),
    })
}

/// `_parse_powerpoint_smart`: per-slide text then the slide-based head/tail
/// truncation strategy.
fn powerpoint_result(
    binary_data: &[u8],
    max_length: usize,
) -> Result<ParseResult, DocumentParseError> {
    let extracted = office::powerpoint::extract(binary_data)
        .map_err(|_| DocumentParseError::parse_failed("PowerPoint", "unreadable package"))?;
    let truncated = truncation::powerpoint_slides(&extracted.slides, max_length);
    let (text, text_length) = (truncated.text.clone(), truncated.truncated_length as i64);
    Ok(ParseResult {
        text,
        text_length,
        image_base64: None,
        truncation_info: truncated_info(&truncated),
    })
}

/// `_parse_excel_smart`: complete rows per sheet, joined with `\n\n`.
fn excel_result(binary_data: &[u8], max_length: usize) -> Result<ParseResult, DocumentParseError> {
    let sheets = office::excel::read_sheets(binary_data)
        .map_err(|_| DocumentParseError::parse_failed("Excel", "unreadable package"))?;
    let truncated = truncation::excel_sheets(&sheets, max_length);
    let (text, text_length) = (truncated.text.clone(), truncated.truncated_length as i64);
    Ok(ParseResult {
        text,
        text_length,
        image_base64: None,
        truncation_info: truncated_info(&truncated),
    })
}

/// `_parse_pdf_smart`: PyPDF2 page extraction plus the page-based head/tail
/// truncation strategy.
fn pdf_result(binary_data: &[u8], max_length: usize) -> Result<ParseResult, DocumentParseError> {
    let pages = pdf::page_texts(binary_data).map_err(|error| match error {
        pdf::PdfError::Encrypted => DocumentParseError {
            message: "Cannot parse encrypted PDF file".to_owned(),
            error_code: "encrypted_pdf",
        },
        pdf::PdfError::Other(cause) => DocumentParseError::parse_failed("PDF", &cause),
    })?;
    let truncated = truncation::pdf_pages(&pages, max_length);
    let (text, text_length) = (truncated.text.clone(), truncated.truncated_length as i64);
    Ok(ParseResult {
        text,
        text_length,
        image_base64: None,
        truncation_info: truncated_info(&truncated),
    })
}

/// `TruncationInfo.from_smart_info`: only a real truncation is reported.
fn truncated_info(truncated: &truncation::Truncated) -> Option<serde_json::Value> {
    if !truncated.is_truncated {
        return None;
    }
    Some(serde_json::json!({
        "is_truncated": true,
        "original_length": truncated.original_length,
        "truncated_length": truncated.truncated_length,
        "truncation_message_key": "content_truncated",
    }))
}

/// `_parse_text_format`: decode the bytes and apply the smart text strategy
/// (`TextTruncationStrategy`: a contiguous head and tail of lines).
fn text_result(binary_data: &[u8], max_length: usize) -> ParseResult {
    let text = decode_text(binary_data);
    let truncated = truncation::text_lines(&text, max_length);
    let truncation_info = truncated_info(&truncated);
    ParseResult {
        text_length: truncated.text.chars().count() as i64,
        text: truncated.text,
        image_base64: None,
        truncation_info,
    }
}

/// `_decode_binary_data`: UTF-8 first, then a permissive fallback.
fn decode_text(binary_data: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(binary_data) {
        return text.to_owned();
    }
    // The source then tries GB18030/GBK/Big5 before latin-1; this target keeps
    // the always-succeeding latin-1 fallback for undecodable input.
    binary_data.iter().map(|byte| *byte as char).collect()
}

/// `_parse_image`: the metadata text plus the base64 model payload. Only PNG
/// metadata is decoded exactly; other image formats report the dimensions they
/// carry with `image_base64` inlined.
///
/// The dimensions and payload come from `prepare_image_bytes_for_model`
/// (`model_image`): an image whose long edge exceeds 1568 is resized and
/// re-encoded, while the reported format, mode, EXIF flag, and byte size stay
/// those of the original upload.
fn image_metadata(binary_data: &[u8], extension: &str) -> Option<ParseResult> {
    let (format_name, width, height, mode, has_exif, image_base64) = match extension {
        ".png" => {
            let (format, width, height, mode, has_exif) = png_metadata(binary_data)?;
            let (base64, prepared_size) = model_image::inline_image(binary_data);
            let (width, height) = prepared_size.unwrap_or((width, height));
            (format, width, height, mode, has_exif, base64)
        }
        ".jpg" | ".jpeg" => {
            if let Some(image) = model_jpeg::prepare(binary_data) {
                (
                    image.format.to_owned(),
                    image.width,
                    image.height,
                    image.mode.to_owned(),
                    image.has_exif,
                    image.image_base64,
                )
            } else {
                // `Image.open` detects the content format from the bytes, not
                // the filename: a PNG upload named `.jpg` is decoded as PNG
                // while the extension's MIME keeps JPEG as the output format.
                let (format, width, height, mode, has_exif) = png_metadata(binary_data)?;
                let (base64, prepared_size) = model_jpeg::prepare_png_as_jpeg(binary_data);
                let (width, height) = prepared_size.unwrap_or((width, height));
                (format, width, height, mode, has_exif, base64)
            }
        }
        _ => return None,
    };
    let mut text = String::from("[图片文件]\n");
    text.push_str(&format!("格式: {format_name}\n"));
    text.push_str(&format!("尺寸: {width} x {height} 像素\n"));
    text.push_str(&format!("颜色模式: {mode}\n"));
    text.push_str(&format!("文件大小: {} 字节", binary_data.len()));
    if has_exif {
        text.push_str("\n\n[EXIF 信息]\n包含 EXIF 元数据");
    }
    Some(ParseResult {
        text_length: text.chars().count() as i64,
        text,
        image_base64: Some(image_base64),
        truncation_info: None,
    })
}

/// PIL's `Image.open(...).format/size/mode` for a PNG: `IHDR` gives the
/// dimensions and color type, and an `eXIf` chunk supplies `_getexif()`.
fn png_metadata(binary_data: &[u8]) -> Option<(String, u32, u32, String, bool)> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if binary_data.len() < 33 || &binary_data[..8] != SIGNATURE {
        return None;
    }
    let width = u32::from_be_bytes(binary_data[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(binary_data[20..24].try_into().ok()?);
    let bit_depth = binary_data[24];
    let color_type = binary_data[25];
    let mode = match (color_type, bit_depth) {
        (0, 1) => "1",
        (0, 16) => "I;16",
        (0, _) => "L",
        (2, _) => "RGB",
        (3, _) => "P",
        (4, _) => "LA",
        (6, _) => "RGBA",
        _ => "RGB",
    };
    let has_exif = png_has_exif_chunk(binary_data);
    Some(("PNG".to_string(), width, height, mode.to_string(), has_exif))
}

/// Scan the PNG chunk stream for an `eXIf` chunk (`PngImagePlugin` reads it
/// into `info["exif"]`, which `_getexif()` returns).
fn png_has_exif_chunk(binary_data: &[u8]) -> bool {
    let mut offset = 8;
    while offset + 8 <= binary_data.len() {
        let length =
            u32::from_be_bytes(binary_data[offset..offset + 4].try_into().unwrap_or([0; 4]))
                as usize;
        let chunk_type = &binary_data[offset + 4..offset + 8];
        if chunk_type == b"eXIf" {
            return true;
        }
        if chunk_type == b"IEND" {
            return false;
        }
        offset = match offset
            .checked_add(12)
            .and_then(|next| next.checked_add(length))
        {
            Some(next) => next,
            None => return false,
        };
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_extensions_keep_their_length() {
        let markdown = b"## title\n\nbody";
        let parsed = parse(markdown, ".md").expect("text parses");
        assert_eq!(parsed.text, "## title\n\nbody");
        assert_eq!(parsed.text_length, 14);
        assert!(parsed.image_base64.is_none());
    }

    #[test]
    fn legacy_containers_keep_the_source_error_codes() {
        for (extension, code, format) in [
            (".doc", "legacy_doc", ".doc"),
            (".xls", "legacy_xls", ".xls"),
            (".ppt", "legacy_ppt", ".ppt"),
        ] {
            let error = parse(b"legacy", extension).expect_err("legacy format is rejected");
            assert_eq!(error.error_code, code);
            assert_eq!(
                error.message,
                format!(
                    "Legacy {format} format is not fully supported. Please convert to {format}x"
                )
            );
        }
    }

    #[test]
    fn a_word_package_that_cannot_be_read_is_a_parse_failure() {
        let error = parse(b"not a package", ".docx").expect_err("unreadable package");
        assert_eq!(error.error_code, "parse_failed");
        assert!(error.message.starts_with("Failed to parse Word document: "));
        let error = parse(b"not a package", ".xlsx").expect_err("unreadable package");
        assert_eq!(error.error_code, "parse_failed");
        assert!(error.message.starts_with("Failed to parse Excel: "));
    }

    #[test]
    fn an_archive_reports_its_listing_or_that_it_cannot_be_read() {
        let archive = office::zip::stored_archive(&[("one.txt", b"1"), ("dir/", b"")]);
        let parsed = parse(&archive, ".zip").expect("archive parses");
        assert_eq!(
            parsed.text,
            format!(
                "[压缩文件]\n格式: ZIP\n文件大小: {} 字节\n包含文件数: 2\n\n文件列表 (前 2 个):\n  - one.txt\n  - dir/",
                archive.len()
            )
        );
        let broken = parse(b"PK\x03\x04 not a zip", ".zip").expect("listing failure is text");
        assert!(broken.text.ends_with("\n(无法读取压缩包内容)"));
    }

    #[test]
    fn unknown_extensions_follow_the_detected_mime_type() {
        // `is_supported_extension` accepts everything; `parse()` rejects only a
        // non-text MIME type, so octet-stream content keeps `unrecognized_type`.
        let error = parse(b"\x00\x01\x02\x03", ".exe").expect_err("binary is unrecognized");
        assert_eq!(error.error_code, "unrecognized_type");
        assert_eq!(
            error.message,
            "Unrecognized file type: .exe (detected MIME: application/octet-stream)"
        );
        let error = parse(b"", ".exe").expect_err("an empty file is unrecognized");
        assert_eq!(error.error_code, "unrecognized_type");
        let parsed = parse(b"<!DOCTYPE html><p>hi</p>", ".html").expect("text parses");
        assert_eq!(parsed.text, "<!DOCTYPE html><p>hi</p>");
        assert!(is_supported_extension(".md"));
        assert!(is_supported_extension(".png"));
        assert!(is_supported_extension(".exe"));
    }

    #[test]
    fn long_text_keeps_a_line_head_and_tail() {
        let lines: Vec<String> = (1..=400).map(|index| format!("line {index}")).collect();
        let text = lines.join("\n");
        let parsed = parse(text.as_bytes(), ".md").expect("text parses");
        // 400 nine/ten-character lines against the default 500000-character
        // budget fit, so the small budget is exercised directly instead.
        assert!(!parsed.text.contains("lines omitted"));
        let truncated = truncation::text_lines(&text, 400);
        assert!(truncated.is_truncated);
        assert!(truncated.text.starts_with("# Head Section (lines 1-"));
        assert!(truncated.text.contains("lines omitted"));
        assert!(truncated.text.contains("# Tail Section (lines "));
        assert!(truncated.text.ends_with("line 400"));
    }

    #[test]
    fn png_metadata_matches_pillow_shape() {
        // A 2x1 RGBA PNG with an eXIf chunk.
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&2u32.to_be_bytes());
        png.extend_from_slice(&1u32.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&[0, 0, 0, 0]); // IHDR CRC placeholder
        png.extend_from_slice(&4u32.to_be_bytes());
        png.extend_from_slice(b"eXIf");
        png.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0, 0, 0, 0]);
        let parsed = parse(&png, ".png").expect("png parses");
        assert!(parsed.text.contains("尺寸: 2 x 1 像素"));
        assert!(parsed.text.contains("颜色模式: RGBA"));
        assert!(parsed.text.contains("[EXIF 信息]"));
        assert!(parsed.image_base64.is_some());
    }

    #[test]
    fn pdf_dispatch_reads_the_page_text() {
        let pdf = pdf::simple_pdf_bytes();
        let parsed = parse(&pdf, ".pdf").expect("pdf parses");
        assert_eq!(parsed.text, "--- Page 1 ---\nA");
        assert_eq!(parsed.text_length, 16);
        assert!(parsed.truncation_info.is_none());
    }

    #[test]
    fn encrypted_pdf_reports_the_source_error_code() {
        let mut pdf = pdf::simple_pdf_bytes();
        let trailer = b"/Root 1 0 R >>";
        let position = pdf
            .windows(trailer.len())
            .position(|window| window == trailer)
            .unwrap();
        pdf.splice(position..position, b"/Encrypt 9 0 R ".iter().copied());
        let error = parse(&pdf, ".pdf").expect_err("encrypted pdf fails");
        assert_eq!(error.error_code, "encrypted_pdf");
        assert_eq!(error.message, "Cannot parse encrypted PDF file");
    }
}
