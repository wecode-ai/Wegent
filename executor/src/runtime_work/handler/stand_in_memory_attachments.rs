//! Attachment reads are selected from persisted user uploads, never model paths.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;
use sha2::{Digest, Sha256};

#[cfg(test)]
use crate::runtime_work::document_evidence::read_text;
#[cfg(test)]
use crate::runtime_work::document_evidence::{decode_attachment_text, CHUNK_BYTES};
use crate::runtime_work::document_evidence::{document_chunk, invalid};

fn attachments(link: &RuntimeTaskLink, until: i64) -> Vec<Value> {
    let mut messages = cached_runtime_transcript_messages(link);
    let presentations = user_message_presentations(link)
        .into_iter()
        .filter(|row| {
            !runtime_has_provider_transcript_reader(&link.runtime)
                || string_field(row, "turnId").is_some_and(|id| !id.is_empty())
        })
        .collect::<Vec<_>>();
    bind_native_user_presentations(&mut messages, &presentations);
    let page_messages = messages.clone();
    attach_user_message_presentations_for_page(
        &mut messages,
        presentations,
        &page_messages,
        &[],
        false,
        false,
    );
    remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
    messages.iter()
        .filter(|message| message["role"] == "user")
        .filter(|message| timestamp_ms_field(message, "createdAt").map_or(true, |at| at < until))
        .flat_map(|message| {
            message["attachments"].as_array().into_iter().flatten().enumerate()
                .map(|(index, attachment)| {
                    let message_id = message.get("clientUserMessageId").unwrap_or(&message["id"]);
                    let id = format!("{:x}", Sha256::digest(
                        json!([link.local_task_id, message_id, attachment["id"], index]).to_string()
                    ));
                    json!({"attachmentId":id,"messageId":message_id,"filename":attachment["filename"],
                        "mimeType":attachment["mime_type"],"sizeBytes":attachment["file_size"],
                        "createdAt":message["createdAt"],"path":attachment["local_path"]})
                }).collect::<Vec<_>>()
        }).collect()
}

pub(super) fn has_memory_attachments(link: &RuntimeTaskLink, until: i64) -> bool {
    !attachments(link, until).is_empty()
}

pub(super) fn unread_memory_attachment_count(
    link: &RuntimeTaskLink,
    until: i64,
    state: &Value,
) -> usize {
    attachments(link, until)
        .iter()
        .filter(|row| {
            let progress = &state["attachments"][row["attachmentId"].as_str().unwrap()];
            progress["readThrough"].as_u64().is_none()
                || progress["readThrough"] != progress["totalContentBytes"]
        })
        .count()
}

pub(super) fn page_attachments_are_bound(link: &RuntimeTaskLink, until: i64, page: &Value) -> bool {
    let rows = attachments(link, until);
    page["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .all(|message| {
            let count = message["unreadAttachmentCount"].as_u64().unwrap_or(0);
            count == 0
                || rows
                    .iter()
                    .filter(|row| {
                        row["messageId"] == message["id"]
                            || message["clientUserMessageId"].is_string()
                                && row["messageId"] == message["clientUserMessageId"]
                    })
                    .count() as u64
                    >= count
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_upload_bindings_survive_missing_cache_and_provider_message_ids() {
        let uploaded_at = 1_794_106_709_569_i64;
        let cutoff = uploaded_at + 1;
        let mut link = RuntimeTaskLink {
            local_task_id: "native-upload".into(),
            runtime: "codex".into(),
            runtime_handle: json!({"userMessagePresentations":[{
                "clientUserMessageId":"client-upload","turnId":"turn-1",
                "content":"Reporting guide","ensureVisible":true,"createdAt":uploaded_at,
                "attachments":[{"id":1,"filename":"guide.docx","local_path":"/owned/guide.docx"}]
            },{
                "clientUserMessageId":"unsent","ensureVisible":true,"createdAt":uploaded_at,
                "attachments":[{"id":2,"local_path":"/unsent.docx"}]
            }]}),
            ..Default::default()
        };
        let rows = attachments(&link, cutoff);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["messageId"], "client-upload");
        assert_eq!(rows[0]["path"], "/owned/guide.docx");
        assert!(attachments(&link, uploaded_at).is_empty());
        let mut page = json!({"messages":[{"id":"provider-message","role":"user",
            "clientUserMessageId":"client-upload","unreadAttachmentCount":1}]});
        assert!(page_attachments_are_bound(&link, cutoff, &page));
        page["messages"][0]["clientUserMessageId"] = json!("unrelated");
        assert!(!page_attachments_are_bound(&link, cutoff, &page));
        link.runtime_handle["messages"] = json!([{
            "id":"provider-message","role":"user","turnId":"turn-1","createdAt":uploaded_at
        }]);
        assert_eq!(attachments(&link, cutoff), rows);
        link.runtime_handle["supersededTranscriptTurnIds"] = json!(["turn-1"]);
        assert!(attachments(&link, cutoff).is_empty());
        link.runtime_handle["supersededTranscriptTurnIds"] = json!([]);
        link.runtime_handle["userMessagePresentations"] = json!([]);
        assert!(attachments(&link, cutoff).is_empty());
    }

    #[tokio::test]
    async fn attachment_reader_preserves_excel_names_coordinates_and_formula_values() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("evidence.xlsx");
        let long = "授权资料🌳".repeat(2000);
        let name = "完整工作表名称".repeat(10);
        let workbook = format!("<workbook><sheets><sheet name=\"{name}\" r:id=\"two\"/><sheet name=\"统计\" r:id=\"one\"/></sheets></workbook>");
        let shared = format!("<sst><si><t>{long}</t></si></sst>");
        let bytes = wegent_document_parser::office::zip::stored_archive(&[
            ("xl/workbook.xml", workbook.as_bytes()),
            ("xl/_rels/workbook.xml.rels", b"<Relationships><Relationship Id=\"one\" Target=\"worksheets/one.xml\"/><Relationship Id=\"two\" Target=\"worksheets/two.xml\"/></Relationships>"),
            ("xl/sharedStrings.xml", shared.as_bytes()),
            ("xl/worksheets/one.xml", b"<worksheet><sheetData><row r=\"7\"><c r=\"C7\"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>"),
            ("xl/worksheets/two.xml", b"<worksheet><sheetData><row r=\"3\"><c r=\"B3\" t=\"s\"><v>0</v></c></row></sheetData></worksheet>"),
        ]);
        fs::write(&path, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let expected = format!("--- Sheet: {name} ---\nR3: [2]=\"{long}\"\n--- Sheet: 统计 ---\nR7: [3]={{\"formula\":\"=1+1\",\"value\":2}}");
        let mut offset = 0;
        let mut actual = String::new();
        loop {
            let page = read_text(path.to_str().unwrap().into(), offset, Some(hash.clone()))
                .await
                .unwrap();
            assert_eq!(page["contentHash"], hash);
            assert_eq!(page["totalContentBytes"], expected.len());
            actual.push_str(page["content"].as_str().unwrap());
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(page["contentComplete"], true);
                break;
            };
            offset = next as usize;
        }
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn attachment_reader_preserves_powerpoint_order_across_chunks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("evidence.pptx");
        let long = "授权资料🌳".repeat(2000);
        let slide = |text: &str| {
            format!("<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>")
        };
        let first = slide("短页");
        let second = slide(&long);
        let bytes = wegent_document_parser::office::zip::stored_archive(&[
            ("ppt/presentation.xml", b"<p:presentation><p:sldIdLst><p:sldId r:id=\"two\"/><p:sldId r:id=\"one\"/></p:sldIdLst></p:presentation>"),
            ("ppt/_rels/presentation.xml.rels", b"<Relationships><Relationship Id=\"one\" Type=\"a/slide\" Target=\"slides/one.xml\"/><Relationship Id=\"two\" Type=\"a/slide\" Target=\"slides/two.xml\"/></Relationships>"),
            ("ppt/slides/one.xml", first.as_bytes()),
            ("ppt/slides/two.xml", second.as_bytes()),
        ]);
        fs::write(&path, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let expected = format!("--- Slide 1 ---\n{long}\n--- Slide 2 ---\n短页");
        let mut offset = 0;
        let mut actual = String::new();
        loop {
            let page = read_text(path.to_str().unwrap().into(), offset, Some(hash.clone()))
                .await
                .unwrap();
            assert_eq!(page["contentHash"], hash);
            assert_eq!(page["totalContentBytes"], expected.len());
            actual.push_str(page["content"].as_str().unwrap());
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(page["contentComplete"], true);
                break;
            };
            offset = next as usize;
        }
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn attachment_reader_pages_complete_word_text_with_original_byte_binding() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("evidence.docx");
        let text = "资料🌳".repeat(3000);
        let xml = format!(
            "<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
        );
        let bytes = wegent_document_parser::office::zip::stored_archive(&[(
            "word/document.xml",
            xml.as_bytes(),
        )]);
        fs::write(&path, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let mut offset = 0;
        let mut actual = String::new();
        loop {
            let page = read_text(path.to_str().unwrap().into(), offset, Some(hash.clone()))
                .await
                .unwrap();
            assert_eq!(page["contentHash"], hash);
            assert_eq!(page["totalContentBytes"], text.len());
            actual.push_str(page["content"].as_str().unwrap());
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(page["contentComplete"], true);
                break;
            };
            offset = next as usize;
        }
        assert_eq!(actual, text);
        let control = wegent_document_parser::ParseControl::new(None, || true);
        assert!(decode_attachment_text(bytes, control).is_err());
    }

    #[test]
    fn attachment_reader_preserves_word_paragraph_and_table_order() {
        let xml = br#"<w:document><w:body>
            <w:p><w:r><w:t>First decision:</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Approve release A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            <w:p><w:r><w:t>Correction: supersedes the decision above.</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Hold release A</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
            </w:body></w:document>"#;
        let bytes =
            wegent_document_parser::office::zip::stored_archive(&[("word/document.xml", xml)]);
        let text =
            decode_attachment_text(bytes, wegent_document_parser::ParseControl::default()).unwrap();
        assert_eq!(text, "First decision:\nApprove release A\nCorrection: supersedes the decision above.\nHold release A");
    }

    #[tokio::test]
    async fn attachment_reader_uses_pdf_text_but_hashes_the_original_upload() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("evidence.pdf");
        let bytes = wegent_document_parser::pdf::simple_pdf_bytes();
        fs::write(&path, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let page = read_text(path.to_str().unwrap().into(), 0, Some(hash.clone()))
            .await
            .unwrap();
        assert_eq!(page["content"], "A");
        assert_eq!(page["contentHash"], hash);
        assert_eq!(page["totalContentBytes"], 1);
        assert_eq!(page["contentComplete"], true);
        assert!(page["nextOffset"].is_null());
        let control = wegent_document_parser::ParseControl::new(None, || true);
        assert!(decode_attachment_text(bytes, control).is_err());
    }

    #[tokio::test]
    async fn attachment_reader_preserves_pdf_page_order_and_multibyte_chunk_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("multipage.pdf");
        let first = vec![0x80; 4000];
        let bytes = wegent_document_parser::pdf::pdf_bytes_with_page_texts(&[
            &first,
            b"Second page: acceptance evidence",
            b"Final page: risks",
        ]);
        fs::write(&path, &bytes).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let expected = format!(
            "{}\nSecond page: acceptance evidence\nFinal page: risks",
            "€".repeat(4000)
        );
        let mut offset = 0;
        let mut chunks = 0;
        let mut actual = String::new();
        loop {
            let page = read_text(path.to_str().unwrap().into(), offset, Some(hash.clone()))
                .await
                .unwrap();
            assert_eq!(page["offset"], offset);
            assert_eq!(page["contentHash"], hash);
            assert_eq!(page["totalContentBytes"], expected.len());
            let text = page["content"].as_str().unwrap();
            assert!(text.len() <= CHUNK_BYTES);
            actual.push_str(text);
            chunks += 1;
            let Some(next) = page["nextOffset"].as_u64() else {
                assert_eq!(page["contentComplete"], true);
                break;
            };
            assert_eq!(page["contentComplete"], false);
            offset = next as usize;
            assert_eq!(offset, actual.len());
        }
        assert!(chunks > 1);
        assert_eq!(actual, expected);
    }

    #[tokio::test]
    async fn attachment_reader_decodes_bom_utf16_without_losing_evidence() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("notes.txt");
        let text = format!("{}🌳原文", "资料".repeat(2000));
        for little_endian in [true, false] {
            let mut bytes = if little_endian {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&if little_endian {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            fs::write(&path, &bytes).unwrap();
            let hash = format!("{:x}", Sha256::digest(&bytes));
            let mut offset = 0;
            let mut reconstructed = String::new();
            loop {
                let page = read_text(path.to_str().unwrap().into(), offset, Some(hash.clone()))
                    .await
                    .unwrap();
                assert_eq!(page["contentHash"], hash);
                assert_eq!(page["totalContentBytes"], text.len());
                reconstructed.push_str(page["content"].as_str().unwrap());
                let Some(next) = page["nextOffset"].as_u64() else {
                    break;
                };
                offset = next as usize;
            }
            assert_eq!(reconstructed, text);
        }
        for bytes in [
            vec![0xff, 0xfe, 0x00],
            vec![0xff, 0xfe, 0x00, 0xd8],
            vec![0xff, 0xfe, 0, 0],
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_text(path.to_str().unwrap().into(), 0, None)
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn attachment_reader_reports_missing_binary_and_changed_content() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("attachment");
        let name = path.to_str().unwrap().to_owned();
        assert!(read_text(name.clone(), 0, None).await.is_err());
        for bytes in [
            b"%PDF-1.7".as_slice(),
            b"PK\x03\x04document",
            b"binary\0data",
            &[0xff, 0xff],
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(read_text(name.clone(), 0, None).await.is_err());
        }
        fs::write(&path, "资料").unwrap();
        assert!(read_text(name.clone(), 1, None).await.is_err());
        assert!(read_text(name.clone(), 0, Some("old-hash".into()))
            .await
            .is_err());
        assert_eq!(read_text(name, 0, None).await.unwrap()["content"], "资料");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn attachment_reader_rejects_a_replaced_symlink() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("other-file");
        fs::write(&target, "ungranted file").unwrap();
        let path = root.path().join("attachment");
        std::os::unix::fs::symlink(target, &path).unwrap();
        assert!(read_text(path.to_str().unwrap().into(), 0, None)
            .await
            .is_err());
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn verify_memory_attachment_coverage(
        &self,
        identity: &StandInMcpIdentity,
        link: &RuntimeTaskLink,
        through: i64,
        state: &Value,
        store: &LocalTaskStore,
    ) -> Result<(), AppIpcError> {
        let rows = attachments(link, through);
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| invalid("Review is unavailable"))?;
        for row in &rows {
            self.validate_history_delivery(identity, link, store)?;
            let id = row["attachmentId"].as_str().unwrap();
            let progress = &state["attachments"][id];
            let hash = progress["contentHash"]
                .as_str()
                .ok_or_else(|| invalid("Attachment has not been read"))?;
            if progress["readThrough"].as_u64().is_none()
                || progress["readThrough"] != progress["totalContentBytes"]
            {
                return Err(invalid("Attachment has unread content"));
            }
            let path = row["path"]
                .as_str()
                .ok_or_else(|| invalid("Attachment has no local file"))?;
            let document = self
                .memory_attachment_document(&actor, state, id, path, false)
                .await?;
            document_chunk(&document, 0, Some(hash.to_owned()))?;
        }
        self.validate_history_delivery(identity, link, store)?;
        let current = self
            .local_task_link(&link.local_task_id)
            .ok_or_else(|| invalid("Conversation is unavailable"))?;
        if attachments(&current, through) != rows {
            return Err(invalid("Attachment bindings changed; review them again"));
        }
        Ok(())
    }

    pub(super) async fn memory_attachment_operation(
        &self,
        identity: &StandInMcpIdentity,
        name: &str,
        args: &Value,
    ) -> Result<Value, AppIpcError> {
        if !identity.memory_review || identity.review || identity.readonly_worker {
            return Err(AppIpcError::new(
                "permission_denied",
                "Memory review identity required",
            ));
        }
        let task_id = super::stand_in_tasks::required(args, "taskId")?;
        let gate = self.task_send_gate(&format!("memory-source:{}:{task_id}", identity.user));
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let link = self
            .local_task_link(task_id)
            .ok_or_else(|| invalid("Conversation is unavailable"))?;
        self.validate_history_delivery(identity, &link, &store)?;
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| invalid("Review is unavailable"))?;
        let until = self
            .scheduled_review_run_end(&actor, identity.user, true)?
            .timestamp_millis();
        let rows = attachments(&link, until);
        if name == "list_memory_attachments" {
            let start = args["offset"].as_u64().unwrap_or(0) as usize;
            if start > rows.len() {
                return Err(invalid("Invalid attachment list offset"));
            }
            let mut items: Vec<_> = rows.iter().skip(start).take(30).cloned().collect();
            for row in &mut items {
                row.as_object_mut().unwrap().remove("path");
            }
            let end = start + items.len();
            return Ok(
                json!({"items":items,"nextOffset":(end < rows.len()).then_some(end),
                "coverageNote":"Persisted user-uploaded conversation attachments only; document/binary extraction and missing files are reported separately."}),
            );
        }
        let id = super::stand_in_tasks::required(args, "attachmentId")?;
        let row = rows
            .iter()
            .find(|row| row["attachmentId"] == id)
            .ok_or_else(|| invalid("Attachment does not belong to this conversation"))?;
        let path = row["path"]
            .as_str()
            .ok_or_else(|| invalid("Attachment has no local file"))?;
        let offset = args["offset"].as_u64().unwrap_or(0) as usize;
        let hash = args["contentHash"].as_str().map(str::to_owned);
        if (offset > 0 || name == "remember_from_attachment") && hash.is_none() {
            return Err(invalid(
                "Content continuation requires the original contentHash",
            ));
        }
        let state = store
            .memory_review_progress(identity.user, task_id)
            .map_err(super::stand_in::settings_error)?;
        let document = self
            .memory_attachment_document(&actor, &state, id, path, name == "read_memory_attachment")
            .await?;
        let mut result = document_chunk(&document, offset, hash)?;
        self.validate_history_delivery(identity, &link, &store)?;
        let current = self
            .local_task_link(task_id)
            .ok_or_else(|| invalid("Conversation is unavailable"))?;
        if !attachments(&current, until)
            .iter()
            .any(|current| current == row)
        {
            return Err(invalid("Attachment binding changed while reading"));
        }
        result["attachmentId"] = row["attachmentId"].clone();
        result["messageId"] = row["messageId"].clone();
        result["filename"] = row["filename"].clone();
        result["role"] = json!("attachment");
        if name == "remember_from_attachment" {
            let excerpt = super::stand_in_tasks::required(args, "excerpt")?;
            if excerpt.len() > 2000
                || !result["content"]
                    .as_str()
                    .is_some_and(|text| text.contains(excerpt))
            {
                return Err(invalid(
                    "The exact excerpt is not present in the attachment chunk",
                ));
            }
            return self.save_task_memory_evidence(identity, args, json!({
                "taskId":task_id,"messageId":format!("attachment:{id}:{}", result["contentHash"].as_str().unwrap()),
                "attachmentId":id,"filename":row["filename"],"role":"attachment",
                "uploadedAt":row["createdAt"],"readAt":chrono::Utc::now(),"excerpt":excerpt,
                "kind":document["evidenceKind"],"contentHash":result["contentHash"]
            }));
        }
        let run = actor.runtime_handle["executionRequest"]["standInSchedule"]["runId"]
            .as_str()
            .ok_or_else(|| invalid("Review has no run identity"))?;
        // Keep the host interpretation for this source/run/hash, never model-supplied text.
        let mut checkpoint = result.clone();
        if document["evidenceKind"] == "image_observation" {
            checkpoint["imageObservation"] = document["content"].clone();
        }
        store
            .record_memory_attachment_read(identity.user, task_id, run, id, &checkpoint)
            .map_err(super::stand_in::settings_error)?;
        Ok(result)
    }
}
