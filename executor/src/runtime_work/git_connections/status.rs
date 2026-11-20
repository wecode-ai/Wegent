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
    let mut response = api("github", instance, "POST", "graphql", Some(&query(input)?)).await?;
    let (request, profile) = checked_pull_request(instance, input, &response.data)?;
    response.data = request;
    Ok((response, profile))
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
