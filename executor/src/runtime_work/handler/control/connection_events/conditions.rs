//! Expand common Git waits once; delivery evaluates the same durable predicate on every host.
use super::*;

pub(super) fn resolve(args: &Value) -> Result<Value, AppIpcError> {
    let Some(preset) = args.get("git_wait") else {
        if args.get("head_sha").is_some() {
            return Err(invalid(
                "head_sha requires git_wait; use a pointer in custom match",
            ));
        }
        return Ok(args.get("match").cloned().unwrap_or(json!({})));
    };
    if args.get("match").is_some() {
        return Err(invalid("Choose git_wait or match, not both"));
    }
    let preset = preset
        .as_str()
        .filter(|s| matches!(*s, "merge" | "checks" | "run"))
        .ok_or_else(|| invalid("Choose git_wait: merge, checks or run"))?;
    let (topic, number, github) = selection(&args["source"], preset)?;
    let mut filter = json!({"/topicId":topic});
    if preset != "run" {
        filter["/external/eventType"] = json!("tracked.status");
    } else if !github {
        filter["/external/eventType"] = json!("tracked.pipeline");
    }
    if preset != "merge" || args.get("head_sha").is_some() {
        let sha = args["head_sha"]
            .as_str()
            .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| invalid("git_wait requires the exact 40-character head_sha"))?;
        if preset != "merge" {
            filter[if preset == "run" && github {
                "/external/payload/head_sha"
            } else if github {
                "/external/payload/headRefOid"
            } else {
                "/external/payload/sha"
            }] = json!(sha.to_ascii_lowercase());
        }
    }
    if preset == "run" {
        filter["/external/payload/id"] = json!(number);
        if github {
            filter["$any"] = json!([
                {"/external/eventType":"tracked.workflow_run","/external/payload/status":"completed"},
                {"/external/eventType":"tracked.workflow_run_pr_conflict"}
            ]);
        } else {
            filter["$any"] = outcomes(
                "/external/payload/status",
                &["success", "failed", "canceled", "skipped", "manual"],
            );
        }
    } else {
        let mut alternatives = if github {
            outcomes(
                "/external/payload/statusCheckRollup/state",
                &["SUCCESS", "FAILURE", "ERROR"],
            )
        } else {
            outcomes(
                "/external/payload/head_pipeline/status",
                &["success", "failed", "canceled", "skipped", "manual"],
            )
        };
        if preset == "merge" {
            alternatives.as_array_mut().unwrap().extend(if github {
                vec![
                    json!({"/external/payload/mergeable":"CONFLICTING"}),
                    json!({"/external/payload/mergeStateStatus":"DIRTY"}),
                    json!({"/external/payload/state":"CLOSED"}),
                    json!({"/external/payload/state":"MERGED"}),
                ]
            } else {
                vec![
                    json!({"/external/payload/has_conflicts":true}),
                    json!({"/external/payload/detailed_merge_status":"conflict"}),
                    json!({"/external/payload/state":"closed"}),
                    json!({"/external/payload/state":"merged"}),
                ]
            });
        }
        filter["$any"] = alternatives;
    }
    Ok(filter)
}

pub(super) fn same_merge_wait(record: &Value, intent: &Value, session: &Value) -> bool {
    if record["session"] != *session
        || !matches!(
            record["status"].as_str(),
            Some("preparing" | "armed" | "pending")
        )
        || record["source"]["observeCurrentStatus"] != true
        || !["providerId", "profile", "kind", "id"]
            .iter()
            .all(|field| record["source"][*field] == intent["source"][*field])
    {
        return false;
    }
    merge_filter_without_head(&record["match"]) == intent["match"]
}

pub(super) fn legacy_merge_retry(stored: &Value, intent: &Value, previous: &Value) -> bool {
    let mut normalized = stored.clone();
    let filter = merge_filter_without_head(&stored["match"]);
    if filter == stored["match"] {
        return false;
    }
    normalized["match"] = filter;
    normalized == *intent || normalized == *previous
}

fn merge_filter_without_head(filter: &Value) -> Value {
    let mut filter = filter.clone();
    if let Some(fields) = filter.as_object_mut() {
        fields.remove("/external/payload/headRefOid");
        fields.remove("/external/payload/sha");
    }
    filter
}

fn outcomes(pointer: &str, values: &[&str]) -> Value {
    Value::Array(values.iter().map(|value| json!({pointer:*value})).collect())
}

fn selection(source: &Value, preset: &str) -> Result<(String, u64, bool), AppIpcError> {
    let github = match source["providerId"].as_str() {
        Some("@wegent/dsh-connection-git/github") => true,
        Some("@wegent/dsh-connection-git/gitlab") => false,
        _ => {
            return Err(invalid(
                "git_wait requires a discovered GitHub or GitLab resource",
            ))
        }
    };
    let selected = source["monitoredObjects"]
        .as_array()
        .filter(|rows| rows.len() == 1)
        .ok_or_else(|| invalid("Discover exactly one PR, MR or CI run for git_wait"))?;
    let kind = if preset == "run" {
        if github {
            "workflow_run"
        } else {
            "pipeline"
        }
    } else {
        "change_request"
    };
    if source["kind"] != "repository" || selected[0]["entityKind"] != kind {
        return Err(invalid(
            "git_wait does not match the discovered resource kind",
        ));
    }
    let number = selected[0]["number"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| invalid("Invalid selected Git resource number"))?;
    let profile: Value = serde_json::from_str(source["profile"].as_str().unwrap_or_default())
        .map_err(|_| invalid("Invalid Git profile"))?;
    let instance = reqwest::Url::parse(profile[0].as_str().unwrap_or_default())
        .map_err(|_| invalid("Invalid Git instance"))?;
    if !matches!(instance.scheme(), "http" | "https")
        || instance.host_str().is_none()
        || !instance.username().is_empty()
        || instance.password().is_some()
        || instance.query().is_some()
        || instance.fragment().is_some()
        || instance.path() != "/"
    {
        return Err(invalid("Invalid Git instance"));
    }
    let repo = source["name"].as_str().unwrap_or_default();
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() < 2
        || (github && parts.len() != 2)
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err(invalid("Invalid Git repository"));
    }
    let route = match (github, preset == "run") {
        (true, true) => "actions/runs",
        (true, false) => "pull",
        (false, true) => "-/pipelines",
        (false, false) => "-/merge_requests",
    };
    Ok((
        format!("{}{repo}/{route}/{number}", instance.as_str()),
        number,
        github,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(preset: &str) -> Value {
        json!({"git_wait":preset,"head_sha":"bcefb56682a9e1ea1ccfbbeaffa2a9bee31f9d34",
            "source":{"providerId":"@wegent/dsh-connection-git/github","kind":"repository",
                "profile":"[\"https://github.com\",\"4157870\"]","name":"wecode-ai/Wegent",
                "monitoredObjects":[{"entityKind":"change_request","number":4749}]}})
    }
    fn event(state: &str, mergeable: &str) -> Value {
        json!({"topicId":"https://github.com/wecode-ai/Wegent/pull/4749","external":{"eventType":"tracked.status",
            "payload":{"headRefOid":"bcefb56682a9e1ea1ccfbbeaffa2a9bee31f9d34",
                "statusCheckRollup":{"state":state},"mergeable":mergeable}}})
    }
    #[test]
    fn merge_wait_wakes_on_conflict_while_ci_is_pending() {
        let filter = resolve(&input("merge")).unwrap();
        validate_filter(&filter).unwrap();
        assert!(matches_event(&filter, &event("PENDING", "CONFLICTING")));
        assert!(!matches_event(&filter, &event("PENDING", "MERGEABLE")));
        for state in ["SUCCESS", "FAILURE", "ERROR"] {
            assert!(matches_event(&filter, &event(state, "MERGEABLE")));
        }
        let mut dirty = event("PENDING", "UNKNOWN");
        dirty["external"]["payload"]["mergeStateStatus"] = json!("DIRTY");
        assert!(matches_event(&filter, &dirty));
        for state in ["CLOSED", "MERGED"] {
            let mut closed = event("PENDING", "UNKNOWN");
            closed["external"]["payload"]["state"] = json!(state);
            assert!(matches_event(&filter, &closed));
        }
        let mut wrong = event("PENDING", "CONFLICTING");
        wrong["external"]["payload"]["headRefOid"] = json!("other");
        assert!(matches_event(&filter, &wrong));
        wrong = event("FAILURE", "MERGEABLE");
        wrong["topicId"] = json!("https://github.com/other/repo/pull/4749");
        assert!(!matches_event(&filter, &wrong));
    }
    #[test]
    fn checks_wait_does_not_wake_for_unrequested_conflicts() {
        assert!(!matches_event(
            &resolve(&input("checks")).unwrap(),
            &event("PENDING", "CONFLICTING")
        ));
    }
    #[test]
    fn workflow_wait_covers_every_terminal_conclusion() {
        let mut args = input("run");
        args["source"]["monitoredObjects"][0]["entityKind"] = json!("workflow_run");
        let filter = resolve(&args).unwrap();
        validate_filter(&filter).unwrap();
        for conclusion in ["success", "failure", "cancelled", "timed_out"] {
            let mut e = json!({"topicId":"https://github.com/wecode-ai/Wegent/actions/runs/4749",
                "external":{"eventType":"tracked.workflow_run","payload":{"id":4749,
                    "head_sha":args["head_sha"],"status":"completed","conclusion":conclusion}}});
            assert!(matches_event(&filter, &e));
            e["external"]["payload"]["id"] = json!(4750);
            assert!(!matches_event(&filter, &e));
        }
    }
    #[test]
    fn github_run_wait_matches_conflict_for_the_exact_run_and_head() {
        let mut args = input("run");
        args["source"]["monitoredObjects"][0]["entityKind"] = json!("workflow_run");
        let filter = resolve(&args).unwrap();
        let mut event = json!({
            "topicId": "https://github.com/wecode-ai/Wegent/actions/runs/4749",
            "external": {
                "eventType": "tracked.workflow_run_pr_conflict",
                "payload": {"id":4749,"head_sha":args["head_sha"]}
            }
        });
        assert!(matches_event(&filter, &event));
        event["external"]["payload"]["head_sha"] = json!("stale");
        assert!(!matches_event(&filter, &event));
        event["external"]["payload"]["head_sha"] = args["head_sha"].clone();
        event["external"]["payload"]["id"] = json!(4750);
        assert!(!matches_event(&filter, &event));
    }
    #[test]
    fn rejects_ambiguous_or_mismatched_conditions() {
        for (pointer, value) in [
            ("/match", json!({})),
            ("/git_wait", json!("unknown")),
            ("/head_sha", json!("short")),
            ("/source/providerId", json!("other")),
            ("/source/monitoredObjects", json!([])),
            ("/source/name", json!("../repo")),
        ] {
            let mut args = input("merge");
            if pointer == "/match" {
                args["match"] = json!({});
            }
            *args
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("{pointer}")) = value;
            assert!(resolve(&args).is_err(), "{pointer}");
        }
    }
    #[test]
    fn gitlab_uses_the_same_wait_modes_and_exact_nested_repository_scope() {
        let mut args = input("merge");
        args["source"]["providerId"] = json!("@wegent/dsh-connection-git/gitlab");
        args["source"]["name"] = json!("group/sub/repo");
        args["source"]["profile"] = json!("[\"https://git.example\",\"7\"]");
        let filter = resolve(&args).unwrap();
        validate_filter(&filter).unwrap();
        let mut e = json!({"topicId":"https://git.example/group/sub/repo/-/merge_requests/4749",
            "external":{"eventType":"tracked.status","payload":{"sha":args["head_sha"],
                "head_pipeline":{"status":"running"},"has_conflicts":true}}});
        assert!(matches_event(&filter, &e));
        args["git_wait"] = json!("checks");
        assert!(!matches_event(&resolve(&args).unwrap(), &e));
        e["external"]["payload"]["has_conflicts"] = json!(false);
        for status in ["success", "failed", "canceled", "skipped", "manual"] {
            e["external"]["payload"]["head_pipeline"]["status"] = json!(status);
            assert!(matches_event(&resolve(&args).unwrap(), &e));
        }
        args["git_wait"] = json!("run");
        args["source"]["monitoredObjects"][0]["entityKind"] = json!("pipeline");
        e = json!({"topicId":"https://git.example/group/sub/repo/-/pipelines/4749",
            "external":{"eventType":"tracked.pipeline","payload":{"id":4749,"sha":args["head_sha"],"status":"failed"}}});
        let filter = resolve(&args).unwrap();
        assert!(matches_event(&filter, &e));
        e["external"]["payload"]["status"] = json!("running");
        assert!(!matches_event(&filter, &e));
    }
}
