use super::*;

#[tokio::test]
async fn memory_unreadable_pdf_cannot_advance_progress_and_can_recover_after_text_is_available() {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let path = root.path().join("visual.pdf");
    let bytes = wegent_document_parser::pdf::pdf_bytes_with_page_contents(&[
        "q 100 0 0 100 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI Q",
    ]);
    fs::write(&path, bytes).unwrap();
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"visual-pdf".into(),runtime:"chat".into(),created_at:1,updated_at:2,
        runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":[
            {"id":"upload","role":"user","createdAt":1,"attachments":[{"id":1,"filename":"visual.pdf","local_path":path}]}
        ]}),..Default::default()});
    let source = json!({"taskId":"visual-pdf"});
    let page = handler
        .memory_progress_operation(&identity, "next_memory_page", &source)
        .await
        .unwrap();
    assert_eq!(page["readyToComplete"], false);
    let list = handler
        .memory_attachment_operation(&identity, "list_memory_attachments", &source)
        .await
        .unwrap();
    let args = json!({"taskId":"visual-pdf","attachmentId":list["items"][0]["attachmentId"]});
    let error = handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &args)
        .await
        .unwrap_err();
    assert!(error.message.contains("no extractable text"));
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &source)
        .await
        .is_err());
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    assert_eq!(
        store.memory_review_progress(7, "visual-pdf").unwrap()["completedThrough"],
        0
    );
    // Replacing the actual source with a PDF text layer makes the same pending source readable.
    fs::write(&path, wegent_document_parser::pdf::simple_pdf_bytes()).unwrap();
    let read = handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &args)
        .await
        .unwrap();
    assert_eq!(read["content"], "A");
    assert_eq!(read["contentComplete"], true);
    let completed = handler
        .memory_progress_operation(&identity, "complete_memory_source", &source)
        .await
        .unwrap();
    assert!(completed["completedThrough"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn memory_image_protocol_revalidates_bytes_owner_and_run_before_save_and_completion() {
    use sha2::{Digest, Sha256};
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let path = root.path().join("upload.png");
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 1)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    fs::write(&path, bytes.get_ref()).unwrap();
    let hash = format!("{:x}", Sha256::digest(bytes.get_ref()));
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"uploaded-image".into(),runtime:"chat".into(),created_at:1,updated_at:2,
        runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":[
            {"id":"upload","role":"user","createdAt":1,"attachments":[{"id":1,"filename":"upload.png","local_path":path}]}
        ]}),..Default::default()});
    let source = json!({"taskId":"uploaded-image"});
    let list = handler
        .memory_attachment_operation(&identity, "list_memory_attachments", &source)
        .await
        .unwrap();
    let id = list["items"][0]["attachmentId"].as_str().unwrap();
    handler
        .memory_progress_operation(&identity, "next_memory_page", &source)
        .await
        .unwrap();
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    // Supply only the model interpretation; all source reads, authorization and persistence are real.
    let observation = "The image appears to say the release is on Friday.";
    let chunk = json!({"contentHash":hash,"offset":0,"totalContentBytes":observation.len(),
        "content":observation,"imageObservation":observation,"evidenceKind":"image_observation"});
    store
        .record_memory_attachment_read(7, "uploaded-image", &run.id, id, &chunk)
        .unwrap();
    let mut args = json!({"taskId":"uploaded-image","attachmentId":id,"contentHash":hash,
        "excerpt":"Invented fact","content":"Image suggests Friday release"});
    let read = handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &args)
        .await
        .unwrap();
    assert_eq!(read["evidenceKind"], "image_observation");
    assert_eq!(read["contentHash"], hash);
    assert!(read.get("dataUrl").is_none());
    assert!(handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &args)
        .await
        .is_err());
    args["excerpt"] = json!(observation);
    let saved = handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &args)
        .await
        .unwrap();
    assert_eq!(saved["evidence"]["kind"], "image_observation");
    assert_eq!(saved["evidence"]["contentHash"], hash);
    assert_eq!(saved["evidence"]["attachmentId"], id);
    handler
        .memory_progress_operation(&identity, "complete_memory_source", &source)
        .await
        .unwrap();
    let mut changed = bytes.into_inner();
    changed.extend_from_slice(b"changed");
    fs::write(&path, changed).unwrap();
    assert!(handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &args)
        .await
        .is_err());
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &source)
        .await
        .is_err());
    let mut link = handler.local_task_link("uploaded-image").unwrap();
    link.runtime_handle["executionRequest"]["user_id"] = json!(8);
    handler.upsert_local_task(link);
    assert_eq!(
        handler
            .memory_attachment_operation(&identity, "read_memory_attachment", &args)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
    handler.automation_store.update(review).unwrap();
    assert_eq!(
        handler
            .memory_attachment_operation(&identity, "list_memory_attachments", &source)
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}

#[tokio::test]
async fn memory_review_reads_attachment_chunks_and_saves_only_current_owned_evidence() {
    verify_attachment_evidence_protocol(false).await;
}

#[tokio::test]
async fn memory_review_reads_word_chunks_and_revalidates_document_evidence() {
    verify_attachment_evidence_protocol(true).await;
}

async fn verify_attachment_evidence_protocol(word_document: bool) {
    let root = tempfile::tempdir().unwrap();
    let (handler, mut identity) = fixture(root.path());
    let review = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&review.id)
        .unwrap();
    identity.task_id = run.coordination.as_ref().unwrap().task_id.clone();
    identity.memory_review = true;
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:identity.task_id.clone(),runtime_handle:json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":review.id},
        "executionRequest":{"user_id":7,"standInSchedule":{"id":review.id,"version":review.version,"runId":run.id}}
    }),..Default::default()});
    let filename = if word_document {
        "weekly-reports.docx"
    } else {
        "weekly-reports.txt"
    };
    let path = root.path().join(filename);
    let text = format!(
        "{}Weekly reports must start with a conclusion.",
        "背景。".repeat(1200)
    );
    let bytes = if word_document {
        let xml = format!(
            "<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"
        );
        wegent_document_parser::office::zip::stored_archive(&[(
            "word/document.xml",
            xml.as_bytes(),
        )])
    } else {
        text.as_bytes().to_vec()
    };
    fs::write(&path, &bytes).unwrap();
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:"uploaded".into(),runtime:"chat".into(),created_at:1,updated_at:2,
        runtime_handle:json!({"origin":{"type":"ordinary","userId":7},"executionRequest":{"user_id":7},"messages":[
            {"id":"upload","role":"user","content":"Team reporting guide","createdAt":1,"attachments":[{"id":1,"filename":filename,"local_path":path}]},
            {"id":"untrusted","role":"assistant","content":"Suggested file","attachments":[{"id":2,"local_path":path}]}
        ]}),..Default::default()});
    let list = handler
        .memory_attachment_operation(
            &identity,
            "list_memory_attachments",
            &json!({"taskId":"uploaded"}),
        )
        .await
        .unwrap();
    assert_eq!(list["items"].as_array().unwrap().len(), 1);
    assert!(!list.to_string().contains(root.path().to_str().unwrap()));
    let source_args = json!({"taskId":"uploaded"});
    assert_eq!(
        handler
            .memory_progress_operation(&identity, "next_memory_page", &source_args)
            .await
            .unwrap_err()
            .code,
        "incomplete_attachments"
    );
    // Remove the deliberately unbound assistant attachment from the source;
    // it cannot become a user-upload grant or be silently marked complete.
    let mut cleaned = handler.local_task_link("uploaded").unwrap();
    cleaned.runtime_handle["messages"][1]
        .as_object_mut()
        .unwrap()
        .remove("attachments");
    handler.upsert_local_task(cleaned);
    let page = handler
        .memory_progress_operation(&identity, "next_memory_page", &source_args)
        .await
        .unwrap();
    assert_eq!(page["historyReadComplete"], true);
    assert_eq!(page["readyToComplete"], false);
    assert_eq!(page["unreadAttachmentCount"], 1);
    let mut args = json!({"taskId":"uploaded","attachmentId":list["items"][0]["attachmentId"]});
    let first = handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &args)
        .await
        .unwrap();
    assert_eq!(first["contentComplete"], false);
    assert_eq!(first["contentHash"], {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&bytes))
    });
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &source_args)
        .await
        .is_err());
    args["offset"] = first["nextOffset"].clone();
    args["contentHash"] = first["contentHash"].clone();
    let second = handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &args)
        .await
        .unwrap();
    assert_eq!(second["contentComplete"], true);
    assert_eq!(
        format!(
            "{}{}",
            first["content"].as_str().unwrap(),
            second["content"].as_str().unwrap()
        ),
        text
    );
    args["excerpt"] = json!("Weekly reports must start with a conclusion.");
    args["content"] = json!("The team's reporting guide requires conclusions first.");
    let memory = handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &args)
        .await
        .unwrap();
    assert_eq!(memory["scope"], json!({"kind":"personal"}));
    assert_eq!(memory["evidence"]["role"], "attachment");
    assert_eq!(memory["evidence"]["filename"], filename);
    assert_eq!(memory["evidence"]["uploadedAt"], 1);
    assert!(memory["evidence"]["readAt"].is_string());
    let ready = handler
        .memory_progress_operation(&identity, "next_memory_page", &source_args)
        .await
        .unwrap();
    assert_eq!(ready["readyToComplete"], true);
    let completed = handler
        .memory_progress_operation(&identity, "complete_memory_source", &source_args)
        .await
        .unwrap();
    assert_eq!(
        completed["completedThrough"],
        run.scheduled_for.timestamp_millis()
    );
    let listed = handler
        .memory_progress_operation(&identity, "list_memory_sources", &json!({}))
        .await
        .unwrap();
    assert!(listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["taskId"] == "uploaded"));
    let mut forged = args.clone();
    forged["attachmentId"] = json!("invented");
    assert!(handler
        .memory_attachment_operation(&identity, "read_memory_attachment", &forged)
        .await
        .is_err());
    forged = args.clone();
    forged["excerpt"] = json!("Invented user preference");
    assert!(handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &forged)
        .await
        .is_err());
    fs::write(&path, "Revised requirements").unwrap();
    assert!(handler
        .memory_attachment_operation(&identity, "remember_from_attachment", &args)
        .await
        .is_err());
    assert!(handler
        .memory_progress_operation(&identity, "complete_memory_source", &source_args)
        .await
        .is_err());
    let mut changed = handler.local_task_link("uploaded").unwrap();
    changed.runtime_handle["executionRequest"]["user_id"] = json!(8);
    handler.upsert_local_task(changed);
    assert_eq!(
        handler
            .memory_attachment_operation(
                &identity,
                "list_memory_attachments",
                &json!({"taskId":"uploaded"})
            )
            .await
            .unwrap_err()
            .code,
        "permission_denied"
    );
}
