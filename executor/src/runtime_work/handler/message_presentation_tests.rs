use super::*;

#[test]
fn transcript_restores_file_and_folder_references_from_saved_user_content() {
    for (original, provider) in [
        (
            "[$甲乙.pdf](file://%2Ftmp%2F甲乙.pdf) 请阅读",
            "/tmp/甲乙.pdf 请阅读",
        ),
        (
            "查看 [$abc def](folder://%2Ftmp%2Fabc%20def)",
            "查看 \"/tmp/abc def\"",
        ),
        (
            "[$abc.md](file://%2Ftmp%2Fabc.md)[$abc.md](file://%2Ftmp%2Fabc.md)继续",
            "/tmp/abc.md/tmp/abc.md继续",
        ),
        (
            "[$xyz](/tmp/xyz/SKILL.md) 查看 [$甲乙.pdf](file://%2Ftmp%2F甲乙.pdf)",
            "$xyz 查看 /tmp/甲乙.pdf",
        ),
    ] {
        let mut presentation = user_message_presentation(&json!({
            "clientUserMessageId": "client-user",
            "message": original
        }))
        .expect("saved user presentation");
        // Previously saved messages have no file reference descriptors.
        presentation["references"] = json!([]);
        let mut messages = vec![json!({
            "id": "provider-user",
            "clientUserMessageId": "client-user",
            "role": "user",
            "content": provider
        })];

        attach_user_message_presentations(&mut messages, vec![presentation]);

        assert_eq!(messages[0]["content"], original);
        assert!(messages[0].get("presentationReferences").is_none());
    }
}

#[test]
fn transcript_keeps_plain_provider_paths_without_an_explicit_saved_reference() {
    let mut messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "client-user",
        "role": "user",
        "content": "/tmp/abc.pdf provider content"
    })];
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "client-user",
        "message": "/tmp/abc.pdf original content"
    }))
    .expect("saved plain message");

    attach_user_message_presentations(&mut messages, vec![presentation]);

    assert_eq!(messages[0]["content"], "/tmp/abc.pdf provider content");
    assert!(messages[0].get("presentationReferences").is_none());
}

#[test]
fn transcript_does_not_apply_provider_ranges_after_restoring_attachment_content() {
    let original = "[$xyz](/tmp/xyz/SKILL.md) 查看附件";
    let presentation = user_message_presentation(&json!({
        "clientUserMessageId": "client-user",
        "message": original,
        "attachments": [{
            "id": -1,
            "filename": "abc.pdf",
            "local_path": "/tmp/abc.pdf"
        }]
    }))
    .expect("saved attachment message");
    let mut messages = vec![json!({
        "id": "provider-user",
        "clientUserMessageId": "client-user",
        "role": "user",
        "content": "$xyz 查看附件"
    })];

    attach_user_message_presentations(&mut messages, vec![presentation]);

    assert_eq!(messages[0]["content"], original);
    assert!(messages[0].get("presentationReferences").is_none());
    assert_eq!(messages[0]["attachments"][0]["filename"], "abc.pdf");
}
