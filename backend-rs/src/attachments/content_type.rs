// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `Content-Type` rendering for stored-attachment responses.
//!
//! Every `_stream_stored_attachment` caller passes
//! `context.mime_type or "application/octet-stream"` as the Starlette
//! `StreamingResponse` `media_type`, and `Response.init_headers`
//! (`starlette/responses.py`) appends `; charset=utf-8` to a media type that
//! starts with `text/` and does not already carry a charset. The recorded
//! `text/plain` download therefore carries `; charset=utf-8`, while the
//! recorded non-text media types are forwarded unchanged.

use std::borrow::Cow;

/// `context.mime_type or "application/octet-stream"`.
const DEFAULT_MEDIA_TYPE: &str = "application/octet-stream";

/// `"charset="` — the marker Starlette searches for in a media type.
const CHARSET_MARKER: &[u8] = b"charset=";

/// The `Content-Type` value the source sends for a stored attachment.
///
/// Starlette tests the raw `text/` prefix (case-sensitive) but searches for an
/// existing charset case-insensitively.
pub(super) fn content_type_value(mime_type: &str) -> Cow<'_, str> {
    let media_type = if mime_type.is_empty() {
        DEFAULT_MEDIA_TYPE
    } else {
        mime_type
    };
    let carries_charset = media_type
        .as_bytes()
        .windows(CHARSET_MARKER.len())
        .any(|window| window.eq_ignore_ascii_case(CHARSET_MARKER));
    if media_type.starts_with("text/") && !carries_charset {
        return Cow::Owned(format!("{media_type}; charset=utf-8"));
    }
    Cow::Borrowed(media_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_media_types_get_the_starlette_charset() {
        // The recorded `Content-Type` of the `.md`, `.txt`, and `.csv` cases.
        assert_eq!(
            content_type_value("text/markdown").as_ref(),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            content_type_value("text/plain").as_ref(),
            "text/plain; charset=utf-8"
        );
        assert_eq!(
            content_type_value("text/csv").as_ref(),
            "text/csv; charset=utf-8"
        );
    }

    #[test]
    fn non_text_media_types_are_unchanged() {
        // The recorded `.png` and `.docx` downloads.
        assert_eq!(content_type_value("image/png").as_ref(), "image/png");
        assert_eq!(
            content_type_value(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
            .as_ref(),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(
            content_type_value("application/octet-stream").as_ref(),
            "application/octet-stream"
        );
        // The source's `context.mime_type or "application/octet-stream"`.
        assert_eq!(content_type_value("").as_ref(), "application/octet-stream");
    }

    #[test]
    fn existing_charsets_are_preserved() {
        assert_eq!(
            content_type_value("text/markdown; charset=iso-8859-1").as_ref(),
            "text/markdown; charset=iso-8859-1"
        );
        assert_eq!(
            content_type_value("text/plain; CHARSET=UTF-8").as_ref(),
            "text/plain; CHARSET=UTF-8"
        );
        // Starlette keeps its `text/` prefix test case-sensitive.
        assert_eq!(
            content_type_value("Text/Markdown").as_ref(),
            "Text/Markdown"
        );
    }
}
