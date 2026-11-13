//! Permission-filtered keyset pages share ordering with every personal Issue list.
use super::*;

#[derive(Deserialize)]
pub(super) struct ListQuery {
    #[serde(default = "participating")]
    pub(super) scope: String,
    #[serde(default = "attention")]
    pub(super) order: String,
    #[serde(default)]
    pub(super) include_completed: bool,
    #[serde(default)]
    pub(super) archived: bool,
    pub(super) cursor: Option<String>,
}
fn participating() -> String {
    "participating".into()
}
fn attention() -> String {
    "attention".into()
}

#[derive(Deserialize, Serialize)]
struct Cursor {
    rank: i32,
    priority: i32,
    time: i64,
    id: String,
    user: i32,
    scope: String,
    order: String,
    archived: bool,
    completed: bool,
}

fn expressions(order: &str) -> Result<(&'static str, &'static str, String), FastApiError> {
    let rank = if order == "attention" {
        "CASE status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END"
    } else {
        "CAST(0 AS SIGNED)"
    };
    let priority = if matches!(order, "attention" | "priority") {
        "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END"
    } else {
        "CAST(0 AS SIGNED)"
    };
    let time = match order {
        "assignment" => "TIMESTAMPDIFF(MICROSECOND,'1970-01-01',COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.assigned_at')),'null'),'9999-12-31 23:59:59'))".to_string(),
        "attention"|"activity"|"priority"|"recent" => "-TIMESTAMPDIFF(MICROSECOND,'1970-01-01',updated_at)".to_string(),
        _=>return Err(invalid("Invalid Issue order")),
    };
    Ok((rank, priority, time))
}

fn cursor(row: &Issue, query: &ListQuery, user: i32) -> Result<String, FastApiError> {
    let rank = if query.order == "attention" {
        match row.status.as_str() {
            "pending" => 0,
            "in_progress" => 1,
            _ => 2,
        }
    } else {
        0
    };
    let priority = if matches!(query.order.as_str(), "attention" | "priority") {
        match row.priority.as_str() {
            "urgent" => 0,
            "high" => 1,
            "medium" => 2,
            "low" => 3,
            _ => 4,
        }
    } else {
        0
    };
    let date = if query.order == "assignment" {
        row.metadata
            .0
            .assigned_at
            .as_deref()
            .unwrap_or("9999-12-31 23:59:59")
    } else {
        &row.updated_at
    };
    let date = chrono::NaiveDateTime::parse_from_str(date, "%Y-%m-%d %H:%M:%S%.f")
        .map_err(|_| FastApiError::internal())?;
    let time = date.and_utc().timestamp_micros() * if query.order == "assignment" { 1 } else { -1 };
    serde_json::to_string(&Cursor {
        rank,
        priority,
        time,
        id: row.id.clone(),
        user,
        scope: query.scope.clone(),
        order: query.order.clone(),
        archived: query.archived,
        completed: query.include_completed,
    })
    .map_err(|_| FastApiError::internal())
}

#[brz_http_server::get("/api/v1/personal-issues")]
pub(super) async fn list_issues(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: Query<ListQuery>,
) -> Result<Value, FastApiError> {
    if !matches!(
        query.scope.as_str(),
        "assigned" | "created" | "participating"
    ) {
        return Err(invalid("Invalid Issue scope"));
    }
    let (rank, priority, time) = expressions(&query.order)?;
    let before: Option<Cursor> = query
        .cursor
        .as_ref()
        .map(|value| serde_json::from_str(value))
        .transpose()
        .map_err(|_| invalid("Invalid cursor"))?;
    if before.as_ref().is_some_and(|c| {
        c.user != user.0.id
            || c.scope != query.scope
            || c.order != query.order
            || c.archived != query.archived
            || c.completed != query.include_completed
            || !(0..=2).contains(&c.rank)
            || !(0..=4).contains(&c.priority)
            || c.id.is_empty()
            || c.id.len() > 64
    }) {
        return Err(invalid("Cursor does not match this Issue query"));
    }
    let mut rows: Vec<Issue> = state
        .mysql
        .fetch_all(
            format!(
                "{SELECT} WHERE {LIVE}
        AND (created_by_user_id=? OR JSON_CONTAINS(metadata,CAST(? AS JSON),'$.participants'))
        AND (?<>'assigned' OR assignee_user_id=?) AND (?<>'created' OR created_by_user_id=?)
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.archived')),'false')=? AND (? OR status<>'completed')
        AND (? IS NULL OR ({rank},{priority},{time},id)>(?,?,?,?))
        ORDER BY {rank},{priority},{time},id LIMIT 31"
            ),
            (
                user.0.id,
                user.0.id.to_string(),
                query.scope.as_str(),
                user.0.id,
                query.scope.as_str(),
                user.0.id,
                if query.archived { "true" } else { "false" },
                query.include_completed,
                before.as_ref().map(|c| c.rank),
                before.as_ref().map(|c| c.rank),
                before.as_ref().map(|c| c.priority),
                before.as_ref().map(|c| c.time),
                before.as_ref().map(|c| c.id.as_str()),
            ),
        )
        .await
        .map_err(internal)?;
    let more = rows.len() > 30;
    rows.truncate(30);
    let next = if more {
        rows.last()
            .map(|row| cursor(row, &query, user.0.id))
            .transpose()?
    } else {
        None
    };
    Ok(json!({"items":rows,"next_cursor":next}))
}
