//! Kind implementation reference validation before seeding writes.
use anyhow::{Result, ensure};
use serde_json::Value;

use super::{repository, tasks::TaskResources};
use crate::state::AppState;

pub(super) fn reference(resource: &Value, field: &str) -> Result<(String, String)> {
    let value = resource
        .get("spec")
        .and_then(|s| s.get(field))
        .ok_or_else(|| anyhow::anyhow!("missing resource reference"))?;
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing reference name"))?;
    let namespace = value
        .get("namespace")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    Ok((namespace.into(), name.into()))
}

pub(super) async fn validate(
    state: &AppState,
    tasks: &dyn TaskResources,
    user_id: i64,
    kind: &str,
    namespace: &str,
    name: &str,
    resource: &Value,
) -> Result<()> {
    super::schema::validate(kind, resource)?;
    match kind {
        "Ghost" => {
            if let Some(skills) = resource
                .pointer("/spec/skills")
                .and_then(Value::as_array)
                .filter(|s| !s.is_empty())
            {
                let names: Vec<String> = skills
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                let placeholders = vec!["?"; names.len()].join(", ");
                let sql = format!(
                    "SELECT kinds.name FROM kinds WHERE (kinds.user_id = ? OR kinds.user_id = 0) AND kinds.kind = 'Skill' AND kinds.name IN ({placeholders}) AND kinds.namespace = 'default' AND kinds.is_active = true"
                );
                let mut args = vec![crate::sql_support::StatementArg::Int(user_id)];
                args.extend(
                    names
                        .iter()
                        .cloned()
                        .map(crate::sql_support::StatementArg::Str),
                );
                let existing: Vec<String> = state.mysql.fetch_all(sql, args).await?;
                ensure!(
                    names.iter().all(|s| existing.contains(s)),
                    "missing skill reference"
                );
            }
        }
        "Bot" => {
            let ghost = reference(resource, "ghostRef")?;
            ensure!(
                repository::owned_kind(&state.mysql, user_id, "Ghost", &ghost.0, &ghost.1)
                    .await?
                    .is_some(),
                "missing ghost reference"
            );
            let shell = reference(resource, "shellRef")?;
            use crate::v1_resources::shell_resolution as shells;
            let mut found = shells::personal_shell(&state.mysql, &shell.1, user_id, &shell.0)
                .await?
                .is_some();
            if !found {
                found = shells::referenced_shell(&state.mysql, &shell.1, user_id, &shell.0)
                    .await?
                    .is_some();
            }
            if !found && shell.0 != "default" {
                let groups = crate::permissions::user_groups(
                    &state.mysql,
                    &state.entity_resolvers,
                    state.redis.as_ref(),
                    user_id,
                )
                .await?;
                if groups.contains(&shell.0) {
                    found = shells::group_shell(&state.mysql, &shell.1, &shell.0)
                        .await?
                        .is_some();
                }
            }
            if !found {
                found = shells::public_shell(&state.mysql, &shell.1)
                    .await?
                    .is_some();
            }
            ensure!(found, "missing shell reference");
        }
        "Team" => {
            if let Some(members) = resource.pointer("/spec/members").and_then(Value::as_array) {
                for member in members {
                    let bot = member
                        .get("botRef")
                        .ok_or_else(|| anyhow::anyhow!("missing bot reference"))?;
                    let name = bot
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("missing bot name"))?;
                    let namespace = bot
                        .get("namespace")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("default");
                    ensure!(
                        repository::owned_kind(&state.mysql, user_id, "Bot", namespace, name)
                            .await?
                            .is_some(),
                        "missing bot reference"
                    );
                }
            }
        }
        "Task" => {
            let team = reference(resource, "teamRef")?;
            ensure!(
                repository::owned_kind(&state.mysql, user_id, "Team", &team.0, &team.1)
                    .await?
                    .is_some(),
                "missing team reference"
            );
            let workspace = reference(resource, "workspaceRef")?;
            ensure!(
                state
                    .task_store
                    .get_workspace_by_ref(user_id, &workspace.1, &workspace.0)
                    .await?
                    .is_some(),
                "missing workspace reference"
            );
            if let Some(existing) = tasks.owned_task(user_id, namespace, name).await? {
                super::schema::validate("Task", &existing.json.0)?;
                if let Some(status) = existing.json.0.get("status").filter(|s| !s.is_null()) {
                    ensure!(
                        status
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("PENDING")
                            == "COMPLETED",
                        "task cannot be modified in current state"
                    );
                }
            }
        }
        "Model" => {
            let stored = repository::get(state, tasks, user_id, kind, namespace, name).await?;
            validate_dimension(
                resource.get("spec").unwrap_or(&Value::Null),
                stored.as_ref().and_then(|r| r.json.0.get("spec")),
            )?;
        }
        _ => (),
    }
    Ok(())
}

fn dimension(spec: &Value) -> Option<u64> {
    spec.pointer("/embeddingConfig/dimensions")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
}

fn category(spec: &Value) -> String {
    spec.get("modelType")
        .and_then(Value::as_str)
        .or_else(|| {
            spec.pointer("/modelConfig/modelType")
                .and_then(Value::as_str)
        })
        .unwrap_or("llm")
        .trim()
        .to_lowercase()
}

fn validate_dimension(spec: &Value, stored: Option<&Value>) -> Result<()> {
    let old = stored.and_then(dimension);
    if category(spec) == "embedding"
        || old.is_some()
        || stored.is_some_and(|s| category(s) == "embedding")
    {
        let declared = dimension(spec)
            .ok_or_else(|| anyhow::anyhow!("embedding dimension must be positive"))?;
        ensure!(
            old.is_none_or(|old| old == declared),
            "embedding dimension is immutable"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn existing_embedding_dimension_cannot_be_changed_or_dropped() {
        let stored = json!({"modelType":"embedding", "embeddingConfig":{"dimensions":768}});
        assert!(validate_dimension(&stored, Some(&stored)).is_ok());
        let changed = json!({"modelType":"llm", "embeddingConfig":{"dimensions":1024}});
        assert!(validate_dimension(&changed, Some(&stored)).is_err());
        assert!(validate_dimension(&json!({"modelType":"llm"}), Some(&stored)).is_err());
        assert!(
            validate_dimension(&json!({"modelConfig":{"modelType":" embedding "}}), None).is_err()
        );
        assert!(
            validate_dimension(
                &json!({"modelType":"embedding", "embeddingConfig":{"dimensions":true}}),
                None
            )
            .is_err()
        );
    }
}
