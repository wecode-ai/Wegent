// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::issue_follow_events::Event;

impl AITableProvider {
    pub(crate) async fn event_page(
        &self,
        project: &LoopItem,
        task_id: &str,
        stream: &str,
        token: &Value,
    ) -> Result<(Vec<Event>, Value, bool), TaskRuntimeError> {
        let config = self.config(project)?;
        let record_id = record_id_from_task_id(task_id)?;
        let mut args = vec![
            "aitable",
            if stream == "history" {
                "record"
            } else {
                "comment"
            },
            if stream == "history" {
                "history-list"
            } else {
                "list"
            },
            "--base-id",
            &config.base_id,
            "--table-id",
            &config.table_id,
            "--record-id",
            record_id,
        ];
        let next_token;
        if stream == "history" {
            next_token = token.as_u64().unwrap_or(0).to_string();
            args.extend(["--limit", "50", "--offset", &next_token]);
        } else {
            args.extend(["--limit", "100"]);
            if let Some(token) = token.as_str().filter(|value| !value.is_empty()) {
                args.extend(["--cursor", token]);
            }
        }
        let response = tokio::time::timeout(std::time::Duration::from_secs(30), self.run(&args))
            .await
            .map_err(|_| {
                TaskRuntimeError::ProviderRequest("AI Table event request timed out".into())
            })??;
        if stream == "comments" {
            return comment_page(&response, token);
        }
        if stream != "history" {
            return Err(invalid("Unsupported AI Table event stream"));
        }
        let (config, _) = self.board_config(project).await?;
        let histories = response["data"]["histories"]
            .as_array()
            .ok_or_else(|| invalid("AI Table history response has no histories"))?;
        let mut events = Vec::new();
        for history in histories {
            if history["type"] != "field_change" {
                continue;
            }
            let old: Value = serde_json::from_str(
                history["oldValue"]
                    .as_str()
                    .ok_or_else(|| invalid("History oldValue is not JSON text"))?,
            )
            .map_err(|error| invalid(error.to_string()))?;
            let new: Value = serde_json::from_str(
                history["newValue"]
                    .as_str()
                    .ok_or_else(|| invalid("History newValue is not JSON text"))?,
            )
            .map_err(|error| invalid(error.to_string()))?;
            let at = history["operateTime"]
                .as_i64()
                .ok_or_else(|| invalid("History has no operation time"))?;
            let version = history["version"]
                .as_i64()
                .ok_or_else(|| invalid("History has no version"))?;
            for (mapping, kind) in [
                ("status_field_id", "status"),
                ("assignee_field_id", "assignee"),
            ] {
                let Some(field) = mapping_get(&config.mapping, mapping) else {
                    continue;
                };
                if field_values(&old, field) != field_values(&new, field) {
                    events.push(Event {
                        identity: format!("aitable:history:{version}:{at}:{kind}"),
                        kind: kind.into(),
                        occurred_at: Some(at),
                        comment_id: None,
                        body: String::new(),
                    });
                }
            }
        }
        Ok((
            events,
            json!(token.as_u64().unwrap_or(0) + 50),
            histories.len() < 50,
        ))
    }
}

fn field_values<'a>(value: &'a Value, field: &str) -> Vec<&'a Value> {
    match value {
        Value::Object(object) => object
            .iter()
            .flat_map(|(key, value)| {
                if key == field {
                    vec![value]
                } else {
                    field_values(value, field)
                }
            })
            .collect(),
        Value::Array(values) => values
            .iter()
            .flat_map(|value| field_values(value, field))
            .collect(),
        _ => Vec::new(),
    }
}

fn comment_page(
    response: &Value,
    token: &Value,
) -> Result<(Vec<Event>, Value, bool), TaskRuntimeError> {
    let comments = response["data"]["comments"]
        .as_array()
        .ok_or_else(|| invalid("AI Table comments are not an array"))?;
    let pagination = &response["meta"]["pagination"];
    let exhausted = pagination["endpoint_exhausted"]
        .as_bool()
        .ok_or_else(|| invalid("AI Table comments have no pagination state"))?;
    let next = pagination["next_token"].clone();
    if !exhausted && (next.as_str().map_or(true, str::is_empty) || next == *token) {
        return Err(invalid("AI Table comment cursor did not advance"));
    }
    let events = comments
        .iter()
        .map(|comment| {
            let topic = comment["topicId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("Comment has no topicId"))?;
            let key = comment["commentKey"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("Comment has no commentKey"))?;
            let identity =
                serde_json::to_string(&(topic, key)).map_err(|error| invalid(error.to_string()))?;
            Ok(Event {
                identity: format!("aitable:comment:{identity}"),
                kind: "comment".into(),
                occurred_at: comment["createTime"].as_i64(),
                comment_id: Some(identity),
                body: comment["content"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, TaskRuntimeError>>()?;
    Ok((events, next, exhausted))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_comment_page_requires_explicit_exhaustion() {
        let response = json!({"data":{"comments":[]},"meta":{"pagination":{"endpoint_exhausted":false,"next_token":"page2"}}});
        let (events, next, done) = comment_page(&response, &Value::Null).unwrap();
        assert!(events.is_empty());
        assert_eq!(next, "page2");
        assert!(!done);
        assert!(comment_page(&response, &json!("page2")).is_err());
    }

    #[test]
    fn comment_identity_includes_the_topic_and_allows_missing_time() {
        let response = json!({"data":{"comments":[{"topicId":"topic","commentKey":"reply","content":"Hi"}]},"meta":{"pagination":{"endpoint_exhausted":true}}});
        let (events, _, done) = comment_page(&response, &Value::Null).unwrap();
        assert!(done);
        assert_eq!(events[0].occurred_at, None);
        assert_eq!(events[0].identity, "aitable:comment:[\"topic\",\"reply\"]");
        assert_eq!(
            field_values(&json!({"cells":{"fld-status":"done"}}), "fld-status"),
            vec![&json!("done")]
        );
    }
}
