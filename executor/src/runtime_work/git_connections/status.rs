//! Fixed repository-bound GraphQL reads reuse the provider's status projection.
use super::*;

pub(super) fn query(input: &Value) -> Result<Value, AppIpcError> {
    let mut target = input.clone();
    target["operation"] = json!("object");
    target["entityKind"] = json!("change_request");
    endpoint("github", &target)?;
    let (owner, repository) = input["repository"]
        .as_str()
        .unwrap()
        .split_once('/')
        .filter(|(_, repository)| !repository.contains('/'))
        .ok_or_else(|| invalid("GitHub requires an exact owner/repository"))?;
    let fields: Value = serde_json::from_str(include_str!(
        "../../../../shared/protocol/git-change-request-status-query.json"
    ))
    .map_err(|_| invalid("Invalid bundled GitHub status query"))?;
    Ok(
        json!({"query":format!("query($owner:String!,$repository:String!,$number:Int!) {{ viewer {{ databaseId }} repository(owner:$owner,name:$repository) {{ databaseId pullRequest(number:$number) {{ {} }} }} }}",fields["fields"].as_str().unwrap()),
        "variables":{"owner":owner,"repository":repository,"number":input["number"]}}),
    )
}

pub(super) async fn read(instance: &str, input: &Value) -> Result<(ApiReply, String), AppIpcError> {
    let query = query(input)?;
    let mut response = api_request(
        "github",
        instance,
        "POST",
        "graphql",
        Some(&query),
        input["number"].as_u64(),
    )
    .await
    .map_err(|failure| failure.error)?;
    let (request, profile) = checked_pull_request(instance, input, &response.data)?;
    response.data = request;
    Ok((response, profile))
}

pub(super) fn log_cli_failure(
    number: u64,
    http_status: Option<u16>,
    exit_code: Option<i32>,
    stderr: &[u8],
) {
    crate::logging::log_executor_event(
        "GitHub PR status CLI failed",
        &[
            ("pr_number", number.to_string()),
            (
                "http_status",
                http_status.map_or("none".into(), |code| code.to_string()),
            ),
            (
                "exit_code",
                exit_code.map_or("none".into(), |code| code.to_string()),
            ),
            ("gh_stderr", sanitized_stderr(stderr)),
        ],
    );
}

fn sanitized_stderr(stderr: &[u8]) -> String {
    static SENSITIVE: OnceLock<regex::Regex> = OnceLock::new();
    let sensitive = SENSITIVE.get_or_init(|| {
        regex::Regex::new(
            r#"(?i)https?://[^\s"'<>]+|\b(?:gh[pousr]_|github_pat_)[a-z0-9_]+|\b(?:authorization|proxy-authorization|cookie|set-cookie|gh_(?:enterprise_)?token|github_(?:enterprise_)?token)["']?[ \t]*[:=][^\r\n]*"#,
        )
        .expect("gh diagnostic redaction pattern is valid")
    });
    let raw = String::from_utf8_lossy(stderr);
    let redacted = sensitive.replace_all(&raw, "[redacted]");
    let redacted = crate::agents::redact_diagnostic_text(&redacted);
    redacted
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|character| !character.is_control())
        .take(512)
        .collect()
}

fn checked_pull_request(
    instance: &str,
    input: &Value,
    response: &Value,
) -> Result<(Value, String), AppIpcError> {
    let account = response["data"]["viewer"]["databaseId"]
        .as_u64()
        .ok_or_else(|| invalid("Missing account ID"))?;
    let profile = json!([instance, account.to_string()]).to_string();
    verify_profile(input, &profile)?;
    let request = response
        .pointer("/data/repository/pullRequest")
        .filter(|value| value.is_object())
        .filter(|value| value["number"] == input["number"])
        .filter(|_| {
            response["errors"]
                .as_array()
                .map_or(true, |errors| errors.is_empty())
        })
        .cloned()
        .ok_or_else(|| {
            AppIpcError::new(
                "git_status_unavailable",
                "Cannot read the complete pull request status",
            )
        })?;
    if let Some(expected) = input.get("repositoryId") {
        verify_repository_id(&response["data"]["repository"]["databaseId"], expected)?;
    }
    Ok((request, profile))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_diagnostic_preserves_error_and_redacts_credentials() {
        let stderr = b"gh: Post \"https://user:proxy-secret@api.github.com/graphql?key=url-secret\": unexpected EOF\nAuthorization: Basic header-secret\nCookie: session=cookie-secret\ntrace ghp_token123 and github_pat_token456 password='field secret'";
        let diagnostic = sanitized_stderr(stderr);
        assert_eq!(
            diagnostic,
            "gh: Post \"[redacted]\": unexpected EOF [redacted] [redacted] trace [redacted] and [redacted] password=[redacted]"
        );
        assert_eq!(
            sanitized_stderr("错".repeat(600).as_bytes())
                .chars()
                .count(),
            512
        );
    }

    #[test]
    fn status_query_is_fixed_read_only_and_binds_the_exact_resource() {
        let request = query(&json!({"repository":"org/repo","number":7})).unwrap();
        assert_eq!(
            request["variables"],
            json!({"owner":"org","repository":"repo","number":7})
        );
        assert!(request["query"].as_str().unwrap().starts_with("query("));
        assert!(request["query"]
            .as_str()
            .unwrap()
            .contains("viewer { databaseId }"));
        assert!(request["query"]
            .as_str()
            .unwrap()
            .contains("mergeQueueEntry"));
        for input in [
            json!({"repository":"org/repo/extra","number":7}),
            json!({"repository":"org/repo","number":0}),
            json!({"repository":"org/repo","number":"7) { mutation"}),
        ] {
            assert!(query(&input).is_err());
        }
    }

    #[test]
    fn pull_request_status_requires_the_bound_account_and_repository() {
        let instance = "https://github.com";
        let profile = json!([instance, "7"]).to_string();
        let input = json!({"number":1,"profile":profile,"repositoryId":"42"});
        let mut response = json!({"data":{
            "viewer":{"databaseId":7},
            "repository":{"databaseId":42,"pullRequest":{"number":1,"state":"OPEN"}}
        }});
        let (status, observed_profile) = checked_pull_request(instance, &input, &response).unwrap();
        assert_eq!(status["state"], "OPEN");
        assert_eq!(observed_profile, profile);

        response["data"]["repository"]["databaseId"] = json!(43);
        assert!(checked_pull_request(instance, &input, &response).is_err());
        response["data"]["repository"]["databaseId"] = json!(42);
        response["data"]["viewer"]["databaseId"] = json!(8);
        assert_eq!(
            checked_pull_request(instance, &input, &response)
                .unwrap_err()
                .code,
            "git_account_changed"
        );
    }
}
