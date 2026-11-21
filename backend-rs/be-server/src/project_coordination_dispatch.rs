//! Coordinator decisions admit real group executions; their execution rows are receipts.
use super::*;
use crate::background_jobs::project::{authority, issues, queue};

fn bad_request(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, message)
}

fn command_scope(project: &str, group: &str, command: &str) -> Result<String, FastApiError> {
    canonical_id(project)?;
    canonical_id(group)?;
    if command.is_empty()
        || command.len() > 64
        || !command
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(bad_request("Invalid coordination command identity"));
    }
    Ok(format!("coordination:{project}:{group}:{command}"))
}

fn command_input(
    actor: i64,
    project: &str,
    group: &str,
    command: &str,
    body: &Value,
) -> Result<Value, FastApiError> {
    for key in ["deviceId", "generation", "issueId"] {
        if !body[key]
            .as_str()
            .is_some_and(|value| !value.is_empty() && value.len() <= 256)
        {
            return Err(bad_request(
                "A running device, binding generation and Issue are required",
            ));
        }
    }
    for key in ["projectVersion", "groupVersion", "issueVersion"] {
        if body[key].as_i64().is_none_or(|version| version <= 0) {
            return Err(bad_request(
                "Current project, group and Issue versions are required",
            ));
        }
    }
    Ok(
        json!({"userId":actor,"projectId":project,"groupId":group,"commandId":command,"deviceId":body["deviceId"],"generation":body["generation"],"issueId":body["issueId"],"issueVersion":body["issueVersion"],"groupVersion":body["groupVersion"],"projectVersion":body["projectVersion"]}),
    )
}

#[brz_http_server::get(
    "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id/authorization"
)]
async fn authorize_command(
    #[inject(state)] state: &AppState,
    #[auth] actor: crate::loop_tasks::auth::FlexibleUser,
    project_id: &str,
    group_id: &str,
    command_id: &str,
) -> Result<Value, FastApiError> {
    let scope = command_scope(project_id, group_id, command_id)?;
    let context = crate::background_jobs::robot::coordination_context(
        state,
        project_id,
        &scope,
        i64::from(actor.0.id),
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "project coordination authorization dependency failure");
        FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Unable to validate project coordination authorization",
        )
    })?
    .ok_or_else(|| {
        FastApiError::forbidden("Project coordination authorization is unavailable or revoked")
    })?;
    Ok(json!({"authorized":true,"context":context}))
}

#[derive(FromMysqlRow)]
struct Receipt {
    id: i64,
    assigner_user_id: i64,
    loop_item_id: String,
    status: String,
    execution_payload: String,
}

const RECEIPT_SQL: &str = "SELECT id,assigner_user_id,loop_item_id,status,execution_payload FROM loop_item_executions WHERE execution_scope=? ORDER BY id LIMIT 1";

impl Receipt {
    fn result(
        &self,
        actor: i64,
        command: &str,
        digest: Option<&str>,
    ) -> Result<Value, FastApiError> {
        if self.assigner_user_id != actor {
            return Err(FastApiError::forbidden(
                "This coordination command belongs to another member",
            ));
        }
        let intent: Value = serde_json::from_str(&self.execution_payload).map_err(|_| {
            FastApiError::detail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The coordination command receipt is invalid",
            )
        })?;
        if let Some(digest) = digest
            && intent["origin_context"]["project_coordination"]["inputDigest"] != digest
        {
            return Err(conflict(
                "This coordination command already has different immutable input",
            ));
        }
        Ok(
            json!({"commandId":command,"accepted":true,"execution":{"id":self.id,"issueId":self.loop_item_id,"status":self.status}}),
        )
    }
}

#[brz_http_server::get(
    "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id"
)]
async fn get_command(
    #[inject(state)] state: &AppState,
    #[auth] actor: SessionUser,
    project_id: &str,
    group_id: &str,
    command_id: &str,
) -> Result<Value, FastApiError> {
    let scope = command_scope(project_id, group_id, command_id)?;
    access(state, project_id, actor.0.id).await?;
    let receipt: Option<Receipt> = state
        .mysql
        .fetch_optional(RECEIPT_SQL, (scope.as_str(),))
        .await
        .map_err(crate::cloud_projects::internal_error)?;
    receipt
        .map(|receipt| receipt.result(i64::from(actor.0.id), command_id, None))
        .unwrap_or_else(|| Ok(json!({"commandId":command_id,"accepted":false})))
}

#[brz_http_server::put(
    "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id"
)]
async fn put_command(
    #[inject(state)] state: &AppState,
    #[auth] actor: SessionUser,
    project_id: &str,
    group_id: &str,
    command_id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    let scope = command_scope(project_id, group_id, command_id)?;
    let role = access(state, project_id, actor.0.id).await?;
    let actor_id = i64::from(actor.0.id);
    let mut context = command_input(actor_id, project_id, group_id, command_id, &body)?;
    let digest = crate::hex_sha256(context.to_string().as_bytes());
    let receipt: Option<Receipt> = state
        .mysql
        .fetch_optional(RECEIPT_SQL, (scope.as_str(),))
        .await
        .map_err(crate::cloud_projects::internal_error)?;
    // A durable accepted result precedes mutable ownership/readiness checks; this never dispatches.
    if let Some(receipt) = receipt {
        return receipt.result(actor_id, command_id, Some(&digest));
    }
    if !can_execute(&role) {
        return Err(FastApiError::forbidden(
            "Project execution permission is required",
        ));
    }
    require_execution_binding(
        state,
        project_id,
        actor_id,
        &json!({"project_coordination":context}),
    )
    .await
    .map_err(group_error)?;
    context["inputDigest"] = json!(digest);
    let project = store::get(&state.mysql, "project", project_id)
        .await
        .map_err(crate::cloud_projects::internal_error)?
        .ok_or_else(not_found)?;
    if project.version != body["projectVersion"] {
        return Err(conflict("Project changed before coordination dispatch"));
    }
    let issue = issues::load(state, &project, body["issueId"].as_str().unwrap(), actor_id)
        .await
        .map_err(group_error)?;
    validate_unassigned_issue(&issue, &body)?;
    let assignment = groups::prepare_assignment(
        state,
        &project,
        issue,
        group_id,
        actor_id,
        json!({"project_coordination":context}),
    )
    .await
    .map_err(group_error)?;
    if assignment.group["version"] != body["groupVersion"] || assignment.admission.is_none() {
        return Err(conflict(
            "The project group or AI leader configuration changed",
        ));
    }
    commit_command(
        &state.mysql,
        &project,
        &assignment,
        &context,
        &scope,
        &digest,
        command_id,
    )
    .await
}

fn validate_unassigned_issue(issue: &store::Node, input: &Value) -> Result<(), FastApiError> {
    if issue.version != input["issueVersion"] {
        return Err(conflict("Issue changed before coordination dispatch"));
    }
    if issue.assignee_user_id != 0
        || issue.assignee_team_id != 0
        || !issue.assignee_agent_id.is_empty()
        || issue.metadata.0["collaboration_group"]["id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        || authority::integer(&issue.metadata.0["collaboration_group"]["id"])
            .is_some_and(|id| id != 0)
    {
        return Err(conflict(
            "This Issue already has an assignee; preserve its existing work",
        ));
    }
    Ok(())
}

async fn commit_command(
    mysql: &brz_mysql::MysqlService,
    project: &store::Node,
    assignment: &groups::GroupAssignment,
    context: &Value,
    scope: &str,
    digest: &str,
    command: &str,
) -> Result<Value, FastApiError> {
    mysql
        .with_transaction(async |tx| {
            if let std::ops::ControlFlow::Break(result) =
                fence_command_on(tx, project, assignment, context, scope, digest, command).await?
            {
                return Ok(result);
            }
            if let Err(error) = revalidate_command_on(tx, project, assignment, context).await {
                return Ok(Err(error));
            }
            admit_command_on(tx, project, assignment, scope, command).await
        })
        .await
        .map_err(|error| match error {
            brz_mysql::MysqlError::InvalidQuery { ref reason }
                if reason == "Issue changed before group assignment" =>
            {
                conflict(reason)
            }
            other => crate::cloud_projects::internal_error(other),
        })?
}

async fn fence_command_on(
    tx: &mut impl MysqlTransaction,
    project: &store::Node,
    assignment: &groups::GroupAssignment,
    context: &Value,
    scope: &str,
    digest: &str,
    command: &str,
) -> brz_mysql::MysqlResult<std::ops::ControlFlow<Result<Value, FastApiError>>> {
    let current = store::locked(tx, "project", &project.id)
        .await?
        .ok_or(brz_mysql::MysqlError::RowNotFound)?;
    let previous: Option<Receipt> = tx.fetch_optional(RECEIPT_SQL, (scope,)).await?;
    if let Some(previous) = previous {
        return Ok(std::ops::ControlFlow::Break(previous.result(
            assignment.actor,
            command,
            Some(digest),
        )));
    }
    if current.version != project.version
        || !binding_matches(
            &current.metadata.0[FIELD][context["groupId"].as_str().unwrap()],
            context,
            assignment.actor,
        )
    {
        return Ok(std::ops::ControlFlow::Break(Err(conflict(
            "Project coordination binding or project changed",
        ))));
    }
    let permission: Option<brz_mysql::MysqlRow> = tx
        .fetch_optional(
            crate::cloud_projects::project_access_statement(
                i32::try_from(assignment.actor).unwrap(),
                Some(canonical_id(&project.id).unwrap()),
                None,
            ),
            (),
        )
        .await?;
    if permission
        .map(|row| row.get_required::<i64>("anon_1_priority"))
        .transpose()?
        .is_none_or(|priority| priority > 2)
    {
        return Ok(std::ops::ControlFlow::Break(Err(FastApiError::forbidden(
            "Project execution permission is revoked",
        ))));
    }

    let group:Option<brz_mysql::MysqlRow> = tx.fetch_optional("SELECT COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.status.version')) AS SIGNED),1) AS version FROM kinds WHERE id=? AND kind='CollaborationGroup' AND is_active=true FOR UPDATE",(context["groupId"].as_str().unwrap(),)).await?;
    if group
        .map(|row| row.get_required::<i64>("version"))
        .transpose()?
        != context["groupVersion"].as_i64()
    {
        return Ok(std::ops::ControlFlow::Break(Err(conflict(
            "The collaboration group changed before coordination dispatch",
        ))));
    }
    Ok(std::ops::ControlFlow::Continue(()))
}

async fn admit_command_on(
    tx: &mut impl MysqlTransaction,
    project: &store::Node,
    assignment: &groups::GroupAssignment,
    scope: &str,
    command: &str,
) -> brz_mysql::MysqlResult<Result<Value, FastApiError>> {
    groups::apply_assignment_on(tx, project, assignment).await?;
    let plan = assignment.admission.as_ref().unwrap();
    let execution = queue::enqueue_intent_on(tx, &assignment.issue, None, scope, plan).await?;
    let payload = json!({"schema_version":2,"runtime_selection":plan.runtime_selection,"origin_context":plan.context,"dispatch_request":{"kind":"collaboration_group"}});
    tx.execute(
        "UPDATE loop_item_executions SET execution_payload=? WHERE id=?",
        (payload.to_string(), execution.id),
    )
    .await?;
    Ok(Ok(
        json!({"commandId":command,"accepted":true,"execution":{"id":execution.id,"issueId":assignment.issue.id,"status":execution.status}}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_inputs_do_not_trust_client_actor_and_require_current_versions() {
        let body = json!({"userId":99,"deviceId":"device","generation":"generation","issueId":"ISSUE-1","projectVersion":1,"groupVersion":1,"issueVersion":1});
        let input = command_input(7, "1001", "101", "command", &body).unwrap();
        assert_eq!(input["userId"], 7);
        for field in [
            "projectVersion",
            "groupVersion",
            "issueVersion",
            "deviceId",
            "generation",
            "issueId",
        ] {
            let mut missing = body.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(command_input(7, "1001", "101", "command", &missing).is_err());
        }
        for command in ["", "../command", "command:other", "command/other"] {
            assert!(command_scope("1001", "101", command).is_err());
        }
    }

    #[test]
    fn immutable_receipts_cannot_change_actor_or_command_input() {
        let receipt = Receipt {
            id: 9,
            assigner_user_id: 7,
            loop_item_id: "ISSUE-1".into(),
            status: "cancel_requested".into(),
            execution_payload:
                json!({"origin_context":{"project_coordination":{"inputDigest":"digest"}}})
                    .to_string(),
        };
        assert_eq!(
            receipt.result(7, "command", Some("digest")).unwrap()["execution"]["status"],
            "cancel_requested"
        );
        assert_eq!(
            receipt
                .result(8, "command", Some("digest"))
                .unwrap_err()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            receipt
                .result(7, "command", Some("changed"))
                .unwrap_err()
                .status(),
            StatusCode::CONFLICT
        );
    }

    #[test]
    fn generation_matching_rejects_stale_device_and_member() {
        let binding =
            json!({"enabled":true,"userId":7,"deviceId":"device","generation":"generation"});
        let scope = json!({"userId":7,"deviceId":"device","generation":"generation"});
        assert!(binding_matches(&binding, &scope, 7));
        for (key, value) in [
            ("deviceId", json!("other")),
            ("generation", json!("old")),
            ("userId", json!(8)),
        ] {
            let mut changed = scope.clone();
            changed[key] = value;
            assert!(!binding_matches(&binding, &changed, 7));
        }
        let mut stopped = binding.clone();
        stopped["enabled"] = json!(false);
        assert!(!binding_matches(&stopped, &scope, 7));
    }
}

#[cfg(test)]
#[path = "project_coordination_dispatch_mysql_tests.rs"]
mod mysql_tests;
#[cfg(test)]
pub(super) use mysql_tests::verify_dispatch_transactions;

async fn revalidate_command_on(
    tx: &mut impl MysqlTransaction,
    project: &store::Node,
    assignment: &groups::GroupAssignment,
    context: &Value,
) -> Result<(), FastApiError> {
    let mut query = &mut *tx;
    groups::authorize_snapshot_on(&mut query, &project.id, &assignment.group, assignment.actor)
        .await
        .map_err(group_error)?;
    require_execution_binding_on(
        &mut query,
        &project.id,
        assignment.actor,
        &json!({"project_coordination":context}),
    )
    .await
    .map_err(group_error)?;
    let mut plan = assignment.admission.as_ref().unwrap().clone();
    queue::prepare_on(&mut query, &assignment.issue, &mut plan)
        .await
        .map_err(group_error)?;
    if plan.device_id != assignment.admission.as_ref().unwrap().device_id {
        return Err(conflict(
            "The execution device identity changed before dispatch",
        ));
    }
    Ok(())
}
