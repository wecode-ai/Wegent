//! Native-approved webhook configuration keeps receiver secrets out of model input.
use super::*;
use crate::task_runtime::mcp::StandInMcpIdentity;

// Project webhook flags documented by GitLab; returned flags are checked too,
// so a newly exposed event cannot silently remain disabled.
const GITLAB_EVENTS: &[&str] = &[
    "push_events",
    "issues_events",
    "confidential_issues_events",
    "merge_requests_events",
    "tag_push_events",
    "note_events",
    "confidential_note_events",
    "job_events",
    "pipeline_events",
    "wiki_page_events",
    "deployment_events",
    "releases_events",
    "milestone_events",
    "feature_flag_events",
    "resource_access_token_events",
    "resource_deploy_token_events",
];

impl RuntimeWorkRpcHandler {
    pub(super) async fn configure_git_webhook(
        &self,
        identity: &StandInMcpIdentity,
        args: &Value,
        plan: bool,
    ) -> Result<Value, AppIpcError> {
        if identity.device != self.device_id
            || identity.coordinator_batch.is_some()
            || identity.project.is_some()
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Webhook configuration requires an owner conversation",
            ));
        }
        let actor = self
            .local_task_link(&identity.task_id)
            .ok_or_else(|| AppIpcError::new("permission_denied", "Conversation unavailable"))?;
        if actor.runtime_handle["origin"]["userId"] != identity.user
            || actor.runtime_handle["executionRequest"]["user_id"].as_i64() != Some(identity.user)
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "Conversation owner changed",
            ));
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(super::stand_in::settings_error)?;
        let settings = store
            .personal_stand_in(identity.user, &self.device_id)
            .map_err(super::stand_in::settings_error)?;
        let roles = crate::task_runtime::personal_stand_in::stand_in_identities(&settings);
        let source = roles
            .iter()
            .filter(|r| {
                matches!(identity.role.as_deref(), None | Some("@primary"))
                    || r["id"].as_str() == identity.role.as_deref()
            })
            .flat_map(|r| r["connections"].as_array().into_iter().flatten())
            .find(|s| {
                s["subscriptionId"] == args["subscriptionId"]
                    && s["kind"] == "repository"
                    && s["providerId"]
                        .as_str()
                        .is_some_and(|p| p.starts_with(super::super::git_connections::PACKAGE))
            })
            .ok_or_else(|| {
                AppIpcError::new(
                    "source_removed",
                    "Save the repository connection before configuring its webhook",
                )
            })?;
        let profile: Value = serde_json::from_str(source["profile"].as_str().unwrap_or(""))
            .map_err(|_| AppIpcError::new("git_connection_invalid", "Invalid account"))?;
        if args["repository"] != source["name"] || args["instance"] != profile[0] {
            return Err(AppIpcError::new(
                "permission_denied",
                "Webhook target does not match the saved source",
            ));
        }
        let provider = source["providerId"].as_str().unwrap();
        let github = provider.ends_with("/github");
        let events = args["events"].as_array().cloned().unwrap_or_default();
        if !plan {
            if events.is_empty() || events.len() > 64 {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Explicit webhook events are required",
                ));
            }
            if github && events != vec![json!("*")] {
                return Err(AppIpcError::new(
                    "bad_request",
                    "GitHub repository connections subscribe to all events",
                ));
            }
            if !github
                && !events.iter().all(|v| {
                    v.as_str().is_some_and(|s| {
                        s.len() <= 128
                            && s.ends_with("_events")
                            && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                    })
                })
            {
                return Err(AppIpcError::new(
                    "bad_request",
                    "Invalid GitLab event flags",
                ));
            }
        }
        self.validate_git_source(source).await?;
        let subscription = source["subscriptionId"].as_str().unwrap();
        let config=self.stand_in_http(reqwest::Method::POST,&format!("/v1/git-connections/subscriptions/{subscription}/configuration"),Some(&json!({"deviceId":self.device_id,"generation":source["generation"],"reveal":!plan}))).await?;
        let connection = self
            .backend_connection_snapshot()?
            .ok_or_else(|| AppIpcError::new("cloud_unavailable", "Cloud unavailable"))?;
        let callback = format!(
            "{}{}",
            connection.backend_url.trim_end_matches('/'),
            config["callbackPath"].as_str().unwrap_or("")
        );
        if plan {
            return Ok(
                json!({"instance":profile[0],"repository":source["name"],"subscriptionId":subscription,"callbackUrl":callback,"events":if github{json!(["*"])}else{json!(GITLAB_EVENTS)},"eventReference":"https://docs.gitlab.com/api/project_webhooks/","nativeApprovalRequired":true}),
            );
        }
        if args["callbackUrl"] != callback {
            return Err(AppIpcError::new(
                "bad_request",
                "Read git_webhook_plan before approving the exact callback destination",
            ));
        }
        let read = json!({"providerId":provider,"instance":profile[0],"profile":source["profile"],"repository":source["name"],"operation":"api","path":"hooks"});
        let existing = find_hook(read.clone(), &callback).await?;
        if let Some(hook) = existing.as_ref() {
            if events_match(github, &events, hook) {
                return Ok(public_hook(hook, &callback));
            }
        }
        let request = super::stand_in_tasks::required(args, "requestId")?;
        let mut action = args.clone();
        action["profile"] = source["profile"].clone();
        let (receipt, previous) = store
            .begin_git_subscription_operation(identity.user, subscription, request, &action)
            .map_err(super::stand_in::settings_error)?;
        if let Some(previous) = previous {
            return Ok(previous);
        }
        let mut body = if github {
            json!({"name":"web","active":true,"events":["*"],"config":{"url":callback,"content_type":"json","secret":config["secret"],"insecure_ssl":"0"}})
        } else {
            json!({"url":callback,"token":config["secret"],"enable_ssl_verification":true})
        };
        if !github {
            for event in &events {
                body[event.as_str().unwrap()] = json!(true);
            }
        }
        let mut write = read;
        write["method"] = json!(if existing.is_some() {
            if github {
                "PATCH"
            } else {
                "PUT"
            }
        } else {
            "POST"
        });
        if let Some(hook) = existing.as_ref() {
            write["path"] = json!(format!("hooks/{}", hook["id"]));
        }
        write["body"] = body;
        let result = super::super::git_connections::write(write).await?;
        if !events_match(github, &events, &result) {
            return Err(AppIpcError::new(
                "git_event_coverage_incomplete",
                "The platform did not enable every requested event; inspect webhook settings",
            ));
        }
        let result = public_hook(&result, &callback);
        store
            .complete_git_operation(identity.user, &receipt, &result)
            .map_err(super::stand_in::settings_error)?;
        Ok(result)
    }
}

async fn find_hook(mut query: Value, callback: &str) -> Result<Option<Value>, AppIpcError> {
    for page in 1..=100 {
        query["path"] = json!(format!("hooks?per_page=100&page={page}"));
        let response = super::super::git_connections::read(query.clone()).await?;
        let hooks = response["data"]
            .as_array()
            .ok_or_else(|| AppIpcError::new("git_connection_invalid", "Invalid webhook list"))?;
        if let Some(hook) = hooks
            .iter()
            .find(|hook| hook["config"]["url"] == callback || hook["url"] == callback)
        {
            return Ok(Some(hook.clone()));
        }
        if hooks.len() < 100 {
            return Ok(None);
        }
    }
    Err(AppIpcError::new(
        "git_backlog_limit",
        "Cannot enumerate every webhook; refusing to create a possible duplicate",
    ))
}

fn events_match(github: bool, events: &[Value], hook: &Value) -> bool {
    if github {
        hook["active"] == true
            && hook["events"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("*")))
    } else {
        !events.is_empty()
            && events
                .iter()
                .all(|event| event.as_str().is_some_and(|name| hook[name] == true))
            && hook.as_object().is_some_and(|fields| {
                fields.iter().all(|(key, value)| {
                    // GitLab serializes this system-hook field on project hooks,
                    // but the project webhook API cannot subscribe to it.
                    key == "repository_update_events"
                        || !key.ends_with("_events")
                        || !value.is_boolean()
                        || value == true
                })
            })
    }
}
fn public_hook(hook: &Value, callback: &str) -> Value {
    let flags: Map<String, Value> = hook
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| key.ends_with("_events") && value.is_boolean())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    json!({"id":hook["id"],"callbackUrl":callback,"events":hook["events"],"eventFlags":flags,"configured":true,"deliveryVerified":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gitlab_partial_or_new_disabled_events_are_not_complete() {
        let events = vec![json!("push_events")];
        assert!(!events_match(
            false,
            &events,
            &json!({"push_events":true,"note_events":false})
        ));
        assert!(!events_match(
            false,
            &events,
            &json!({"push_events":true,"future_events":false})
        ));
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"note_events":true})
        ));
        assert!(events_match(
            false,
            &events,
            &json!({"push_events":true,"repository_update_events":false})
        ));
        assert!(!events_match(
            false,
            &[json!("unknown_events")],
            &json!({"push_events":true})
        ));
    }
    #[test]
    fn configuration_results_hide_credentials_and_require_every_event() {
        let hook = json!({"id":1,"url":"https://cloud/hooks/id","token":"synthetic-secret","config":{"secret":"synthetic-secret"},"push_events":true,"note_events":false});
        assert!(!public_hook(&hook, "https://cloud/hooks/id")
            .to_string()
            .contains("synthetic-secret"));
        assert!(!events_match(
            false,
            &[json!("push_events"), json!("note_events")],
            &hook
        ));
        assert!(!events_match(false, &[json!("push_events")], &hook));
        assert!(!events_match(
            true,
            &[json!("*")],
            &json!({"active":true,"events":["issues"]})
        ));
    }
}
