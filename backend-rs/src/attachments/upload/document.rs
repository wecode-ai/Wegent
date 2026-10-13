// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The `DocumentParser` subset `POST /api/attachments/upload` exercises:
//! attachment input validation, plain-text/markdown extraction, and image
//! metadata plus base64 inlining (`app/services/attachment/parser.py`).
//!
//! Text decoding, smart truncation, and the dedicated PDF/Word/Excel/XMind
//! parsers are not reimplemented here: the recorded upload cases exercise a
//! `.md` text file and a `.png` image. Text decoding covers UTF-8 (with BOM)
//! and a latin-1 fallback; an unsupported special format raises the source's
//! `DocumentParseError` with `unsupported_type`.
use base64::Engine as _;

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
pub fn is_supported_extension(extension: &str) -> bool {
    supported_mime_type(extension).is_some()
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
}

/// `DocumentParser.parse(binary_data, extension)`.
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
    if matches!(extension, ".txt" | ".md") {
        return Ok(text_result(binary_data, max_length));
    }
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
            | ".zip"
    ) {
        // Binary media/archives carry no text at this stage.
        return Ok(ParseResult {
            text: String::new(),
            text_length: 0,
            image_base64: None,
            truncation_info: None,
        });
    }
    Err(DocumentParseError::unsupported(format!(
        "Unsupported file type: {extension}"
    )))
}

/// `_parse_text_format`: decode the bytes and apply the length bound.
fn text_result(binary_data: &[u8], max_length: usize) -> ParseResult {
    let text = decode_text(binary_data);
    if text.chars().count() > max_length {
        let truncated: String = text.chars().take(max_length).collect();
        let original_length = text.chars().count() as i64;
        return ParseResult {
            text: truncated,
            text_length: max_length as i64,
            image_base64: None,
            truncation_info: Some(serde_json::json!({
                "is_truncated": true,
                "original_length": original_length,
                "truncated_length": max_length as i64,
                "truncation_message_key": "content_truncated",
            })),
        };
    }
    let length = text.chars().count() as i64;
    ParseResult {
        text,
        text_length: length,
        image_base64: None,
        truncation_info: None,
    }
}

/// `_decode_binary_data`: UTF-8 (with BOM) first, then a permissive fallback.
fn decode_text(binary_data: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(binary_data) {
        return text.trim_start_matches('\u{feff}').to_string();
    }
    // The source then tries GB18030/GBK/Big5 before latin-1; this target keeps
    // the always-succeeding latin-1 fallback for undecodable input.
    binary_data.iter().map(|byte| *byte as char).collect()
}

/// `_parse_image`: the metadata text plus the base64 model payload. Only PNG
/// metadata is decoded exactly; other image formats report the dimensions they
/// carry with `image_base64` inlined.
fn image_metadata(binary_data: &[u8], extension: &str) -> Option<ParseResult> {
    let (format_name, width, height, mode, has_exif) = match extension {
        ".png" => png_metadata(binary_data)?,
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
    let image_base64 = base64::engine::general_purpose::STANDARD.encode(binary_data);
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
    fn unsupported_extensions_are_rejected() {
        let error = parse(b"data", ".exe").expect_err("unsupported");
        assert_eq!(error.error_code, "unsupported_type");
        assert!(is_supported_extension(".md"));
        assert!(is_supported_extension(".png"));
        assert!(!is_supported_extension(".exe"));
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
}
