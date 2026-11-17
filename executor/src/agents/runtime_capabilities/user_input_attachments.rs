use super::{attachment_records, prepare_runtime_attachments, AttachmentPromptProcessor};
use crate::protocol::ExecutionRequest;
use serde_json::{json, Value};

pub(crate) struct PreparedUserInputResponse {
    pub request: ExecutionRequest,
    pub response: Value,
}

/// Materialize files through the ordinary runtime attachment pipeline before
/// returning text-only answers to the native question protocol.
pub(crate) async fn prepare_user_input_response(
    request: ExecutionRequest,
    mut response: Value,
) -> Result<PreparedUserInputResponse, String> {
    let request = prepare_runtime_attachments(request).await;
    let records = attachment_records(&request);
    let Some(answers) = response.get_mut("answers").and_then(Value::as_object_mut) else {
        return Err("Question answers are missing".into());
    };
    for answer in answers.values_mut() {
        let Some(files) = answer.get("attachments").and_then(Value::as_array) else {
            continue;
        };
        let mut available = Vec::new();
        for file in files {
            let record = records
                .iter()
                .find(|record| file["id"].as_i64() == Some(record.id))
                .filter(|record| record.status.as_deref() != Some("failed"))
                .filter(|record| {
                    record
                        .local_path
                        .as_deref()
                        .is_some_and(|path| !path.trim().is_empty())
                })
                .ok_or_else(|| {
                    "A question attachment could not be prepared; retry the answer".to_owned()
                })?;
            available.push(record.clone());
        }
        let context = AttachmentPromptProcessor::build_attachment_context(&available);
        let object = answer.as_object_mut().ok_or("Invalid question answer")?;
        object.remove("attachments");
        if !context.is_empty() {
            object
                .get_mut("answers")
                .and_then(Value::as_array_mut)
                .ok_or("Question answer text is missing")?
                .push(json!(context));
        }
    }
    Ok(PreparedUserInputResponse { request, response })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(files: Value) -> ExecutionRequest {
        serde_json::from_value(json!({
            "task_id": "question-files", "subtask_id": "turn-1", "prompt": "",
            "attachments": files
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn preserves_question_identity_and_associates_each_file_with_its_answer() {
        let files = json!([
            {"id": -1, "original_filename": "brief.txt", "local_path": "/tmp/brief.txt", "status": "ready"},
            {"id": -2, "original_filename": "image.png", "local_path": "/tmp/image.png", "status": "ready"}
        ]);
        let response = prepare_user_input_response(
            request(files),
            json!({
                "requestId": 7, "interactionScope": "turn-1", "answers": {
                    "audience": {"answers": ["Staff"], "attachments": [{"id": -1}]},
                    "style": {"answers": [], "attachments": [{"id": -2}]}
                }
            }),
        )
        .await
        .unwrap()
        .response;
        assert_eq!(response["requestId"], 7);
        assert_eq!(response["interactionScope"], "turn-1");
        assert_eq!(response["answers"]["audience"]["answers"][0], "Staff");
        let audience = response["answers"]["audience"].to_string();
        assert!(audience.contains("/tmp/brief.txt"));
        assert!(!audience.contains("image.png"));
        assert!(response["answers"]["audience"].get("attachments").is_none());
        assert!(response["answers"]["style"]
            .to_string()
            .contains("/tmp/image.png"));
    }

    #[tokio::test]
    async fn rejects_missing_files_and_preserves_skip_answers() {
        assert!(prepare_user_input_response(
            request(json!([])),
            json!({
                "answers": {"details": {"answers": ["Text"], "attachments": [{"id": 9}]}}
            })
        )
        .await
        .is_err());
        let skipped = json!({"requestId": 8, "answers": {"details": {"answers": []}}});
        assert_eq!(
            prepare_user_input_response(request(json!([])), skipped.clone())
                .await
                .unwrap()
                .response,
            skipped
        );
    }
}
