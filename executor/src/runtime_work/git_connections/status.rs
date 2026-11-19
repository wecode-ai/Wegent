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
        json!({"query":format!("query($owner:String!,$repository:String!,$number:Int!) {{ repository(owner:$owner,name:$repository) {{ pullRequest(number:$number) {{ {} }} }} }}",fields["fields"].as_str().unwrap()),
        "variables":{"owner":owner,"repository":repository,"number":input["number"]}}),
    )
}

pub(super) async fn read(instance: &str, input: &Value) -> Result<ApiReply, AppIpcError> {
    let mut response = api("github", instance, "POST", "graphql", Some(&query(input)?)).await?;
    let request = response
        .data
        .pointer("/data/repository/pullRequest")
        .filter(|value| value.is_object())
        .filter(|value| value["number"] == input["number"])
        .filter(|_| {
            response.data["errors"]
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
    response.data = request;
    Ok(response)
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
            .contains("mergeQueueEntry"));
        for input in [
            json!({"repository":"org/repo/extra","number":7}),
            json!({"repository":"org/repo","number":0}),
            json!({"repository":"org/repo","number":"7) { mutation"}),
        ] {
            assert!(query(&input).is_err());
        }
    }
}
