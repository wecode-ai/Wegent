//! Private bound-device commands and deliberately compact public evidence.
use super::service::{require_assignment_on, save_on, valid_revision};
use super::{model, reject, request_on, view_on};
use crate::background_jobs::project::{completion::Message, store};
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Event {
    device_id: String,
    runtime_task_id: String,
    execution_id: String,
    command_id: Option<String>,
    command_error: Option<String>,
    worktree: Option<Value>,
}

#[tracing::instrument(name = "collaboration.assistant_request.event", skip_all, fields(issue_id = %issue.id, owner_id = owner, request_id = request))]
pub(super) async fn acknowledge_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    request: &str,
    event: Event,
) -> MysqlResult<(Value, Option<Message>)> {
    let mut row = request_on(
        &mut &mut *tx,
        &issue.cloud_project_id,
        &issue.id,
        owner,
        request,
    )
    .await?;
    if event.execution_id != row.id.to_string()
        || event.runtime_task_id != row.runtime_task_id
        || event.device_id != row.runtime_device_id
        || row.runtime_device_id.is_empty()
    {
        return Err(reject(
            403,
            "Request event does not match its bound Runtime",
        ));
    }
    let owned = crate::device_identity::resolve_owned_device_alias_on(
        &mut &mut *tx,
        owner,
        &event.device_id,
    )
    .await?;
    let owned = owned.ok_or_else(|| reject(403, "Request device is unavailable"))?;
    require_assignment_on(&mut &mut *tx, issue, owner, &row.intent()["origin_context"]).await?;
    let binding:Option<(String,)>=tx.fetch_optional(format!("SELECT id FROM loop_items WHERE resource_type='execution' AND cloud_project_id=? AND loop_item_id=? AND task_user_id=? AND device_id=? AND task_id=? AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.execution_id'))=? AND (unlinked_at IS NULL OR unlinked_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) AND {} FOR UPDATE",store::LIVE),(issue.cloud_project_id.as_str(),issue.id.as_str(),owner,event.device_id.as_str(),event.runtime_task_id.as_str(),event.execution_id.as_str())).await?;
    if binding.is_none() {
        return Err(reject(403, "Request Runtime binding is unavailable"));
    }
    let mut intent = row.intent();
    let mut shared = None;
    if let Some(error) = event.command_error.as_deref() {
        if !valid_code(error) {
            return Err(reject(422, "Invalid command reason code"));
        }
        intent["assistant_request"]["reasonCode"] = json!(error);
        if event.command_id.is_none() {
            shared = evidence_message_on(
                tx,
                issue,
                owner,
                request,
                &json!({"state":"escalated","reasonCode":error}),
            )
            .await?;
        }
    }
    if let Some(id) = event.command_id.as_deref() {
        let command = intent["assistant_request"]["commands"]
            .as_array_mut()
            .and_then(|commands| commands.iter_mut().find(|command| command["id"] == id))
            .ok_or_else(|| reject(404, "Request command not found"))?;
        if command["executionId"].as_str() != Some(event.execution_id.as_str()) {
            return Err(reject(409, "Request command belongs to an earlier attempt"));
        }
        command["acknowledged"] = json!(true);
        if let Some(error) = event.command_error.as_deref() {
            if !valid_code(error) {
                return Err(reject(422, "Invalid command reason code"));
            }
            command["reasonCode"] = json!(error);
        }
    }
    if let Some(worktree) = event.worktree {
        let native_device = worktree["request"]["deviceId"]
            .as_str()
            .ok_or_else(|| reject(403, "Worktree device identity is missing"))?;
        let native = crate::device_identity::resolve_owned_device_alias_on(
            &mut &mut *tx,
            owner,
            native_device,
        )
        .await?;
        if worktree["request"]["ownerUserId"] != owner
            || worktree["request"]["conversationId"] != row.runtime_task_id
            || native.is_none_or(|native| native.id != owned.id)
        {
            return Err(reject(
                403,
                "Worktree ownership does not match the bound request",
            ));
        }
        let evidence = worktree_evidence(&worktree, request)?;
        require_approved_merge(
            &intent,
            &evidence,
            row.id,
            owner,
            event.command_id.as_deref(),
        )?;
        if intent["assistant_request"]["worktree"]["merge"] != evidence["merge"] {
            shared = evidence_message_on(tx, issue, owner, request, &evidence["merge"]).await?;
        }
        intent["assistant_request"]["worktree"] = evidence;
        if event.command_error.is_none() {
            intent["assistant_request"]["reasonCode"] = Value::Null;
        }
    }
    save_on(tx, &mut row, &intent).await?;
    Ok((view_on(&mut &mut *tx, &row).await?, shared))
}

fn require_approved_merge(
    intent: &Value,
    evidence: &Value,
    execution: i64,
    owner: i64,
    command_id: Option<&str>,
) -> MysqlResult<()> {
    let merge = &evidence["merge"];
    if merge["state"] != "merged" || intent["assistant_request"]["worktree"]["merge"] == *merge {
        return Ok(());
    }
    let execution_id = execution.to_string();
    let approved = intent["assistant_request"]["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|command| {
            command_id.is_none_or(|id| command["id"] == id)
                && command["action"] == "merge"
                && command["executionId"].as_str() == Some(execution_id.as_str())
                && command["approvedByUserId"] == owner
                && command["targetRevision"] == merge["targetRevision"]
                && command["candidateRevision"] == merge["candidateRevision"]
                && merge["mergedRevision"] == command["candidateRevision"]
                && merge["mergedRevision"].as_str().is_some_and(valid_revision)
        });
    if !approved {
        return Err(reject(
            403,
            "Merged evidence requires the exact human approval",
        ));
    }
    Ok(())
}

fn public_merge_evidence(request: &str, owner: i64, merge: &Value) -> Option<Value> {
    let state = merge["state"].as_str()?;
    let next = match state {
        "awaiting_confirmation" => "Owner confirms the prepared merge candidate",
        "conflict" | "escalated" => {
            "Owner reviews retained conflict evidence and chooses resolution"
        }
        "merged" => "Review the merged revision",
        "no_changes" => "No changes require merging",
        _ => return None,
    };
    let files = merge["conflictFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|path| {
            !path.is_empty()
                && path.len() <= 1024
                && !path.starts_with(['/', '\\'])
                && !path.contains(':')
                && !path.chars().any(char::is_control)
                && !path.split(['/', '\\']).any(|part| part == "..")
        })
        .take(200)
        .collect::<Vec<_>>();
    let mut value = json!({"activity_type":"assistant_request_evidence","request_id":request,"owner_user_id":owner,"state":state,"conflict_files":files,"next_action":next,
        "execution_entry":{"requestId":request},"provenance":{"origin":"ai_generated","owner_user_id":owner,"publisher_user_id":owner,"confirmation_status":"unconfirmed"}});
    if let Some(revision) = merge["mergedRevision"]
        .as_str()
        .filter(|value| valid_revision(value))
    {
        value["merged_revision"] = json!(revision);
    }
    Some(value)
}

async fn evidence_message_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    request: &str,
    merge: &Value,
) -> MysqlResult<Option<Message>> {
    use crate::socketio::project_chat_messages::{
        INSERT_MESSAGE_SQL, InsertMessage, insert_message_args,
    };
    let Some(metadata) = public_merge_evidence(request, owner, merge) else {
        return Ok(None);
    };
    let key = format!(
        "assistant-request-evidence:{request}:{}",
        model::digest(&metadata.to_string())
    );
    let existing: Option<(i64,)> = tx
        .fetch_optional(
            "SELECT id FROM project_chat_messages WHERE message_id=? FOR UPDATE",
            (key.as_str(),),
        )
        .await?;
    if existing.is_some() {
        return Ok(None);
    }
    let name: Option<(String,)> = tx
        .fetch_optional(
            "SELECT user_name FROM users WHERE id=? AND is_active=true",
            (owner,),
        )
        .await?;
    let name = name
        .ok_or_else(|| reject(403, "Assistant owner is unavailable"))?
        .0;
    let content = format!(
        "Request {request}: {}. {}",
        metadata["state"].as_str().unwrap(),
        metadata["next_action"].as_str().unwrap()
    );
    tx.execute(
        INSERT_MESSAGE_SQL,
        insert_message_args(&InsertMessage {
            message_id: &key,
            client_message_id: &key,
            project_id: &issue.cloud_project_id,
            task_id: &issue.id,
            sender_type: "user",
            sender_id: &owner.to_string(),
            sender_name: &name,
            message_type: "text",
            content: &content,
            metadata,
            trigger_message_id: "",
            reply_to_message_id: "",
            thread_root_message_id: "",
            agent_id: "",
            runtime_device_id: "",
            runtime_task_id: "",
            runtime_activity_key: "",
            status: "completed",
        }),
    )
    .await?;
    tx.fetch_optional(
        "SELECT * FROM project_chat_messages WHERE message_id=?",
        (key.as_str(),),
    )
    .await
}

fn worktree_evidence(value: &Value, request: &str) -> MysqlResult<Value> {
    if value["request"]["requestId"] != request || !value.is_object() {
        return Err(reject(
            422,
            "Worktree evidence requires the same request identity",
        ));
    }
    let mut safe = json!({});
    for key in [
        "worktreeId",
        "deviceId",
        "path",
        "sourcePath",
        "baseRevision",
        "branch",
        "cleanupPolicy",
        "state",
    ] {
        if let Some(field) = value.get(key) {
            safe[key] = field.clone();
        }
    }
    safe["request"] = json!({"requestId":request});
    for key in ["ownerUserId", "conversationId", "deviceId"] {
        if let Some(field) = value["request"].get(key) {
            safe["request"][key] = field.clone();
        }
    }
    if let Some(merge) = value.get("merge").filter(|value| value.is_object()) {
        safe["merge"] = json!({});
        for key in [
            "state",
            "targetRef",
            "targetRevision",
            "requestRevision",
            "candidateRevision",
            "mergedRevision",
            "conflictFiles",
            "reasonCode",
            "observedTargetRevision",
            "targetWorktreeDirty",
        ] {
            if let Some(field) = merge.get(key) {
                safe["merge"][key] = field.clone();
            }
        }
    }
    Ok(safe)
}

fn valid_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merged_evidence_requires_current_exact_human_approval_and_retains_history() {
        let revision = "a".repeat(40);
        let target = "b".repeat(40);
        let evidence = json!({"merge":{"state":"merged","targetRevision":target,"candidateRevision":revision,"mergedRevision":revision}});
        let mut intent = json!({"assistant_request":{"commands":[]}});
        assert!(require_approved_merge(&intent, &evidence, 41, 3, None).is_err());
        intent["assistant_request"]["commands"] = json!([{"id":"approved","action":"merge","executionId":"41","approvedByUserId":3,"targetRevision":target,"candidateRevision":revision}]);
        assert!(require_approved_merge(&intent, &evidence, 41, 3, Some("approved")).is_ok());
        assert!(require_approved_merge(&intent, &evidence, 41, 3, None).is_ok());
        for execution_id in [json!(41), json!("041")] {
            let mut invalid = intent.clone();
            invalid["assistant_request"]["commands"][0]["executionId"] = execution_id;
            assert!(require_approved_merge(&invalid, &evidence, 41, 3, Some("approved")).is_err());
        }
        assert!(require_approved_merge(&intent, &evidence, 41, 3, Some("other")).is_err());
        assert!(require_approved_merge(&intent, &evidence, 42, 3, Some("approved")).is_err());
        assert!(require_approved_merge(&intent, &evidence, 41, 4, Some("approved")).is_err());
        let mut changed = evidence.clone();
        changed["merge"]["mergedRevision"] = json!(target);
        assert!(require_approved_merge(&intent, &changed, 41, 3, Some("approved")).is_err());
        intent["assistant_request"]["worktree"] = evidence.clone();
        assert!(require_approved_merge(&intent, &evidence, 42, 3, None).is_ok());
    }

    #[test]
    fn shared_merge_evidence_contains_only_safe_relative_conflicts() {
        let evidence=public_merge_evidence("r",3,&json!({"state":"conflict","path":"/private/worktree","transcript":"private","conflictFiles":["backend/app.py","/private/file","C:\\private\\file","../other","src/../secret","src\\module.rs"]})).unwrap();
        assert_eq!(
            evidence["conflict_files"],
            json!(["backend/app.py", "src\\module.rs"])
        );
        assert_eq!(evidence["owner_user_id"], 3);
        assert!(evidence.get("path").is_none() && evidence.get("transcript").is_none());
        assert!(evidence["next_action"].is_string());
    }
    #[test]
    fn device_reports_cannot_claim_execution_completion() {
        assert!(
            serde_json::from_value::<Event>(
                json!({"deviceId":"d","runtimeTaskId":"t","executionId":"1","state":"completed"})
            )
            .is_err()
        );
        let safe = worktree_evidence(
            &json!({"request":{"requestId":"r"},"baseRevision":"abc","transcript":"private"}),
            "r",
        )
        .unwrap();
        assert_eq!(safe["baseRevision"], "abc");
        assert!(safe.get("transcript").is_none());
        assert!(worktree_evidence(&json!({"request":{"requestId":"foreign"}}), "r").is_err());
    }
}
