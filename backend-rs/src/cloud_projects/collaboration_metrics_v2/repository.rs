//! Public, attributed metric receipts reuse the existing Issue activity store.
use super::*;
use crate::background_jobs::project::store;
use crate::loop_tasks::loop_repository::visible_item_filter_sql;
use crate::{http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState};
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};

#[derive(FromMysqlRow)]
struct Row {
    metadata: Json<Value>,
}

#[derive(FromMysqlRow)]
struct ScopedRow {
    id: String,
    parent_id: String,
    metadata: Json<Value>,
    is_deleted: i32,
}

fn error(status: StatusCode, detail: &str) -> FastApiError {
    FastApiError::detail(status, detail)
}

pub(in crate::cloud_projects::collaboration_metrics) struct Facts {
    pub records: Vec<Evidence>,
    pub unavailable: Vec<Evidence>,
}

pub(in crate::cloud_projects::collaboration_metrics) async fn load(
    query: &mut impl crate::plugins_marketplace::query::PluginQuery,
    project: &str,
    visibility: &str,
    window: Window,
) -> Result<Facts, FastApiError> {
    let rows: Vec<ScopedRow> = query.fetch_all(format!(
        "SELECT receipt.id,receipt.parent_id,receipt.metadata, \
         CASE WHEN receipt.deleted_at IS NULL OR receipt.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01') THEN 0 ELSE 1 END AS is_deleted \
         FROM loop_items receipt WHERE receipt.cloud_project_id=? \
         AND receipt.resource_type='comment' AND JSON_UNQUOTE(JSON_EXTRACT(receipt.metadata,'$.event_type'))='metric_evidence' \
         AND (receipt.parent_id=? OR receipt.parent_id IN (SELECT id FROM loop_items \
         WHERE cloud_project_id=? AND resource_type='task' AND (parent_id IS NULL OR parent_id='') \
         AND {} {visibility}))", super::super::LIVE),
        (project,project,project),
    ).await.map_err(super::super::internal)?;
    let mut selected =
        std::collections::BTreeMap::<(String, String), (Evidence, bool, String)>::new();
    for row in rows {
        let Some(at) = row.metadata.0["recorded_at"]
            .as_str()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        else {
            continue;
        };
        if at >= window.as_of {
            continue;
        }
        let fact: Evidence = serde_json::from_value(row.metadata.0["record"].clone())
            .map_err(super::super::internal)?;
        let correct_scope = if matches!(fact.fact, Fact::Capacity { .. }) {
            fact.issue_id.is_empty() && row.parent_id == project
        } else {
            fact.issue_id == row.parent_id && row.parent_id != project
        };
        if !correct_scope {
            return Err(error(
                StatusCode::CONFLICT,
                "Metric receipt scope is invalid",
            ));
        }
        let key = (fact.issue_id.clone(), fact.key.clone());
        if selected
            .get(&key)
            .is_none_or(|(old, ..)| old.revision < fact.revision)
        {
            selected.insert(key, (fact, row.is_deleted != 0, row.id));
        }
    }
    let references: BTreeSet<_> = selected
        .values()
        .filter(|(_, deleted, _)| !*deleted)
        .flat_map(|(fact, ..)| fact.references.iter().cloned())
        .collect();
    #[derive(FromMysqlRow)]
    struct Source {
        id: String,
        parent_id: String,
        loop_item_id: String,
    }
    let sources: Vec<Source> = if references.is_empty() {
        Vec::new()
    } else {
        let placeholders = vec!["?"; references.len()].join(",");
        let arguments: Vec<_> = references
            .into_iter()
            .map(crate::sql_support::StatementArg::Str)
            .collect();
        query.fetch_all(format!("SELECT id,COALESCE(parent_id,'') AS parent_id,COALESCE(loop_item_id,'') AS loop_item_id \
            FROM loop_items WHERE id IN ({placeholders}) AND {}",super::super::LIVE),arguments)
            .await.map_err(super::super::internal)?
    };
    let sources: std::collections::BTreeMap<_, _> = sources
        .into_iter()
        .map(|row| (row.id.clone(), row))
        .collect();
    let mut facts = Vec::new();
    let mut unavailable = Vec::new();
    for (mut fact, deleted, receipt_id) in selected.into_values() {
        if deleted {
            continue;
        }
        let parent = if fact.issue_id.is_empty() {
            project
        } else {
            fact.issue_id.as_str()
        };
        let available = fact.references.iter().all(|reference| {
            parent == project && reference == project
                || sources.get(reference).is_some_and(|source| {
                    source.id == parent
                        || source.parent_id == parent
                        || source.loop_item_id == parent
                })
        });
        if available {
            fact.references.push(receipt_id);
            facts.push(fact);
        } else {
            unavailable.push(fact);
        }
    }
    facts.extend(super::deliveries::load(query, project, visibility, window).await?);
    Ok(Facts {
        records: facts,
        unavailable,
    })
}

fn valid(evidence: &Evidence, now: DateTime<Utc>) -> bool {
    if evidence.key.trim().is_empty()
        || evidence.key.len() > 255
        || evidence.revision == 0
        || evidence.references.is_empty()
        || evidence
            .references
            .iter()
            .any(|id| id.is_empty() || id.len() > 64)
    {
        return false;
    }
    match &evidence.fact {
        Fact::Contribution {
            user_id,
            effective_at,
            ..
        } => user_id.is_none_or(|id| id > 0) && *effective_at <= now,
        Fact::Activity {
            agent_id,
            run_id,
            owner_user_id,
            started_at,
            ended_at,
            ..
        } => {
            !agent_id.is_empty()
                && !run_id.is_empty()
                && run_id.len() <= 255
                && agent_id.len() <= 255
                && owner_user_id.is_none_or(|id| id > 0)
                && *started_at <= now
                && ended_at.is_none_or(|end| end >= *started_at && end <= now)
        }
        Fact::Unit {
            unit_id,
            content_version,
            accepted_version,
            accepted_at,
            contributors,
            ..
        } => {
            !unit_id.is_empty()
                && evidence.key == *unit_id
                && !content_version.is_empty()
                && accepted_version.is_some() == accepted_at.is_some()
                && accepted_at.is_none_or(|at| at <= now)
                && contributors.iter().all(|id| *id > 0)
        }
        Fact::Handoff {
            ready_at,
            started_at,
            owner_user_id,
            ..
        } => {
            *ready_at <= now
                && started_at.is_none_or(|at| at >= *ready_at && at <= now)
                && owner_user_id.is_none_or(|id| id > 0)
        }
        Fact::Capacity {
            user_id,
            calendar_id,
            available_seconds,
            member_from,
            member_until,
        } => {
            *user_id > 0
                && !calendar_id.is_empty()
                && available_seconds.is_finite()
                && *available_seconds >= 0.0
                && *member_until > *member_from
                && *available_seconds <= seconds(*member_from, *member_until)
        }
    }
}

#[derive(FromMysqlRow)]
struct Permission {
    #[mysql(rename = "anon_3_priority")]
    priority: i64,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<Value>>,
}

pub(in crate::cloud_projects::collaboration_metrics) async fn append(
    tx: &mut impl MysqlTransaction,
    project: &str,
    actor: i32,
    record: &Evidence,
) -> brz_mysql::MysqlResult<Result<Value, FastApiError>> {
    let project_id: i64 = project.parse().expect("validated project identity");
    let access: Option<Permission> = tx
        .fetch_optional(
            crate::cloud_projects::project_permission_statement(actor, project_id),
            (),
        )
        .await?;
    let Some(access) = access.filter(|access| access.priority <= 2) else {
        return Ok(Err(error(
            StatusCode::FORBIDDEN,
            "Metric receipts require current Developer access",
        )));
    };
    let metadata = access
        .metadata
        .map(|value| value.0)
        .unwrap_or_else(|| json!({}));
    if metadata["task_provider"].as_str().unwrap_or("local") != "local" {
        return Ok(Err(error(
            StatusCode::CONFLICT,
            "Metric receipts require authoritative project Issues",
        )));
    }
    let parent = if matches!(record.fact, Fact::Capacity { .. }) {
        project
    } else {
        record.issue_id.as_str()
    };
    if parent == project && !record.issue_id.is_empty()
        || parent != project && record.issue_id.is_empty()
    {
        return Ok(Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Capacity is project-scoped; other facts require an Issue",
        )));
    }
    let Some(node) = store::locked(
        tx,
        if parent == project { "project" } else { "task" },
        parent,
    )
    .await?
    else {
        return Ok(Err(error(
            StatusCode::NOT_FOUND,
            "Metric evidence context not found",
        )));
    };
    if parent != project {
        let visibility = if access.priority <= 1 {
            String::new()
        } else {
            visible_item_filter_sql(
                actor,
                metadata["default_issue_security"]
                    .as_str()
                    .unwrap_or("open"),
            )
        };
        let visible: Option<(String,)> = tx.fetch_optional(format!(
            "SELECT id FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='task' \
             AND (parent_id IS NULL OR parent_id='') AND {} {visibility} FOR UPDATE",super::super::LIVE),
            (parent,project),
        ).await?;
        if visible.is_none() || node.cloud_project_id != project {
            return Ok(Err(error(
                StatusCode::NOT_FOUND,
                "Metric evidence context not found",
            )));
        }
    }
    for reference in &record.references {
        if reference == project && parent == project {
            continue;
        }
        let found: Option<(String,)> = tx
            .fetch_optional(
                format!(
                    "SELECT id FROM loop_items WHERE id=? \
             AND (id=? OR parent_id=? OR loop_item_id=?) AND {}",
                    super::super::LIVE
                ),
                (reference.as_str(), parent, parent, parent),
            )
            .await?;
        if found.is_none() {
            return Ok(Err(error(
                StatusCode::NOT_FOUND,
                "Metric source reference is unavailable",
            )));
        }
    }
    let old: Vec<Row> = tx.fetch_all(
        "SELECT metadata FROM loop_items WHERE cloud_project_id=? AND parent_id=? AND resource_type='comment' \
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.event_type'))='metric_evidence' \
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.record.key'))=? ORDER BY created_at,id FOR UPDATE",
        (project,parent,record.key.as_str()),
    ).await?;
    let latest = old
        .iter()
        .max_by_key(|row| row.metadata.0["record"]["revision"].as_u64().unwrap_or(0));
    if let Some(old) = latest {
        let previous: Evidence = match serde_json::from_value(old.metadata.0["record"].clone()) {
            Ok(record) => record,
            Err(_) => {
                return Ok(Err(error(
                    StatusCode::CONFLICT,
                    "Stored metric receipt is invalid",
                )));
            }
        };
        if old.metadata.0["reported_by_user_id"] != actor && access.priority > 1 {
            return Ok(Err(error(
                StatusCode::FORBIDDEN,
                "Only the reporting member or a project administrator can revise a receipt",
            )));
        }
        if previous == *record {
            return Ok(Ok(old.metadata.0.clone()));
        }
        if record.revision != previous.revision + 1 || !same_identity(&record.fact, &previous.fact)
        {
            return Ok(Err(error(
                StatusCode::CONFLICT,
                "Metric receipt revision or kind changed",
            )));
        }
    } else if record.revision != 1 {
        return Ok(Err(error(
            StatusCode::CONFLICT,
            "The first metric receipt revision must be one",
        )));
    }
    let receipt_id = store::id();
    let value = json!({"event_type":"metric_evidence","receipt_id":receipt_id,"definition_version":"collab-v2",
        "reported_by_user_id":actor,"recorded_at":Utc::now(),"record":record});
    let required = crate::loop_node_storage::required_columns(tx).await?;
    let sql = crate::loop_node_storage::insert_sql(
        &[
            "id",
            "resource_type",
            "project_space",
            "cloud_project_id",
            "parent_id",
            "loop_item_id",
            "description",
            "status",
            "metadata",
            "created_by_user_id",
            "version",
            "created_at",
            "updated_at",
        ],
        &[
            "?",
            "'comment'",
            "'default'",
            "?",
            "?",
            "?",
            "'collab-v2 metric evidence'",
            "'active'",
            "?",
            "?",
            "1",
            "UTC_TIMESTAMP(6)",
            "UTC_TIMESTAMP(6)",
        ],
        &required,
    );
    tx.execute(
        sql,
        (
            receipt_id,
            project,
            parent,
            parent,
            Json(value.clone()),
            actor,
        ),
    )
    .await?;
    Ok(Ok(value))
}

fn same_identity(next: &Fact, previous: &Fact) -> bool {
    match (next, previous) {
        (
            Fact::Activity {
                agent_id: a,
                owner_user_id: b,
                started_at: c,
                run_id: d,
                ..
            },
            Fact::Activity {
                agent_id: x,
                owner_user_id: y,
                started_at: z,
                run_id: w,
                ..
            },
        ) => (a, b, c, d) == (x, y, z, w),
        (Fact::Unit { unit_id: a, .. }, Fact::Unit { unit_id: b, .. }) => a == b,
        (
            Fact::Handoff {
                ready_at: a,
                owner_user_id: b,
                ..
            },
            Fact::Handoff {
                ready_at: x,
                owner_user_id: y,
                ..
            },
        ) => (a, b) == (x, y),
        (
            Fact::Capacity {
                user_id: a,
                calendar_id: b,
                member_from: c,
                member_until: d,
                ..
            },
            Fact::Capacity {
                user_id: w,
                calendar_id: x,
                member_from: y,
                member_until: z,
                ..
            },
        ) => (a, b, c, d) == (w, x, y, z),
        (
            Fact::Contribution {
                user_id: a,
                basis: b,
                effective_at: c,
                ..
            },
            Fact::Contribution {
                user_id: x,
                basis: y,
                effective_at: z,
                ..
            },
        ) => (a, b, c) == (x, y, z),
        _ => false,
    }
}

#[brz_http_server::post("/api/v1/cloud-projects/:project_id/collaboration-metrics/evidence")]
async fn record_evidence(
    #[inject(state)] state: &AppState,
    project_id: &str,
    #[auth] user: FlexibleUser,
    record: Evidence,
) -> Result<Value, FastApiError> {
    crate::cloud_projects::parse_project_id(project_id)?;
    if !valid(&record, Utc::now()) {
        return Err(error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid metric receipt",
        ));
    }
    state
        .mysql
        .with_transaction(async |tx| append(tx, project_id, user.id, &record).await)
        .await
        .map_err(super::super::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_rejects_missing_provenance_negative_capacity_and_inverted_activity() {
        let now = Utc::now();
        let mut record = Evidence {
            key: "activity".into(),
            revision: 1,
            issue_id: "issue".into(),
            references: vec!["issue".into()],
            fact: Fact::Activity {
                agent_id: "agent".into(),
                run_id: "run".into(),
                owner_user_id: Some(7),
                started_at: now,
                ended_at: None,
                state: ActivityState::Active,
                outcome: RunOutcome::Running,
            },
        };
        assert!(valid(&record, now));
        record.references.clear();
        assert!(!valid(&record, now));
        record.references.push("issue".into());
        if let Fact::Activity { ended_at, .. } = &mut record.fact {
            *ended_at = Some(now - Duration::seconds(1));
        }
        assert!(!valid(&record, now));
        record.fact = Fact::Capacity {
            user_id: 7,
            calendar_id: "declared".into(),
            available_seconds: -1.0,
            member_from: now,
            member_until: now + Duration::hours(1),
        };
        assert!(!valid(&record, now));
    }
}
