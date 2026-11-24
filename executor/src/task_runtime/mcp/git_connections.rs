//! Source-bound Git reads execute outside the model's network-denied sandbox.
use super::*;
use wegent_local_task_store::store::{AcceptedReply, DeliveryRole};

pub(super) fn tool() -> Value {
    json!({"name":"git_read","description":"Read GitHub/GitLab using the work's exact bound CLI account and instance without shell network escalation. Supply operation identity, repository, object, comments, checks, api, or job_log. job_log reads a selected CI job (GitHub failed steps, GitLab job trace). repository is an explicit path; repository-source work cannot switch repositories. api uses a repository-relative GET path only. This tool cannot mutate remote state.","inputSchema":{"type":"object","properties":{"operation":{"type":"string","enum":["identity","repository","object","comments","checks","api","job_log"]},"repository":{"type":"string"},"number":{"type":"integer"},"entityKind":{"type":"string","enum":["issue","change_request"]},"sha":{"type":"string"},"jobId":{"type":"integer"},"path":{"type":"string"},"page":{"type":"integer"}},"required":["operation"]},"annotations":{"readOnlyHint":true,"openWorldHint":true}})
}

pub(super) fn write_tool() -> Value {
    json!({"name":"git_write","title":"Publish GitHub/GitLab change","description":"Execute one exact gh/glab API mutation under this work's bound account and repository. Native one-time user approval includes the exact instance, account ID, repository, method, path and body. Read git_read identity first; never guess an account. For a comment replying to a work event, pass that exact event's recordId as messageId. Use a stable requestId; an unknown prior result cannot be retried automatically. For merges, explicit owner delegation is required and body.sha must equal the reviewed head SHA. This tool provides capability, not a fixed workflow.","inputSchema":{"type":"object","properties":{"messageId":{"type":"string"},"requestId":{"type":"string"},"instance":{"type":"string"},"accountId":{"type":"string"},"repository":{"type":"string"},"method":{"type":"string","enum":["POST","PUT","PATCH","DELETE"]},"path":{"type":"string"},"body":{"type":"object"}},"required":["requestId","instance","accountId","repository","method","path","body"]},"annotations":{"readOnlyHint":false,"destructiveHint":true,"openWorldHint":true}})
}

pub(super) async fn call(
    runtime: &TaskRuntime,
    identity: &StandInMcpIdentity,
    args: Value,
    write: bool,
    delivery: Option<&super::stand_in::DeliveryContext>,
) -> Result<Value, String> {
    let store = runtime.stand_in_store();
    if write && (!args["instance"].is_string() || !args["accountId"].is_string()) {
        return Err("Specify the exact instance and account ID for approval".into());
    }
    let mut args = args;
    let reply_to = args.as_object_mut().and_then(|v| v.remove("messageId"));
    let args =
        super::stand_in_tasks::call(identity.clone(), "validate_git_binding".into(), args).await?;
    if !write {
        return crate::runtime_work::git_connections::read(args)
            .await
            .map_err(|e| format!("{}: {}", e.code, e.message));
    }
    crate::runtime_work::git_connections::write_target(&args)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let mut account_check = args.clone();
    account_check["operation"] = json!("identity");
    crate::runtime_work::git_connections::read(account_check)
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let request = args["requestId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or("A stable requestId is required")?;
    let (id, existing) = store
        .begin_git_operation(
            identity.user,
            identity.work.as_deref().unwrap(),
            request,
            &args,
        )
        .map_err(|e| e.to_string())?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let comment = git_comment_request(
        store,
        identity,
        &args,
        reply_to.as_ref().and_then(Value::as_str),
    );
    let versions = delivery.and_then(super::stand_in::DeliveryContext::versions);
    let result = match crate::runtime_work::git_connections::write(args).await {
        Ok(result) => result,
        Err(failure) => {
            if !failure.uncertain {
                store
                    .fail_unsent_git_operation(identity.user, &id)
                    .map_err(|e| e.to_string())?;
            }
            return Err(format!("{}: {}", failure.error.code, failure.error.message));
        }
    };
    store
        .complete_git_operation(identity.user, &id, &result)
        .map_err(|e| e.to_string())?;
    if let (Some(native_id), Some((source, request))) =
        (result["canonicalEventId"].as_str(), comment)
    {
        if store
            .record_training_reply(
                DeliveryRole {
                    user: identity.user,
                    device: &identity.device,
                    role_device: delivery.map_or(&identity.device, |v| &v.role_device),
                    role: identity.role.as_deref().unwrap_or("@primary"),
                },
                &source,
                AcceptedReply {
                    request: &request,
                    text: "",
                    native_id: Some(native_id),
                    versions: versions
                        .as_ref()
                        .map(|(ghost, memory)| (*ghost, memory.as_str())),
                },
            )
            .is_err()
        {
            crate::logging::log_executor_event(
                "Stand-in Git comment training receipt unavailable",
                &[],
            );
        }
    }
    Ok(result)
}

/// A mutation ID alone does not identify the work event a comment was answering.
fn git_comment_request(
    store: &crate::task_runtime::LocalTaskStore,
    identity: &StandInMcpIdentity,
    args: &Value,
    selected: Option<&str>,
) -> Option<(Value, String)> {
    if args["method"] != "POST" {
        return None;
    }
    let messages = store
        .stand_in_messages(identity.user, identity.work.as_deref()?)
        .ok()?;
    let matches_target = |message: &Value| {
        let source = &message["source"];
        let external = &message["external"];
        if source["providerId"] != args["providerId"]
            || source["profile"] != args["profile"]
            || external["repositoryPath"] != args["repository"]
        {
            return false;
        }
        let Some(number) = external["entityId"]
            .as_u64()
            .or_else(|| external["entityId"].as_str()?.parse().ok())
        else {
            return false;
        };
        let suffix = match (
            external["platform"].as_str(),
            external["entityKind"].as_str(),
        ) {
            (Some("github"), Some("issue" | "change_request")) => {
                format!("issues/{number}/comments")
            }
            (Some("gitlab"), Some("issue")) => format!("issues/{number}/notes"),
            (Some("gitlab"), Some("change_request")) => format!("merge_requests/{number}/notes"),
            _ => return false,
        };
        args["path"] == suffix
    };
    if let Some(id) = selected {
        let message = super::connection_context::exact_message(&messages, id).ok()?;
        return matches_target(message).then(|| {
            (
                message["source"].clone(),
                message["id"].as_str().unwrap_or_default().to_owned(),
            )
        });
    }
    let mut candidates = messages.iter().filter(|m| matches_target(m));
    let first = candidates.next()?;
    // Several events in one work can concern the same issue. Retain the actual outbound identity
    // without guessing which request it answered, provided all candidate source grants agree.
    let source = first["source"].clone();
    let mut request = first["id"].as_str()?.to_owned();
    for candidate in candidates {
        if candidate["source"] != source {
            return None;
        }
        request.clear();
    }
    Some((source, request))
}

pub(crate) fn bind(
    store: &crate::task_runtime::LocalTaskStore,
    identity: &StandInMcpIdentity,
    mut args: Value,
) -> Result<Value, String> {
    let work = store
        .stand_in_work(
            identity.user,
            identity
                .work
                .as_deref()
                .ok_or("Git reads require source work")?,
        )
        .map_err(|e| e.to_string())?;
    if work["roleId"].as_str() != identity.role.as_deref() {
        return Err("Work belongs to another role".into());
    }
    let settings = store
        .configured_personal_stand_in(identity.user, &identity.device)
        .map_err(|e| e.to_string())?;
    let role = crate::task_runtime::personal_stand_in::stand_in_identities(&settings)
        .into_iter()
        .find(|row| row["id"] == work["roleId"])
        .ok_or("Role was removed")?;
    let source = crate::task_runtime::personal_stand_in::stand_in_connection(
        &role,
        &work["latestMessage"]["source"],
    )
    .or_else(|| crate::task_runtime::personal_stand_in::stand_in_connection(&role, &work["source"]))
    .ok_or("Source was disconnected")?;
    let provider = source["providerId"]
        .as_str()
        .filter(|id| id.starts_with(crate::runtime_work::git_connections::PACKAGE))
        .ok_or("This work is not a Git connection")?;
    let profile: Value = serde_json::from_str(source["profile"].as_str().ok_or("Missing account")?)
        .map_err(|_| "Invalid account")?;
    if args
        .get("instance")
        .is_some_and(|value| value != &profile[0])
        || args
            .get("accountId")
            .is_some_and(|value| value != &profile[1])
    {
        return Err("Instance or account is outside this source".into());
    }
    if source["kind"] == "repository" {
        if args["repository"]
            .as_str()
            .is_some_and(|r| Some(r) != source["name"].as_str())
        {
            return Err("Repository is outside this source".into());
        }
        args["repository"] = source["name"].clone();
        args["subscriptionId"] = source["subscriptionId"].clone();
        args["generation"] = source["generation"].clone();
    }
    args["providerId"] = json!(provider);
    args["profile"] = source["profile"].clone();
    args["instance"] = profile[0].clone();
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn git_work_binding_uses_current_connection_generation_and_rejects_foreign_repositories() {
        let root = tempfile::tempdir().unwrap();
        let store =
            crate::task_runtime::LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let old = json!({"providerId":"@wegent/dsh-connection-git/github","profile":"[\"https://github.com\",\"7\"]","id":"42","kind":"repository","name":"org/repo","subscriptionId":"receiver","generation":"old","policy":{"automatic":true,"askBeforeAct":true}});
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["roles"] = json!([crate::test_env::stand_in_role("mac")]);
        let mut current = old.clone();
        current["generation"] = json!("new");
        settings["roles"][0]["connections"] = json!([current]);
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let work = store
            .ingest_stand_in_message(
                7,
                "default",
                &old,
                &json!({"id":"event","text":"review","at":"2026-01-01T00:00:00Z",
                    "external":{"platform":"github","repositoryPath":"org/repo","entityKind":"issue","entityId":8}}),
                None,
            )
            .unwrap();
        let identity = StandInMcpIdentity {
            task_id: "task".into(),
            user: 7,
            device: "mac".into(),
            role: Some("default".into()),
            work: work["id"].as_str().map(str::to_owned),
            project: None,
            ask_before_act: true,
            review: false,
            memory_review: false,
            readonly_worker: false,
            coordinator_batch: None,
        };
        let bound = bind(&store, &identity, json!({"operation":"repository"})).unwrap();
        let mut comment = bound.clone();
        comment["method"] = json!("POST");
        comment["path"] = json!("issues/8/comments");
        store
            .ingest_stand_in_message(
                7,
                "default",
                &old,
                &json!({"id":"other-thread","text":"review","at":"2026-01-01T00:01:00Z",
                    "external":{"platform":"github","repositoryPath":"org/repo","entityKind":"issue","entityId":10}}),
                identity.work.as_deref(),
            )
            .unwrap();
        assert_eq!(
            git_comment_request(&store, &identity, &comment, None)
                .unwrap()
                .1,
            "event"
        );
        store
            .ingest_stand_in_message(
                7,
                "default",
                &old,
                &json!({"id":"same-thread","text":"follow up","at":"2026-01-01T00:02:00Z",
                    "external":{"platform":"github","repositoryPath":"org/repo","entityKind":"issue","entityId":8}}),
                identity.work.as_deref(),
            )
            .unwrap();
        assert_eq!(
            git_comment_request(&store, &identity, &comment, None)
                .unwrap()
                .1,
            ""
        );
        assert_eq!(
            git_comment_request(&store, &identity, &comment, Some("event"))
                .unwrap()
                .1,
            "event"
        );
        assert!(git_comment_request(&store, &identity, &comment, Some("another-event")).is_none());
        comment["path"] = json!("issues/9/comments");
        assert!(git_comment_request(&store, &identity, &comment, None).is_none());
        comment["path"] = json!("pulls/8/merge");
        assert!(git_comment_request(&store, &identity, &comment, None).is_none());
        assert_eq!(bound["generation"], "new");
        assert_eq!(bound["subscriptionId"], "receiver");
        assert!(bind(&store, &identity, json!({"repository":"other/repo"})).is_err());
        assert!(bind(
            &store,
            &identity,
            json!({"instance":"https://gitlab.example","accountId":"7"})
        )
        .is_err());
        assert!(bind(
            &store,
            &identity,
            json!({"instance":"https://github.com","accountId":"8"})
        )
        .is_err());
    }
}
