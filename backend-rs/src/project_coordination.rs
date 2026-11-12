//! Explicit project coordination ownership; a binding never grants execution rights.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

use crate::background_jobs::project::{groups, notifications, store};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

const FIELD: &str = "projectCoordination";
const CONFLICT: &str = "project coordination conflict";

#[path = "project_coordination_dispatch.rs"]
mod dispatch;

pub(crate) fn binding_matches(binding: &Value, context: &Value, actor: i64) -> bool {
    binding["enabled"] == true
        && binding["userId"] == actor
        && context["userId"] == actor
        && ["generation", "deviceId"].iter().all(|key| {
            context[*key]
                .as_str()
                .is_some_and(|value| !value.is_empty())
                && binding[*key] == context[*key]
        })
}

pub(crate) async fn require_execution_binding(
    state: &AppState,
    project_id: &str,
    actor: i64,
    origin: &Value,
) -> anyhow::Result<()> {
    require_execution_binding_on(&mut &state.mysql, project_id, actor, origin).await
}

pub(crate) async fn require_execution_binding_on(
    query: &mut impl crate::plugins_marketplace::query::PluginQuery,
    project_id: &str,
    actor: i64,
    origin: &Value,
) -> anyhow::Result<()> {
    use anyhow::{Context, bail};
    let Some(context) = origin.get("project_coordination") else {
        return Ok(());
    };
    if context["projectId"] != project_id {
        bail!("Project coordination context is invalid");
    }
    let group = context["groupId"]
        .as_str()
        .context("Project coordination group is missing")?;
    let project = store::get_on(query, "project", project_id)
        .await?
        .context("Project is unavailable")?;
    if project.status != "active"
        || !binding_matches(&project.metadata.0[FIELD][group], context, actor)
    {
        bail!("Project coordination binding is revoked or superseded");
    }
    let device = crate::device_identity::resolve_owned_device_alias_on(
        query,
        actor,
        context["deviceId"].as_str().unwrap(),
    )
    .await?
    .and_then(|device| crate::device_identity::identity_from_device(&device))
    .context("Project coordination device is unavailable")?;
    if device.runtime_device_id != context["deviceId"] {
        bail!("Project coordination device identity changed");
    }
    Ok(())
}

fn can_execute(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer" | "Developer")
}

fn can_administer(role: &str) -> bool {
    matches!(role, "Owner" | "Maintainer")
}

fn group_error(error: anyhow::Error) -> FastApiError {
    match error.downcast::<brz_mysql::MysqlError>() {
        Ok(error) => crate::cloud_projects::internal_error(error),
        Err(_) => FastApiError::forbidden(
            "The collaboration group or its resources are unavailable to this member",
        ),
    }
}

fn conflict(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::CONFLICT, message)
}

fn not_found() -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        "Project coordination context not found",
    )
}

fn canonical_id(value: &str) -> Result<i64, FastApiError> {
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && id.to_string() == value)
        .ok_or_else(not_found)
}

async fn access(state: &AppState, project: &str, actor: i32) -> Result<String, FastApiError> {
    let id = canonical_id(project)?;
    crate::cloud_projects::authorized_project(&state.mysql, id, actor)
        .await
        .map_err(crate::cloud_projects::internal_error)?
        .map(|(_, role)| role.to_owned())
        .ok_or_else(not_found)
}

fn transition(
    previous: &Value,
    actor: i64,
    device: &str,
    can_stop_others: bool,
    input: &Value,
) -> Result<Value, &'static str> {
    let enabled = input["enabled"]
        .as_bool()
        .ok_or("An explicit enabled state is required")?;
    if input.get("expectedGeneration") != Some(&previous["generation"]) {
        return Err(CONFLICT);
    }
    if !enabled && previous["enabled"] == true && previous["userId"] != actor && !can_stop_others {
        return Err("Only the enabling member or a project administrator can stop this binding");
    }
    if enabled && previous["enabled"] == true {
        if previous["userId"] == actor && previous["deviceId"] == device {
            return Ok(previous.clone());
        }
        if input["takeover"] != true {
            return Err("Explicit takeover is required for another member or device");
        }
    }
    if !enabled && (previous.is_null() || previous["enabled"] == false) {
        return Ok(previous.clone());
    }
    let at = Utc::now().to_rfc3339();
    Ok(
        json!({"enabled":enabled,"userId":if enabled {json!(actor)} else {previous["userId"].clone()},"deviceId":if enabled {json!(device)} else {previous["deviceId"].clone()},"generation":notifications::uuid(),"sourceCutoff":if enabled && previous["enabled"]==true {previous["sourceCutoff"].clone()} else {json!(at)},"updatedBy":actor,"updatedAt":at}),
    )
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id")]
async fn get_project_coordinator_binding(
    #[inject(state)] state: &AppState,
    #[auth] actor: SessionUser,
    project_id: &str,
    group_id: &str,
) -> Result<Value, FastApiError> {
    canonical_id(group_id)?;
    let role = access(state, project_id, actor.0.id).await?;
    let project = store::get(&state.mysql, "project", project_id)
        .await
        .map_err(crate::cloud_projects::internal_error)?
        .ok_or_else(not_found)?;
    let binding = &project.metadata.0[FIELD][group_id];
    Ok(
        json!({"binding":binding,"canEnable":can_execute(&role),"canStop":can_execute(&role)&&(can_administer(&role)||binding["userId"]==i64::from(actor.0.id))}),
    )
}

#[brz_http_server::put("/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id")]
async fn set_project_coordinator_binding(
    #[inject(state)] state: &AppState,
    #[auth] actor: SessionUser,
    project_id: &str,
    group_id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    canonical_id(group_id)?;
    let role = access(state, project_id, actor.0.id).await?;
    if !can_execute(&role) {
        return Err(FastApiError::forbidden(
            "Project execution permission is required",
        ));
    }
    let enabled = body["enabled"].as_bool().ok_or_else(|| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "An explicit enabled state is required",
        )
    })?;
    let device = if enabled {
        let submitted = body["deviceId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                FastApiError::detail(StatusCode::BAD_REQUEST, "A running device is required")
            })?;
        let group = groups::authorize(state, project_id, group_id, i64::from(actor.0.id))
            .await
            .map_err(group_error)?;
        if group["leader"]["kind"] != "agent" {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "Configure an AI group leader before enabling automatic coordination",
            ));
        }
        crate::device_identity::resolve_runtime_route_identity(
            &state.mysql,
            i64::from(actor.0.id),
            submitted,
        )
        .await
        .map_err(crate::cloud_projects::internal_error)?
        .ok_or_else(|| {
            FastApiError::forbidden("The coordination device is not owned by this member")
        })?
        .runtime_device_id
    } else {
        String::new()
    };
    persist_binding(
        &state.mysql,
        actor.0.id,
        project_id,
        group_id,
        &device,
        &body,
    )
    .await
}

async fn persist_binding(
    mysql: &brz_mysql::MysqlService,
    actor: i32,
    project_id: &str,
    group_id: &str,
    device: &str,
    input: &Value,
) -> Result<Value, FastApiError> {
    let project_numeric = canonical_id(project_id)?;
    mysql
        .with_transaction(async |tx| {
            apply_binding(
                tx,
                actor,
                project_id,
                project_numeric,
                group_id,
                device,
                input,
            )
            .await
        })
        .await
        .map_err(crate::cloud_projects::internal_error)?
}

async fn apply_binding(
    tx: &mut impl MysqlTransaction,
    actor: i32,
    project_id: &str,
    project_numeric: i64,
    group_id: &str,
    device: &str,
    input: &Value,
) -> brz_mysql::MysqlResult<Result<Value, FastApiError>> {
    let project: Option<store::Node> = tx.fetch_optional(
        format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='project' AND {} FOR UPDATE", store::COLUMNS, store::LIVE),
        (project_id,),
    ).await?;
    let Some(mut project) = project else {
        return Ok(Err(not_found()));
    };
    let permission: Option<brz_mysql::MysqlRow> = tx
        .fetch_optional(
            crate::cloud_projects::project_access_statement(actor, Some(project_numeric), None),
            (),
        )
        .await?;
    let priority = permission
        .map(|row| row.get_required::<i64>("anon_1_priority"))
        .transpose()?
        .unwrap_or(99);
    if priority > 2 {
        return Ok(Err(FastApiError::forbidden(
            "Project execution permission is revoked",
        )));
    }
    let previous = project.metadata.0[FIELD][group_id].clone();
    let binding = match transition(&previous, i64::from(actor), device, priority <= 1, input) {
        Ok(binding) => binding,
        Err(message) => {
            return Ok(Err(if message.starts_with("Only ") {
                FastApiError::forbidden(message)
            } else {
                conflict(message)
            }));
        }
    };
    if binding != previous {
        if !project.metadata.0[FIELD].is_object() {
            project.metadata.0[FIELD] = json!({});
        }
        project.metadata.0[FIELD][group_id] = binding.clone();
        tx.execute(
            "UPDATE loop_items SET metadata=?,version=version+1,updated_by_user_id=?,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='project'",
            (Json(project.metadata.0), actor, project_id),
        ).await?;
    }
    Ok(Ok(
        json!({"binding":binding,"canEnable":true,"canStop":priority<=1||binding["userId"]==i64::from(actor)}),
    ))
}

#[derive(FromMysqlRow)]
struct OwnedProject {
    id: String,
    bindings: Json<Value>,
}

fn owned_bindings_statement(actor: i32) -> String {
    let visible = crate::cloud_projects::project_access_statement(actor, None, None);
    format!(
        "SELECT visible.loop_items_id AS id,JSON_EXTRACT(visible.loop_items_metadata,'$.projectCoordination') AS bindings FROM ({visible}) AS visible WHERE visible.anon_1_priority<=2 AND JSON_CONTAINS(JSON_EXTRACT(visible.loop_items_metadata,'$.projectCoordination.*.userId'),CAST(? AS JSON))=1"
    )
}

#[brz_http_server::get("/api/v1/me/project-coordinator-bindings")]
async fn list_own_project_coordinator_bindings(
    #[inject(state)] state: &AppState,
    #[auth] actor: SessionUser,
) -> Result<Value, FastApiError> {
    let rows: Vec<OwnedProject> = state
        .mysql
        .fetch_all(
            owned_bindings_statement(actor.0.id),
            (actor.0.id.to_string(),),
        )
        .await
        .map_err(crate::cloud_projects::internal_error)?;
    let mut contexts = Vec::new();
    for row in rows {
        for (group, binding) in row.bindings.0.as_object().into_iter().flatten() {
            if binding["userId"] != i64::from(actor.0.id) || binding["enabled"] != true {
                continue;
            }
            contexts.push(json!({"projectId":row.id,"projectStore":"cloud","groupId":group,"binding":binding}));
        }
    }
    Ok(json!({"contexts":contexts}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_apis_are_registered_and_selected_for_rust() {
        let config = crate::load_routes_config(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"),
        )
        .unwrap();
        let table = crate::RouteTable::compile(config).unwrap();
        let routes: Vec<_> = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .collect();
        for (path, method, bit) in [
            (
                "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id/authorization",
                http::Method::GET,
                2,
            ),
            (
                "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id",
                http::Method::GET,
                2,
            ),
            (
                "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id",
                http::Method::PUT,
                64,
            ),
            (
                "/api/v1/me/project-coordinator-bindings",
                http::Method::GET,
                2,
            ),
            (
                "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id",
                http::Method::GET,
                2,
            ),
            (
                "/api/v1/cloud-projects/:project_id/coordinator-bindings/:group_id/commands/:command_id",
                http::Method::PUT,
                64,
            ),
        ] {
            assert!(
                table.matches(
                    &method,
                    &path
                        .replace(":project_id", "1001")
                        .replace(":group_id", "101")
                        .replace(":command_id", "command")
                )
            );
            assert_eq!(
                routes
                    .iter()
                    .filter(|route| route.path == path && route.methods & bit != 0)
                    .count(),
                1
            );
        }
        assert!(!table.matches(
            &http::Method::POST,
            "/api/v1/cloud-projects/1001/coordinator-bindings/101"
        ));
    }

    #[test]
    fn binding_permissions_preserve_existing_execution_roles() {
        for role in ["Owner", "Maintainer", "Developer"] {
            assert!(can_execute(role));
        }
        for role in ["Reporter", "Viewer", "RestrictedAnalyst", ""] {
            assert!(!can_execute(role));
            assert!(!can_administer(role));
        }
        assert!(can_administer("Owner"));
        assert!(can_administer("Maintainer"));
        assert!(!can_administer("Developer"));
    }

    #[test]
    fn actor_and_generation_fence_takeover_and_disable() {
        let first = transition(
            &Value::Null,
            7,
            "device-a",
            false,
            &json!({"enabled":true,"expectedGeneration":null}),
        )
        .unwrap();
        assert!(
            transition(
                &first,
                8,
                "device-b",
                false,
                &json!({"enabled":true,"expectedGeneration":null,"takeover":true})
            )
            .is_err()
        );
        assert!(
            transition(
                &first,
                8,
                "device-b",
                false,
                &json!({"enabled":true,"expectedGeneration":first["generation"]})
            )
            .is_err()
        );
        let next = transition(
            &first,
            8,
            "device-b",
            false,
            &json!({"enabled":true,"expectedGeneration":first["generation"],"takeover":true}),
        )
        .unwrap();
        assert_ne!(next["generation"], first["generation"]);
        assert_eq!(next["updatedBy"], 8);
        assert!(
            transition(
                &next,
                7,
                "device-a",
                false,
                &json!({"enabled":false,"expectedGeneration":next["generation"]})
            )
            .is_err()
        );
        assert_eq!(
            transition(
                &next,
                1,
                "device-a",
                true,
                &json!({"enabled":false,"expectedGeneration":next["generation"]})
            )
            .unwrap()["updatedBy"],
            1
        );
    }
}

#[cfg(test)]
#[path = "project_coordination_mysql_tests.rs"]
mod mysql_tests;
