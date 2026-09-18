//! Byte-exactness tests for the DOCX export against the recorded
//! `GET /api/tasks/193651485592388/export/docx` case (run 20260911083951).

use std::collections::HashMap;

use serde_json::Value;
use wegent_backend_rs::task_export_docx::test_support::{
    AttachmentCardFixture, ExportInputFixture, SubtaskRowFixture, TaskRowFixture,
    document_for_test, generate_docx_for_test,
};

#[derive(serde::Deserialize)]
struct Fixture {
    task_json: Value,
    task_user_id: i64,
    subtasks: Vec<FixtureSubtask>,
    contexts: Vec<FixtureContext>,
    user_names: HashMap<String, String>,
}

#[derive(serde::Deserialize)]
struct FixtureSubtask {
    id: i64,
    role: String,
    prompt: Option<String>,
    result: Option<String>,
    sender_user_id: Option<i64>,
    updated_at: String,
}

#[derive(serde::Deserialize)]
struct FixtureContext {
    subtask_id: i64,
    context_type: String,
    name: Option<String>,
    type_data: Option<String>,
}

/// Owned fixture data for one export render.
struct OwnedFixture {
    task: TaskRowFixture,
    subtasks: Vec<SubtaskRowFixture>,
    attachments: Vec<(i64, AttachmentCardFixture)>,
    users: HashMap<i64, String>,
}

/// Build the owned fixture rows from the recorded case.
fn build_owned(fixture: &Fixture) -> OwnedFixture {
    let task = TaskRowFixture {
        user_id: fixture.task_user_id,
        json: fixture.task_json.clone(),
    };
    let subtasks = fixture
        .subtasks
        .iter()
        .map(|subtask| SubtaskRowFixture {
            id: subtask.id,
            role: subtask.role.clone(),
            prompt: subtask.prompt.clone(),
            result: subtask.result.as_ref().map(|raw| {
                serde_json::from_str::<Value>(raw).unwrap_or(Value::String(raw.clone()))
            }),
            sender_user_id: subtask.sender_user_id,
            updated_at: chrono::NaiveDateTime::parse_from_str(
                &subtask.updated_at,
                "%Y-%m-%d %H:%M:%S",
            )
            .unwrap(),
        })
        .collect::<Vec<_>>();
    let attachments = fixture
        .contexts
        .iter()
        .filter(|context| context.context_type == "attachment")
        .map(|context| {
            let type_data: Value = context
                .type_data
                .as_deref()
                .map(|raw| serde_json::from_str(raw).unwrap())
                .unwrap_or_default();
            (
                context.subtask_id,
                AttachmentCardFixture {
                    file_type: type_data
                        .get("file_extension")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    name: context.name.clone().unwrap_or_default(),
                    size: type_data
                        .get("file_size")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                },
            )
        })
        .collect::<Vec<_>>();
    let users = fixture
        .user_names
        .iter()
        .map(|(id, name)| (id.parse::<i64>().unwrap(), name.clone()))
        .collect::<HashMap<_, _>>();
    OwnedFixture {
        task,
        subtasks,
        attachments,
        users,
    }
}

#[test]
fn document_xml_matches_recorded_body() {
    let fixture: Fixture = serde_json::from_str(include_str!("export_docx_fixture.json")).unwrap();
    let expected = std::fs::read_to_string("tests/export_docx_expected_document.xml").unwrap();
    let owned = build_owned(&fixture);
    let input = ExportInputFixture {
        task: &owned.task,
        subtasks: &owned.subtasks,
        attachments: owned.attachments.clone(),
        users: owned.users.clone(),
    };
    let document = document_for_test(&input);
    if document != expected {
        for (i, (a, b)) in document.bytes().zip(expected.bytes()).enumerate() {
            if a != b {
                let ctx = |s: &str| {
                    let start = s
                        .char_indices()
                        .rev()
                        .find(|(idx, _)| *idx + 3 <= i)
                        .map(|(idx, _)| idx)
                        .unwrap_or(0);
                    let target = (i + 120).min(s.len());
                    let end = s
                        .char_indices()
                        .map(|(idx, _)| idx)
                        .chain(std::iter::once(s.len()))
                        .find(|idx| *idx >= target)
                        .unwrap_or(s.len());
                    s[start..end].to_string()
                };
                panic!(
                    "document.xml differs at byte {i}:\ngenerated: {}\nexpected:   {}",
                    ctx(&document),
                    ctx(&expected),
                );
            }
        }
        panic!(
            "document.xml length differs: generated {} vs expected {}",
            document.len(),
            expected.len()
        );
    }
}

#[test]
fn generated_package_matches_recorded_zip_with_pinned_time() {
    let fixture: Fixture = serde_json::from_str(include_str!("export_docx_fixture.json")).unwrap();
    let recorded = std::fs::read("tests/export_docx_expected.docx").unwrap();
    let owned = build_owned(&fixture);
    let input = ExportInputFixture {
        task: &owned.task,
        subtasks: &owned.subtasks,
        attachments: owned.attachments.clone(),
        users: owned.users.clone(),
    };
    let generated = generate_docx_for_test(
        &input,
        chrono::NaiveDate::from_ymd_opt(2026, 9, 11)
            .unwrap()
            .and_hms_opt(16, 43, 50)
            .unwrap(),
    );
    // Compare every entry's compressed bytes; `docProps/core.xml` carries
    // the source's second `datetime.now()` capture (one second after the
    // zip timestamps in the recording), so it is compared by content with
    // its own pinned time.
    let entry = |data: &[u8], wanted: &str| -> Option<Vec<u8>> {
        let mut i = 0;
        while let Some(pos) = data[i..]
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x03, 0x04])
        {
            let base = i + pos;
            if base + 30 > data.len() {
                return None;
            }
            let nlen = u16::from_le_bytes([data[base + 26], data[base + 27]]) as usize;
            let name = String::from_utf8_lossy(&data[base + 30..base + 30 + nlen]).to_string();
            let csize = u32::from_le_bytes(data[base + 18..base + 22].try_into().unwrap()) as usize;
            let start = base + 30 + nlen;
            let payload = data[start..start + csize].to_vec();
            if name == wanted {
                return Some(payload);
            }
            i = start + csize;
        }
        None
    };
    for name in [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/app.xml",
        "word/document.xml",
        "word/_rels/document.xml.rels",
        "word/styles.xml",
        "word/stylesWithEffects.xml",
        "word/settings.xml",
        "word/webSettings.xml",
        "word/fontTable.xml",
        "word/theme/theme1.xml",
        "customXml/item1.xml",
        "customXml/_rels/item1.xml.rels",
        "customXml/itemProps1.xml",
        "word/numbering.xml",
        "word/footer1.xml",
        "docProps/thumbnail.jpeg",
    ] {
        assert_eq!(
            entry(&generated, name).expect("generated entry"),
            entry(&recorded, name).expect("recorded entry"),
            "part {name} compressed bytes differ"
        );
    }
    // core.xml: same bytes once the created timestamp matches the source's
    // generation-time capture (one second after the zip timestamps here).
    let core_time_generated = generate_docx_for_test(
        &input,
        chrono::NaiveDate::from_ymd_opt(2026, 9, 11)
            .unwrap()
            .and_hms_opt(16, 43, 51)
            .unwrap(),
    );
    assert_eq!(
        entry(&core_time_generated, "docProps/core.xml").unwrap(),
        entry(&recorded, "docProps/core.xml").unwrap(),
        "core.xml with the recorded created time must match"
    );
}
