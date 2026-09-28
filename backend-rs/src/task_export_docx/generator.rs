// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! DOCX package assembly: document body construction from loaded rows and
//! the byte-exact zip container.

use chrono::{Local, NaiveDateTime};

use super::markdown;
use super::package::ZipPackage;
use super::repository::{SubtaskRow, TaskRow};

/// `sanitize_filename`.
pub(crate) fn sanitize_filename(name: &str) -> String {
    let mut safe = String::with_capacity(name.len());
    let mut last_underscore = false;
    for ch in name.chars() {
        let mapped = match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_whitespace() => '_',
            c => c,
        };
        if mapped == '_' {
            if !last_underscore {
                safe.push('_');
            }
            last_underscore = true;
        } else {
            safe.push(mapped);
            last_underscore = false;
        }
    }
    safe.trim_matches('_').chars().take(100).collect()
}

/// One attachment context rendered as a file card.
pub(crate) struct AttachmentCardView {
    pub file_type: String,
    pub name: String,
    pub size: String,
}

/// The loaded export inputs.
pub(crate) struct ExportInput<'a> {
    pub task: &'a TaskRow,
    pub subtasks: &'a [SubtaskRow],
    /// `(subtask_id, card)` in context-id order.
    pub attachments: Vec<(i64, AttachmentCardView)>,
    /// Display names by user id for sender resolution.
    pub users: std::collections::HashMap<i64, String>,
}

/// Build the `word/document.xml` body content for the task export.
fn document_body_with_links(input: &ExportInput, links: &mut Vec<String>) -> String {
    let task_json = &input.task.json;
    let spec = task_json.get("spec").cloned().unwrap_or_default();
    let metadata_name = task_json
        .get("metadata")
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let spec_title = spec.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let spec_prompt = spec.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
    let task_title = if !metadata_name.is_empty() {
        metadata_name.to_string()
    } else if !spec_title.is_empty() {
        spec_title.to_string()
    } else {
        let truncated: String = spec_prompt.chars().take(50).collect();
        if truncated.is_empty() {
            "Chat_Export".to_string()
        } else {
            truncated
        }
    };
    let task_title = markdown::sanitize_xml_text(&task_title);
    let team_name = spec
        .get("teamRef")
        .and_then(|r| r.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("AI Assistant");

    let mut body = String::new();
    body.push_str(&markdown::document_header(&task_title, links));

    for subtask in input.subtasks {
        let is_user = subtask.role == "USER";
        // Sender name.
        let sender_name = if is_user {
            match subtask.sender_user_id {
                Some(sender_id) if sender_id > 0 => input
                    .users
                    .get(&sender_id)
                    .cloned()
                    .unwrap_or_else(|| "User".to_string()),
                _ => input
                    .users
                    .get(&input.task.user_id)
                    .cloned()
                    .unwrap_or_else(|| "User".to_string()),
            }
        } else {
            team_name.to_string()
        };
        let timestamp = subtask.updated_at.map(updated_at_text).unwrap_or_default();
        body.push_str(&markdown::message_header(&sender_name, &timestamp, is_user));

        // Attachment contexts for user messages.
        if is_user {
            for (subtask_id, card) in &input.attachments {
                if *subtask_id == subtask.id {
                    body.push_str(&markdown::file_attachment(
                        &card.file_type,
                        &card.name,
                        &card.size,
                    ));
                }
            }
        }

        // Message content.
        let content = if is_user {
            subtask.prompt.clone().unwrap_or_default()
        } else {
            extract_result_value(subtask)
        };
        let content = markdown::clean_content(&content);
        body.push_str(&markdown::render_markdown(&content, links));
        body.push_str("<w:p/>");
    }

    body
}

/// `subtask.updated_at.strftime("%Y-%m-%d %H:%M:%S")`.
fn updated_at_text(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// `_extract_result_value`: `result["value"]` for dict results, the string
/// itself for plain strings, `""` when only thinking is present.
fn extract_result_value(subtask: &SubtaskRow) -> String {
    let Some(result) = subtask.result.as_ref() else {
        return String::new();
    };
    let value = result.to_value();
    if let Some(inner) = value.get("value").filter(|value| !value.is_null()) {
        return value_to_string(inner);
    }
    if value.get("thinking").is_some() {
        return String::new();
    }
    value_to_string(&value)
}

/// Python `str()` of a JSON value: strings stay unwrapped, others use the
/// JSON form with single quotes replaced like `str(dict)`. Only the `value`
/// field (always a string in recorded exports) reaches here in practice;
/// non-strings fall back to the JSON serialization.
fn value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `docProps/core.xml` with the export title, author, and creation time.
fn core_xml(title: &str, created: &str) -> String {
    format!(
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{title}</dc:title><dc:subject/><dc:creator>Wegent AI</dc:creator><cp:keywords/><dc:description>generated by python-docx</dc:description><cp:lastModifiedBy/><cp:revision>1</cp:revision><dcterms:created xsi:type=\"dcterms:W3CDTF\">{created}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">2013-12-23T23:15:00Z</dcterms:modified><cp:category/></cp:coreProperties>",
        title = super::xml::escape_text(title),
    )
}

/// `word/_rels/document.xml.rels` with the footer relationship (and any
/// hyperlink relationships appended after it).
fn document_rels(hyperlinks: &[String]) -> String {
    let mut extra = String::new();
    for (index, url) in hyperlinks.iter().enumerate() {
        extra.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            10 + index,
            super::xml::escape_text(url)
        ));
    }
    format!(
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId4\" Type=\"http://schemas.microsoft.com/office/2007/relationships/stylesWithEffects\" Target=\"stylesWithEffects.xml\"/><Relationship Id=\"rId5\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings\" Target=\"settings.xml\"/><Relationship Id=\"rId6\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings\" Target=\"webSettings.xml\"/><Relationship Id=\"rId7\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable\" Target=\"fontTable.xml\"/><Relationship Id=\"rId8\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml\" Target=\"../customXml/item1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/><Relationship Id=\"rId9\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer\" Target=\"footer1.xml\"/>{extra}</Relationships>"
    )
}

/// `word/footer1.xml` (`Exported from Wegent` centered, small, gray).
fn footer_xml() -> &'static str {
    "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<w:ftr xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:mo=\"http://schemas.microsoft.com/office/mac/office/2008/main\" xmlns:mv=\"urn:schemas-microsoft-com:mac:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:w10=\"urn:schemas-microsoft-com:office:word\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\" xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\" xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\" xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\" xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" mc:Ignorable=\"w14 wp14\"><w:p><w:pPr><w:pStyle w:val=\"Footer\"/><w:jc w:val=\"center\"/></w:pPr><w:r><w:rPr><w:color w:val=\"A0A0A0\"/><w:sz w:val=\"16\"/></w:rPr><w:t>Exported from Wegent</w:t></w:r></w:p></w:ftr>"
}

/// `[Content_Types].xml` rebuilt from the package's part list (defaults
/// sorted by extension, overrides sorted by partname).
fn content_types_xml() -> &'static str {
    "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/customXml/itemProps1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.customXmlProperties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/><Override PartName=\"/word/fontTable.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml\"/><Override PartName=\"/word/footer1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/><Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/><Override PartName=\"/word/stylesWithEffects.xml\" ContentType=\"application/vnd.ms-word.stylesWithEffects+xml\"/><Override PartName=\"/word/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/word/webSettings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml\"/></Types>"
}

/// The `word/document.xml` part: namespaces, body content, and the template
/// `sectPr` with the footer reference inserted first.
fn document_xml(body: &str) -> String {
    format!(
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n<w:document xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\" xmlns:mo=\"http://schemas.microsoft.com/office/mac/office/2008/main\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" xmlns:mv=\"urn:schemas-microsoft-com:mac:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:w10=\"urn:schemas-microsoft-com:office:word\" xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\" xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\" xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\" xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" mc:Ignorable=\"w14 wp14\"><w:body>{body}<w:sectPr w:rsidR=\"00FC693F\" w:rsidRPr=\"0006063C\" w:rsidSect=\"00034616\"><w:footerReference w:type=\"default\" r:id=\"rId9\"/><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1800\" w:bottom=\"1440\" w:left=\"1800\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/><w:cols w:space=\"720\"/><w:docGrid w:linePitch=\"360\"/></w:sectPr></w:body></w:document>"
    )
}

/// Generate the complete DOCX package for one export.
///
/// The two current-time values the source embeds (`dcterms:created` and the
/// zip entry timestamps) use the current local time, matching
/// `datetime.now()` / `ZipFile.writestr` in the source.
pub(crate) fn generate_docx(input: &ExportInput, now: chrono::NaiveDateTime) -> Vec<u8> {
    let mut links: Vec<String> = Vec::new();
    let body = document_body_with_links(input, &mut links);
    let document = document_xml(&body);
    let created = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let spec = &input.task.json;
    let title = spec
        .get("metadata")
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| {
            spec.get("spec")
                .and_then(|s| s.get("title"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("");
    let core = core_xml(&markdown::sanitize_xml_text(title), &created);

    let mut package = ZipPackage::new(now);
    package.add("[Content_Types].xml", content_types_xml().as_bytes());
    package.add("_rels/.rels", include_bytes!("templates/_rels.xml"));
    package.add("docProps/core.xml", core.as_bytes());
    package.add("docProps/app.xml", include_bytes!("templates/app.xml"));
    package.add("word/document.xml", document.as_bytes());
    package.add(
        "word/_rels/document.xml.rels",
        document_rels(&links).as_bytes(),
    );
    package.add("word/styles.xml", include_bytes!("templates/styles.xml"));
    package.add(
        "word/stylesWithEffects.xml",
        include_bytes!("templates/stylesWithEffects.xml"),
    );
    package.add(
        "word/settings.xml",
        include_bytes!("templates/settings.xml"),
    );
    package.add(
        "word/webSettings.xml",
        include_bytes!("templates/webSettings.xml"),
    );
    package.add(
        "word/fontTable.xml",
        include_bytes!("templates/fontTable.xml"),
    );
    package.add(
        "word/theme/theme1.xml",
        include_bytes!("templates/theme1.xml"),
    );
    package.add(
        "customXml/item1.xml",
        include_bytes!("templates/customXml_item1.xml"),
    );
    package.add(
        "customXml/_rels/item1.xml.rels",
        include_bytes!("templates/customXml_rels.xml"),
    );
    package.add(
        "customXml/itemProps1.xml",
        include_bytes!("templates/customXml_itemProps1.xml"),
    );
    package.add(
        "word/numbering.xml",
        include_bytes!("templates/numbering.xml"),
    );
    package.add("word/footer1.xml", footer_xml().as_bytes());
    package.add(
        "docProps/thumbnail.jpeg",
        include_bytes!("templates/thumbnail.jpeg"),
    );
    package.finish()
}

/// The export response filename (`{safe_title}_{date}.docx`).
pub(crate) fn export_filename(input: &ExportInput, now: chrono::NaiveDateTime) -> String {
    let spec = &input.task.json;
    let metadata_name = spec
        .get("metadata")
        .and_then(|m| m.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let spec_title = spec
        .get("spec")
        .and_then(|s| s.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let spec_prompt = spec
        .get("spec")
        .and_then(|s| s.get("prompt"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let task_title = if !metadata_name.is_empty() {
        metadata_name.to_string()
    } else if !spec_title.is_empty() {
        spec_title.to_string()
    } else {
        let truncated: String = spec_prompt.chars().take(50).collect();
        if truncated.is_empty() {
            "Chat_Export".to_string()
        } else {
            truncated
        }
    };
    let safe = sanitize_filename(&task_title);
    format!("{}_{}.docx", safe, now.format("%Y-%m-%d"))
}

/// Local-time `datetime.now()` for the naive timestamp forms the source uses.
pub(crate) fn now_local() -> chrono::NaiveDateTime {
    Local::now().naive_local()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_filename_replaces_invalid_characters() {
        assert_eq!(
            sanitize_filename("a<b>c:d\"e/f\\g|h?i*j"),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_filename("  spaced  name  "), "spaced_name");
        assert_eq!(sanitize_filename("a__b"), "a_b");
    }
}

/// Public test-only fixtures for the byte-exactness integration test.
pub mod test_support {
    use super::*;

    /// Test-shaped task row.
    pub struct TaskRowFixture {
        pub user_id: i64,
        pub json: serde_json::Value,
    }

    /// Test-shaped subtask row.
    pub struct SubtaskRowFixture {
        pub id: i64,
        pub role: String,
        pub prompt: Option<String>,
        pub result: Option<serde_json::Value>,
        pub sender_user_id: Option<i64>,
        pub updated_at: chrono::NaiveDateTime,
    }

    /// Test-shaped attachment card inputs.
    #[derive(Clone)]
    pub struct AttachmentCardFixture {
        pub file_type: String,
        pub name: String,
        pub size: i64,
    }

    /// Test-shaped export input.
    pub struct ExportInputFixture<'a> {
        pub task: &'a TaskRowFixture,
        pub subtasks: &'a [SubtaskRowFixture],
        pub attachments: Vec<(i64, AttachmentCardFixture)>,
        pub users: std::collections::HashMap<i64, String>,
    }

    /// Render the complete DOCX package for the fixture input at a pinned
    /// time (for byte-exactness tests against recorded output).
    pub fn generate_docx_for_test(
        input: &ExportInputFixture,
        now: chrono::NaiveDateTime,
    ) -> Vec<u8> {
        let task = TaskRow {
            user_id: input.task.user_id,
            json: input.task.json.clone(),
        };
        let subtasks = input
            .subtasks
            .iter()
            .map(|subtask| SubtaskRow {
                id: subtask.id,
                role: subtask.role.clone(),
                prompt: subtask.prompt.clone(),
                result: subtask
                    .result
                    .clone()
                    .map(crate::json_compat::OpaqueJson::from),
                message_id: 0,
                sender_user_id: subtask.sender_user_id,
                updated_at: Some(subtask.updated_at),
            })
            .collect::<Vec<_>>();
        let attachments = input
            .attachments
            .iter()
            .map(|(subtask_id, card)| {
                (
                    *subtask_id,
                    AttachmentCardView {
                        file_type: super::super::markdown::file_type_label(&card.file_type)
                            .to_string(),
                        name: super::super::markdown::sanitize_xml_text(&card.name),
                        size: super::super::markdown::format_file_size(card.size),
                    },
                )
            })
            .collect();
        let export_input = ExportInput {
            task: &task,
            subtasks: &subtasks,
            attachments,
            users: input.users.clone(),
        };
        generate_docx(&export_input, now)
    }

    /// Render `word/document.xml` for the fixture input.
    pub fn document_for_test(input: &ExportInputFixture) -> String {
        let task = TaskRow {
            user_id: input.task.user_id,
            json: input.task.json.clone(),
        };
        let subtasks = input
            .subtasks
            .iter()
            .map(|subtask| SubtaskRow {
                id: subtask.id,
                role: subtask.role.clone(),
                prompt: subtask.prompt.clone(),
                result: subtask
                    .result
                    .clone()
                    .map(crate::json_compat::OpaqueJson::from),
                message_id: 0,
                sender_user_id: subtask.sender_user_id,
                updated_at: Some(subtask.updated_at),
            })
            .collect::<Vec<_>>();
        let attachments = input
            .attachments
            .iter()
            .map(|(subtask_id, card)| {
                (
                    *subtask_id,
                    AttachmentCardView {
                        file_type: super::super::markdown::file_type_label(&card.file_type)
                            .to_string(),
                        name: super::super::markdown::sanitize_xml_text(&card.name),
                        size: super::super::markdown::format_file_size(card.size),
                    },
                )
            })
            .collect();
        let export_input = ExportInput {
            task: &task,
            subtasks: &subtasks,
            attachments,
            users: input.users.clone(),
        };
        let mut links = Vec::new();
        document_xml(&document_body_with_links(&export_input, &mut links))
    }
}
