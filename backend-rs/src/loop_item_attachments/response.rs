// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemAttachmentResponse` projection
//! (`app.schemas.delivery.LoopItemAttachmentResponse`).
//!
//! Field declaration order follows the pydantic model; `markdown_url` is the
//! `@computed_field` that trails the declared fields. `markdown` is always
//! `None` on the source row (there is no `markdown` column), so the
//! `populate_markdown` validator fills the `[display_name](markdown_url)`
//! link plus the `wegent-attachment` HTML comment.
use chrono::NaiveDateTime;
use serde::Serialize;

use super::repository::AttachmentRow;

/// One `LoopItemAttachmentResponse` body.
#[derive(Debug, Serialize)]
pub struct AttachmentResponse {
    id: String,
    loop_item_id: String,
    display_name: String,
    content_type: Option<String>,
    size_bytes: i64,
    sha256: String,
    created_by_user_id: i32,
    created_at: Option<String>,
    markdown: String,
    markdown_url: String,
}

impl AttachmentResponse {
    /// `LoopItemAttachmentResponse.model_validate` for one `loop_items`
    /// attachment row.
    pub fn from_row(row: &AttachmentRow) -> Self {
        // `normalize_empty_content_type`: `""` becomes `None`.
        let content_type = row.content_type.clone().filter(|value| !value.is_empty());
        Self::build(
            row.id.clone(),
            row.loop_item_id.clone().unwrap_or_default(),
            row.display_name.clone().unwrap_or_default(),
            content_type,
            row.size_bytes.unwrap_or_default(),
            row.sha256.clone().unwrap_or_default(),
            row.created_by_user_id.unwrap_or_default(),
            datetime_value(row.created_at),
            None,
        )
    }

    /// Assemble the body from already-resolved values. The external
    /// (gitlab) projection supplies `created_at` as an ISO-8601 string and an
    /// explicit `markdown` (the matched attachment source text); when
    /// `markdown` is `None` the `populate_markdown` link is computed.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        id: String,
        loop_item_id: String,
        display_name: String,
        content_type: Option<String>,
        size_bytes: i64,
        sha256: String,
        created_by_user_id: i32,
        created_at: Option<String>,
        markdown: Option<String>,
    ) -> Self {
        let markdown_url = format!("wegent://attachments/{id}");
        // `populate_markdown`: the `[name](url)` link plus the attachment
        // marker comment, unless the source row already supplied `markdown`.
        let markdown = markdown.unwrap_or_else(|| {
            format!("[{display_name}]({markdown_url})\n<!-- wegent-attachment:{id} -->")
        });
        Self {
            id,
            loop_item_id,
            display_name,
            content_type,
            size_bytes,
            sha256,
            created_by_user_id,
            created_at,
            markdown,
            markdown_url,
        }
    }
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
fn datetime_value(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json_contract_tests::serialized;

    fn row() -> AttachmentRow {
        AttachmentRow {
            id: "5336494559207636217".to_string(),
            loop_item_id: Some("WEWORKC2FA61-507".to_string()),
            display_name: Some("spec.pdf".to_string()),
            content_type: Some("application/pdf".to_string()),
            size_bytes: Some(2048),
            sha256: Some("a".repeat(64)),
            created_by_user_id: Some(52),
            created_at: NaiveDateTime::parse_from_str("2026-09-04 07:23:14", "%Y-%m-%d %H:%M:%S")
                .ok(),
        }
    }

    #[test]
    fn serializes_the_declared_field_order() {
        let value = serialized(AttachmentResponse::from_row(&row())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": "5336494559207636217",
                "loop_item_id": "WEWORKC2FA61-507",
                "display_name": "spec.pdf",
                "content_type": "application/pdf",
                "size_bytes": 2048,
                "sha256": "a".repeat(64),
                "created_by_user_id": 52,
                "created_at": "2026-09-04T07:23:14",
                "markdown": "[spec.pdf](wegent://attachments/5336494559207636217)\n<!-- wegent-attachment:5336494559207636217 -->",
                "markdown_url": "wegent://attachments/5336494559207636217",
            })
        );
    }

    #[test]
    fn normalizes_empty_content_type_to_null() {
        let mut row = row();
        row.content_type = Some(String::new());
        let value = serialized(AttachmentResponse::from_row(&row)).unwrap();
        assert_eq!(value["content_type"], serde_json::Value::Null);
    }

    #[test]
    fn renders_microsecond_precision_when_present() {
        assert_eq!(
            datetime_value(
                NaiveDateTime::parse_from_str("2026-09-04 07:23:14.500000", "%Y-%m-%d %H:%M:%S%.f")
                    .ok()
            ),
            Some("2026-09-04T07:23:14.500000".to_string())
        );
    }
}
