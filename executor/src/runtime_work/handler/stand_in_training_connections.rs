//! Read attributed history through the role's current source grant.
use super::stand_in::settings_error;
use super::stand_in_ingress::message_time;
use super::*;
use crate::runtime_work::connection_host::{review_reader, ReviewReader};
use crate::task_runtime::personal_stand_in::{
    source_provider, stand_in_collection_connection, stand_in_identities, DINGTALK_PROVIDER,
    ISSUE_COMMENTS_PROVIDER,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn denied() -> AppIpcError {
    AppIpcError::new(
        "permission_denied",
        "Training source is no longer connected to this role",
    )
}

fn invalid() -> AppIpcError {
    AppIpcError::new(
        "connection_response_invalid",
        "Invalid attributed conversation history",
    )
}

fn source_ref(grant: &Value, id: &Value, collected_only: bool) -> Value {
    let mut result = json!({"providerId":source_provider(grant),"profile":grant["profile"],"kind":grant["kind"],
        "id":id,"enabledAfter":grant["enabledAfter"]});
    if collected_only {
        result["collectedObservations"] = json!(true);
    }
    for key in ["collectionKey", "transport"] {
        if let Some(value) = grant.get(key) {
            result[key] = value.clone();
        }
    }
    result
}

fn review_coverage(source: &Value, page: &Value) -> &'static str {
    if !page["coverageGap"].is_null() {
        return "partial";
    }
    if source_provider(source) == DINGTALK_PROVIDER {
        if source["kind"] != "direct"
            && !(source["kind"] == "group" && source["collectionKey"] == "all-messages")
        {
            return "partial";
        }
        // This provider already supplied bounded, two-sided history before the capability
        // declaration existed. Every new provider must explicitly attest its coverage.
        if page.get("reviewCoverage").is_none() {
            return "complete";
        }
    }
    if page["reviewCoverage"] == "complete" {
        "complete"
    } else {
        "partial"
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn training_connection_sources(
        &self,
        store: &LocalTaskStore,
        user: i64,
    ) -> Result<Vec<Value>, AppIpcError> {
        let roles = self.connection_learning_roles(store, user)?;
        let mut sources = self.matching_learning_connections(store, user, &roles, None)?;
        sources.extend(self.issue_training_sources(store, user, &roles)?);
        Ok(sources)
    }

    fn matching_learning_connections(
        &self,
        store: &LocalTaskStore,
        user: i64,
        roles: &[Value],
        required: Option<(&str, &Value)>,
    ) -> Result<Vec<Value>, AppIpcError> {
        let mut sources = BTreeMap::new();
        let mut observations = None;
        for role in roles {
            if required.is_some_and(|(role_id, _)| role["id"] != role_id) {
                continue;
            }
            for grant in role["connections"].as_array().into_iter().flatten() {
                let Some(kind) = grant["kind"].as_str() else {
                    continue;
                };
                let provider = source_provider(grant);
                let reader = if provider == DINGTALK_PROVIDER && matches!(kind, "direct" | "group")
                {
                    ReviewReader::Native
                } else if let Some(reader) = review_reader(provider, kind) {
                    reader
                } else {
                    continue;
                };
                if required.is_some_and(|(_, source)| {
                    stand_in_collection_connection(role, source) != Some(grant)
                }) {
                    continue;
                }
                let mut add = |resource: Value| {
                    if required.is_some_and(|(_, source)| *source != resource) {
                        return;
                    }
                    let key = json!([
                        role["id"],
                        resource["providerId"],
                        resource["profile"],
                        resource["kind"],
                        resource["id"],
                        resource["transport"],
                        resource["collectionKey"]
                    ])
                    .to_string();
                    sources.insert(key, json!({"roleId":role["id"],"source":resource}));
                };
                if reader == ReviewReader::Native && grant["scope"] != "all" {
                    add(source_ref(grant, &grant["id"], false));
                    continue;
                }
                if observations.is_none() {
                    observations = Some(
                        store
                            .observed_training_resources(user)
                            .map_err(settings_error)?,
                    );
                }
                let since = message_time(&grant["enabledAfter"])?;
                for row in observations.iter().flatten() {
                    if row["roleId"] != role["id"]
                        || row["providerId"] != source_provider(grant)
                        || row["profile"] != grant["profile"]
                        || row["kind"] != grant["kind"]
                        || row["transport"] != grant["transport"]
                        || row["collectionKey"] != grant["collectionKey"]
                        || (row["enabledAfter"] != grant["enabledAfter"]
                            && !(provider == DINGTALK_PROVIDER && row["enabledAfter"].is_null()))
                        || row["id"] == "*"
                        || !message_time(&row["at"]).is_ok_and(|at| at >= since)
                    {
                        continue;
                    }
                    let resource = source_ref(grant, &row["id"], reader == ReviewReader::Collected);
                    if stand_in_collection_connection(role, &resource) == Some(grant) {
                        add(resource);
                    }
                }
            }
        }
        Ok(sources.into_values().collect())
    }

    pub(super) fn connection_learning_roles(
        &self,
        store: &LocalTaskStore,
        user: i64,
    ) -> Result<Vec<Value>, AppIpcError> {
        self.verify_local_stand_in_owner(user)?;
        let settings = store
            .configured_personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        if !settings["lifecycle"]["status"].is_null() {
            return Ok(vec![]);
        }
        Ok(stand_in_identities(&settings)
            .into_iter()
            .filter(|role| {
                role["enabled"] == true
                    && role["selfLearningEnabled"] == true
                    && self.stand_in_role_runs_here(role)
            })
            .collect())
    }

    pub(super) async fn training_connection_page(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &str,
        source: &Value,
        since: i64,
        through: i64,
        cursor: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let native_cursor = cursor.and_then(Value::as_str);
        // Native cursors (including those saved by previous releases) are opaque strings.
        // Only a host-created object may resume a collection explicitly selected by a reader.
        let collected_cursor = cursor.and_then(|value| value["collectedEvents"].as_str());
        if cursor.is_some() && native_cursor.is_none() && collected_cursor.is_none() {
            return Err(invalid());
        }
        if source["providerId"] == ISSUE_COMMENTS_PROVIDER {
            if collected_cursor.is_some() {
                return Err(invalid());
            }
            return self
                .issue_training_page(store, user, role, source, since, through, native_cursor)
                .await;
        }
        let authorize = || {
            let roles = self.connection_learning_roles(store, user)?;
            if self
                .matching_learning_connections(store, user, &roles, Some((role, source)))?
                .is_empty()
            {
                return Err(denied());
            }
            let identity = roles
                .iter()
                .find(|identity| identity["id"] == role)
                .ok_or_else(denied)?;
            let device = identity["executionDeviceId"]
                .as_str()
                .ok_or_else(denied)?
                .to_owned();
            let mut grant = stand_in_collection_connection(identity, source)
                .cloned()
                .ok_or_else(denied)?;
            // The provider needs its saved filters and repository/mailbox configuration.
            // Limit wildcard grants to the one observed, authorized resource for this read.
            grant["id"] = source["id"].clone();
            let fields = grant.as_object_mut().ok_or_else(denied)?;
            fields.remove("scope");
            fields.remove("excludedResources");
            Ok((grant, device))
        };
        let (grant, device) = authorize()?;
        let since = since.max(message_time(&source["enabledAfter"])?);
        if source["collectedObservations"] == true {
            if collected_cursor.is_some() {
                return Err(invalid());
            }
            return store
                .collected_observation_page(
                    user,
                    &device,
                    role,
                    source,
                    since,
                    through,
                    native_cursor,
                )
                .map_err(settings_error);
        }
        if since >= through {
            return Ok(
                json!({"messages":[],"hasMore":false,"nextCursor":null,"reviewCoverage":"complete"}),
            );
        }
        let date = |ms| {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|date| date.to_rfc3339())
                .ok_or_else(invalid)
        };
        let mut request = json!({"source":grant,"query":{"since":date(since)?,
            "trainingUntil":date(through)?,"limit":20}});
        if let Some(cursor) = native_cursor {
            request["cursor"] = json!(cursor);
        }
        let page = self
            .connection_call("readSource", source["providerId"].as_str(), request)
            .await?;
        let (current_grant, current_device) = authorize()?;
        if current_grant != grant || current_device != device {
            return Err(denied());
        }
        if page["reviewUseCollectedEvents"] == true {
            if native_cursor.is_some()
                || page["reviewCoverage"] != "partial"
                || page["hasMore"] != false
                || !page["items"].as_array().is_some_and(Vec::is_empty)
                || !page["nextCursor"].is_null()
                || !page["coverageGap"].is_null()
            {
                return Err(invalid());
            }
            let mut collected_source = source.clone();
            collected_source["collectedObservations"] = json!(true);
            let mut result = store
                .collected_observation_page(
                    user,
                    &device,
                    role,
                    &collected_source,
                    since,
                    through,
                    collected_cursor,
                )
                .map_err(settings_error)?;
            if result["hasMore"] == true {
                result["nextCursor"] = json!({"collectedEvents":result["nextCursor"]});
            }
            return Ok(result);
        }
        if collected_cursor.is_some()
            || (!page["nextCursor"].is_null() && !page["nextCursor"].is_string())
        {
            return Err(invalid());
        }
        let mut messages = Vec::new();
        for item in page["items"].as_array().ok_or_else(invalid)? {
            let at = message_time(&item["at"])?;
            if at < since || at >= through {
                continue;
            }
            let id = item["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(invalid)?;
            let content = item["text"].as_str().ok_or_else(invalid)?;
            let attributable = item["truncated"] != true
                && item["conversationId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty());
            let author = match (attributable, item["author"].as_str()) {
                (true, Some("owner")) => "owner",
                (true, Some("participant")) => "participant",
                (true, Some("accountAutomation" | "authenticatedAccount" | "accountCandidate")) => {
                    let matches = store
                        .training_reply_matches(
                            user,
                            role,
                            source,
                            id,
                            at,
                            item["quotedMessageId"].as_str().unwrap_or_default(),
                            content,
                            item["conversationId"].as_str(),
                        )
                        .map_err(settings_error)?;
                    if matches {
                        "assistant"
                    } else {
                        "unknown"
                    }
                }
                _ => "unknown",
            };
            let participant_key = item["participantId"]
                .as_str()
                .filter(|id| author == "participant" && !id.is_empty())
                .map(|id| {
                    format!(
                        "{:x}",
                        Sha256::digest(
                            json!([
                                user,
                                role,
                                source["providerId"],
                                source["profile"],
                                item["conversationId"],
                                id
                            ])
                            .to_string()
                        )
                    )
                });
            messages.push(json!({"id":id,
                "author":author,"at":at,"content":content,
                "conversationId":item["conversationId"],"topicId":item["topicId"],
                "isSelfConversation":item["isSelfConversation"] == true,
                "participantKey":participant_key,
                "quotedMessageId":item["quotedMessageId"],"truncated":item["truncated"] == true}));
        }
        let mut result = json!({"messages":messages,"hasMore":page["hasMore"].as_bool().ok_or_else(invalid)?,
            "nextCursor":page["nextCursor"]});
        result["reviewCoverage"] = json!(review_coverage(source, &page));
        if let Some(gap) = page.get("coverageGap") {
            result["coverageGap"] = gap.clone();
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_native_full_history_or_the_known_dingtalk_contract_attests_coverage() {
        let mut source = json!({"providerId":"example/provider","kind":"direct"});
        assert_eq!(review_coverage(&source, &json!({})), "partial");
        assert_eq!(
            review_coverage(&source, &json!({"reviewCoverage":"complete"})),
            "complete"
        );
        source["providerId"] = json!(DINGTALK_PROVIDER);
        assert_eq!(review_coverage(&source, &json!({})), "complete");
        assert_eq!(
            review_coverage(&source, &json!({"reviewCoverage":"partial"})),
            "partial"
        );
        source["kind"] = json!("group");
        assert_eq!(
            review_coverage(&source, &json!({"reviewCoverage":"complete"})),
            "partial"
        );
    }

    #[test]
    fn current_grants_include_exact_sources_without_work_and_only_observed_allowed_wildcard_resources(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let handler = RuntimeWorkRpcHandler::new("mac", "unused");
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let mut data = store.personal_stand_in(7, "mac").unwrap();
        let exact = json!({"providerId":DINGTALK_PROVIDER,"profile":"owner","kind":"direct",
            "id":"contact","name":"Contact","policy":{"automatic":false,"askBeforeAct":true}});
        let mut wildcard = exact.clone();
        wildcard["kind"] = json!("group");
        wildcard["scope"] = json!("all");
        wildcard["id"] = json!("*");
        wildcard["excludedResources"] = json!([{"id":"excluded","name":"Excluded"}]);
        data["primary"] =
            json!({"enabled":true,"prompt":"","preferences":"","connections":[exact,wildcard]});
        let mut data = store.save_personal_stand_in(7, "mac", data).unwrap();
        assert!(handler
            .training_connection_sources(&store, 7)
            .unwrap()
            .is_empty());
        data["primary"]["selfLearningEnabled"] = json!(true);
        let data = store.save_personal_stand_in(7, "mac", data).unwrap();
        for (id, target_role) in [
            ("observed", "@primary"),
            ("excluded", "@primary"),
            ("other-role", "default"),
        ] {
            let mut source = data["primary"]["connections"][1].clone();
            source.as_object_mut().unwrap().remove("scope");
            source["id"] = json!(id);
            let message = json!({"id":"msg","at":chrono::Utc::now().to_rfc3339(),"text":"Mention"});
            let event = json!({"kind":"connection","source":source,"message":message,"roleIds":[target_role],"roleScoped":true});
            store
                .enqueue_stand_in_event(
                    7,
                    json!([DINGTALK_PROVIDER, "owner", "group", id, "msg", target_role]),
                    event,
                )
                .unwrap();
        }
        let rows = handler.training_connection_sources(&store, 7).unwrap();
        let ids: Vec<_> = rows
            .iter()
            .map(|row| row["source"]["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["contact", "observed"]);
        assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
        let mut data = data;
        data["primary"]["connections"] = json!([]);
        store.save_personal_stand_in(7, "mac", data).unwrap();
        assert!(handler
            .training_connection_sources(&store, 7)
            .unwrap()
            .is_empty());
    }
}
