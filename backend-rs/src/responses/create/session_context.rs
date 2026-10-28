// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `TaskRequestBuilder._build_session_context`
//! (`app/services/execution/request_builder.py:695-735`): the persisted
//! executor sessions and legacy session bindings an execution request carries.
//!
//! The deployment's sharded subtask store adds an owner guard before the
//! listing: the
//! recorded request reads `tasks.id` and then the task's ASSISTANT subtasks in
//! message order. Both reads run on the builder's service, like every other
//! read `build_request` performs.
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow};
use serde_json::{Map, Value};

use crate::task_routing::ByTaskId;
use crate::task_store::subtask_column_index;
use crate::task_store_statements::{
    assistant_subtasks_by_task_statement, owner_matches_task_id_statement,
};
use crate::task_store_tables::TableTemplates;

/// One `_build_session_context` call's inputs.
pub(crate) struct SessionContextInput<'a> {
    pub task_id: i64,
    /// `task.user_id`: the Task row's owner. The create flow only resolves
    /// tasks it owns, so it passes the request user id.
    pub task_user_id: i64,
    /// `user.id`: the authenticated request user.
    pub user_id: i64,
    /// `bot_config` entries (the resolved Bot configs of the request).
    pub bot_configs: &'a [Value],
    /// The Task CRD JSON (`spec.fork.runtime.sessions`).
    pub task_json: &'a Value,
    /// `subtask.executor_deleted_at`.
    pub executor_deleted: bool,
    /// The source builder's `new_session` argument.
    pub new_session: bool,
    /// The deployment's physical table templates (`{{tasks}}` when the
    /// deployment shards them); the statements render against these, exactly
    /// like the completion path's `Tables`.
    pub table_templates: TableTemplates,
}

/// `_build_session_context`: `(inherited_sessions, legacy_session_bindings)`.
///
/// `needs_bindings` gates the persisted listing together with the executor
/// deletion flag; a request that needs neither issues no read at all.
pub(crate) async fn build<M: Mysql>(
    mysql: &M,
    input: &SessionContextInput<'_>,
) -> MysqlResult<(Vec<Value>, Vec<Value>)> {
    let persisted = if needs_bindings(input) || input.executor_deleted {
        persisted_sessions(mysql, input).await?
    } else {
        Vec::new()
    };
    Ok(context_from(input, persisted))
}

/// The `needs_bindings` predicate: no new session, the request user owns the
/// task, and a coding shell is configured.
pub(crate) fn needs_bindings(input: &SessionContextInput<'_>) -> bool {
    !input.new_session
        && input.task_user_id == input.user_id
        && input.bot_configs.iter().any(is_coding_shell_config)
}

/// The pure half of `_build_session_context`: the listing's persisted
/// sessions in, `(inherited_sessions, legacy_session_bindings)` out.
pub(crate) fn context_from(
    input: &SessionContextInput<'_>,
    persisted: Vec<Value>,
) -> (Vec<Value>, Vec<Value>) {
    let fork_sessions = fork_sessions(input.task_json);
    // `persisted if executor_deleted else []`: the persisted sessions only
    // join the inherited list once the previous executor is gone.
    let inherited = if input.executor_deleted {
        merge_inherited_sessions(&[fork_sessions.as_slice(), persisted.as_slice()])
    } else {
        merge_inherited_sessions(&[fork_sessions.as_slice()])
    };
    let bindings = if needs_bindings(input) {
        legacy_session_bindings(input.task_id, input.user_id, input.bot_configs, &persisted)
    } else {
        Vec::new()
    };
    (inherited, bindings)
}

/// `_extract_task_fork_runtime`: `spec.fork.runtime` when it is an object.
pub(crate) fn fork_runtime(task_json: &Value) -> Option<Value> {
    task_json
        .pointer("/spec/fork/runtime")
        .filter(|runtime| runtime.is_object())
        .cloned()
}

/// `_extract_inherited_sessions`: `spec.fork.runtime.sessions` objects.
fn fork_sessions(task_json: &Value) -> Vec<Value> {
    task_json
        .pointer("/spec/fork/runtime/sessions")
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|session| session.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// `config.get("shell_type") in {"Codex", "ClaudeCode"}`.
fn is_coding_shell_config(config: &Value) -> bool {
    matches!(
        config.get("shell_type").and_then(Value::as_str),
        Some("Codex" | "ClaudeCode")
    )
}

/// `subtask_store.list_assistant_by_task(..., owner_user_id=user.id)`: the
/// owner guard, then the task's ASSISTANT subtasks in message order.
async fn persisted_sessions<M: Mysql>(
    mysql: &M,
    input: &SessionContextInput<'_>,
) -> MysqlResult<Vec<Value>> {
    let task_id = input.task_id;
    // The deployment's routing renders `{{tasks}}` / `{{subtasks}}` to the
    // task's shard, exactly like the completion path's `Tables`.
    let routed = mysql.route(ByTaskId(task_id as u64));
    let guard: Option<MysqlRow> = routed
        .fetch_optional(
            &owner_matches_task_id_statement(input.table_templates.tasks),
            (task_id, input.user_id),
        )
        .await?;
    if guard.is_none() {
        return Ok(Vec::new());
    }
    let rows: Vec<MysqlRow> = routed
        .fetch_all(
            &assistant_subtasks_by_task_statement(input.table_templates.subtasks),
            (task_id,),
        )
        .await?;
    // `_extract_persisted_sessions`: newest first (`reversed`), one
    // `result.executor_session` per subtask.
    let mut sessions = Vec::new();
    for row in rows.iter().rev() {
        let Some(result) = row_json(row, "result") else {
            continue;
        };
        if !result.is_object() {
            continue;
        }
        if let Some(session) = normalize_executor_session(result.get("executor_session")) {
            sessions.push(session);
        }
    }
    Ok(merge_inherited_sessions(&[sessions.as_slice()]))
}

/// One projected `subtasks` column decoded as JSON.
fn row_json(row: &MysqlRow, column: &str) -> Option<Value> {
    let index = subtask_column_index(column)?;
    let value: Option<Json<Value>> = row.get_at(index).ok().flatten();
    value.map(|json| json.0)
}

/// `_normalize_executor_session`: keep the agent, the session/thread id and
/// the bot id; drop anything else.
fn normalize_executor_session(session: Option<&Value>) -> Option<Value> {
    let session = session?.as_object()?;
    let agent = session.get("agent").filter(|value| is_truthy(value))?;
    let session_id =
        truthy_value(session.get("sessionId")).or_else(|| truthy_value(session.get("session_id")));
    let thread_id =
        truthy_value(session.get("threadId")).or_else(|| truthy_value(session.get("thread_id")));
    if session_id.is_none() && thread_id.is_none() {
        return None;
    }
    let mut normalized = Map::new();
    normalized.insert(
        "agent".to_string(),
        Value::String(crate::json_compat::python_str(agent)),
    );
    if let Some(session_id) = session_id {
        normalized.insert(
            "sessionId".to_string(),
            Value::String(crate::json_compat::python_str(session_id)),
        );
    }
    if let Some(thread_id) = thread_id {
        normalized.insert(
            "threadId".to_string(),
            Value::String(crate::json_compat::python_str(thread_id)),
        );
    }
    if let Some(bot_id) = session.get("botId").or_else(|| session.get("bot_id"))
        && !bot_id.is_null()
    {
        normalized.insert("botId".to_string(), bot_id.clone());
    }
    Some(Value::Object(normalized))
}

/// `_merge_inherited_sessions`: normalize every group and keep the first
/// occurrence of each `(agent, botId, sessionId, threadId)` identity.
fn merge_inherited_sessions(groups: &[&[Value]]) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    let mut seen: Vec<(String, String, String, String)> = Vec::new();
    for sessions in groups {
        for session in sessions.iter() {
            let Some(normalized) = normalize_executor_session(Some(session)) else {
                continue;
            };
            let identity = session_identity(&normalized);
            if seen.contains(&identity) {
                continue;
            }
            seen.push(identity);
            merged.push(normalized);
        }
    }
    merged
}

/// The `(agent, botId, sessionId, threadId)` identity with Python's `or ""`.
fn session_identity(session: &Value) -> (String, String, String, String) {
    let field = |name: &str| {
        session
            .get(name)
            .filter(|value| is_truthy(value))
            .map(crate::json_compat::python_str)
            .unwrap_or_default()
    };
    (
        field("agent"),
        field("botId"),
        field("sessionId"),
        field("threadId"),
    )
}

/// `_build_legacy_session_bindings`: the persisted sessions addressed to a
/// coding Bot of this request, tagged with the task and the request user.
fn legacy_session_bindings(
    task_id: i64,
    user_id: i64,
    bot_configs: &[Value],
    persisted_sessions: &[Value],
) -> Vec<Value> {
    let engines = [("Codex", "threadId"), ("ClaudeCode", "sessionId")];
    let mut allowed: Vec<(String, String, &'static str)> = Vec::new();
    for config in bot_configs {
        let Some(shell_type) = config.get("shell_type").and_then(Value::as_str) else {
            continue;
        };
        let Some((_, id_field)) = engines.iter().find(|(name, _)| *name == shell_type) else {
            continue;
        };
        let bot_id = config
            .get("id")
            .map(crate::json_compat::python_str)
            .unwrap_or_default();
        // `str(id).isdigit() and int(id) > 0`: ASCII digits only.
        if bot_id.is_empty() || !bot_id.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        if bot_id.parse::<i64>().map(|id| id <= 0).unwrap_or(true) {
            continue;
        }
        allowed.push((bot_id, shell_type.to_ascii_lowercase(), id_field));
    }
    let mut bindings = Vec::new();
    for session in persisted_sessions {
        // `str(session.get("agent", "")).replace(" ", "").lower()`.
        let engine = session
            .get("agent")
            .map(crate::json_compat::python_str)
            .unwrap_or_default()
            .replace(' ', "")
            .to_lowercase();
        let bot_id = session
            .get("botId")
            .map(crate::json_compat::python_str)
            .unwrap_or_default();
        let Some((_, _, id_field)) = allowed.iter().find(|(allowed_bot, allowed_engine, _)| {
            *allowed_bot == bot_id && *allowed_engine == engine
        }) else {
            continue;
        };
        let Some(session_id) = session.get(*id_field) else {
            continue;
        };
        let Value::String(session_id) = session_id else {
            continue;
        };
        if session_id.is_empty()
            || !session_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            continue;
        }
        let mut binding = session.as_object().cloned().unwrap_or_default();
        binding.insert("task_id".to_string(), Value::from(task_id));
        binding.insert("user_id".to_string(), Value::from(user_id));
        bindings.push(Value::Object(binding));
    }
    bindings
}

/// Python truthiness for a decoded JSON value.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// The value when Python's `or` would keep it.
fn truthy_value(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| is_truthy(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input<'a>(
        bots: &'a [Value],
        task_json: &'a Value,
        task_user_id: i64,
        user_id: i64,
        executor_deleted: bool,
        new_session: bool,
    ) -> SessionContextInput<'a> {
        SessionContextInput {
            task_id: 801406538674539,
            task_user_id,
            user_id,
            bot_configs: bots,
            task_json,
            executor_deleted,
            new_session,
            table_templates: TableTemplates {
                tasks: "tasks_0711",
                subtasks: "subtasks_0711",
            },
        }
    }

    fn coding_bot(id: i64) -> Value {
        json!({"id": id, "shell_type": "ClaudeCode"})
    }

    fn persisted(agent: &str, bot_id: i64, field: &str, session_id: &str) -> Value {
        json!({"agent": agent, "botId": bot_id, field: session_id})
    }

    /// The predicate's false branches: a different owner, a new session, and a
    /// non-coding shell all leave the context empty and issue no listing.
    #[test]
    fn the_needs_bindings_predicate_matches_the_source() {
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        assert!(needs_bindings(&input(
            &bots, &task_json, 5831, 5831, false, false
        )));
        assert!(!needs_bindings(&input(
            &bots, &task_json, 1809, 5831, false, false
        )));
        assert!(!needs_bindings(&input(
            &bots, &task_json, 5831, 5831, false, true
        )));
        let chat = [json!({"id": 637588, "shell_type": "Chat"})];
        assert!(!needs_bindings(&input(
            &chat, &task_json, 5831, 5831, false, false
        )));
        let codex = [json!({"id": 637588, "shell_type": "Codex"})];
        assert!(needs_bindings(&input(
            &codex, &task_json, 5831, 5831, false, false
        )));
    }

    /// A request that needs no bindings and has no deleted executor issues no
    /// SQL at all.
    #[tokio::test]
    async fn a_context_free_request_reads_nothing() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let task_json = json!({});
        let chat = [json!({"id": 637588, "shell_type": "Chat"})];
        let (inherited, bindings) =
            build(&mysql, &input(&chat, &task_json, 5831, 5831, false, false))
                .await
                .expect("context");
        assert!(inherited.is_empty());
        assert!(bindings.is_empty());
        assert!(mysql.queries().is_empty(), "{:?}", mysql.queries());
    }

    /// A coding shell with an owned task issues the owner guard first; a
    /// failed guard short-circuits before the listing, exactly like the
    /// deployment store's `_owner_matches_task_id` check.
    #[tokio::test]
    async fn a_failed_owner_guard_stops_before_the_listing() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        let (inherited, bindings) =
            build(&mysql, &input(&bots, &task_json, 5831, 5831, false, false))
                .await
                .expect("context");
        assert!(inherited.is_empty());
        assert!(bindings.is_empty());
        let calls = mysql.queries();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0].args, 2, "the owner guard binds task and user");
        assert_eq!(
            calls[0].sql,
            "SELECT id FROM tasks_0711 WHERE id = ? AND user_id = ? LIMIT 1"
        );
    }

    /// The deployment's table templates reach the statements unchanged; the
    /// routing layer renders `{{tasks}}` / `{{subtasks}}` to the task's shard
    /// when the statement executes, so no base table name is hardcoded here.
    #[tokio::test]
    async fn the_deployment_templates_reach_the_statements() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        let mut context = input(&bots, &task_json, 5831, 5831, false, false);
        context.table_templates = TableTemplates {
            tasks: "{{tasks}}",
            subtasks: "{{subtasks}}",
        };
        let _ = build(&mysql, &context).await.expect("context");
        let calls = mysql.queries();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert!(
            calls[0].sql.contains("FROM {{tasks}}"),
            "the guard keeps the deployment template: {calls:?}"
        );
    }

    /// The listing statement keeps the recorded predicate and message order,
    /// against the deployment's resolved subtask table.
    #[test]
    fn the_listing_statement_matches_the_recording() {
        let statement = assistant_subtasks_by_task_statement("subtasks_0711");
        assert!(
            statement.contains("FROM subtasks_0711"),
            "the resolved deployment table is used: {statement}"
        );
        assert!(
            statement
                .contains("WHERE subtasks_0711.task_id = ? AND subtasks_0711.`role` = 'ASSISTANT'"),
            "{statement}"
        );
        assert!(
            statement.contains("ORDER BY subtasks_0711.message_id ASC"),
            "{statement}"
        );
        assert_eq!(statement.matches('?').count(), 1);
    }

    /// An empty listing leaves the context empty.
    #[test]
    fn an_empty_listing_produces_no_context() {
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        let (inherited, bindings) = context_from(
            &input(&bots, &task_json, 5831, 5831, false, false),
            Vec::new(),
        );
        assert!(inherited.is_empty());
        assert!(bindings.is_empty());
    }

    /// A persisted ClaudeCode session addressed to the request's Bot becomes a
    /// legacy binding tagged with the task and the user.
    #[test]
    fn a_persisted_session_becomes_a_legacy_binding() {
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        let sessions = vec![persisted("claudeCode", 637588, "sessionId", "session-1")];
        let (inherited, bindings) = context_from(
            &input(&bots, &task_json, 5831, 5831, false, false),
            sessions,
        );
        assert!(inherited.is_empty(), "no deleted executor");
        assert_eq!(
            bindings,
            vec![json!({
                "agent": "claudeCode",
                "botId": 637588,
                "sessionId": "session-1",
                "task_id": 801406538674539i64,
                "user_id": 5831,
            })]
        );
    }

    /// `_build_legacy_session_bindings` drops a session whose engine, bot id
    /// or session id does not match an allowed coding Bot.
    #[test]
    fn a_session_for_another_bot_or_engine_is_not_bound() {
        let task_json = json!({});
        let bots = [coding_bot(637588)];
        let sessions = vec![
            persisted("claudeCode", 111111, "sessionId", "session-1"),
            persisted("codex", 637588, "threadId", "thread-1"),
            persisted("claudeCode", 637588, "sessionId", "bad session id"),
        ];
        let (_, bindings) = context_from(
            &input(&bots, &task_json, 5831, 5831, false, false),
            sessions,
        );
        assert!(bindings.is_empty(), "{bindings:?}");
    }

    /// `executor_deleted` merges the persisted sessions into the inherited
    /// list even when the request has no coding shell to bind them to.
    #[test]
    fn a_deleted_executor_inherits_the_persisted_sessions() {
        let task_json = json!({});
        let chat = [json!({"id": 637588, "shell_type": "Chat"})];
        let sessions = vec![persisted("claudeCode", 637588, "sessionId", "session-1")];
        let (inherited, bindings) =
            context_from(&input(&chat, &task_json, 5831, 5831, true, false), sessions);
        assert_eq!(
            inherited,
            vec![json!({"agent": "claudeCode", "botId": 637588, "sessionId": "session-1"})]
        );
        assert!(bindings.is_empty());
    }

    /// The task CRD's fork sessions lead the inherited list, and a duplicate
    /// identity is kept once.
    #[test]
    fn fork_sessions_lead_and_deduplicate() {
        let task_json = json!({"spec": {"fork": {"runtime": {"sessions": [
            {"agent": "codex", "threadId": "thread-1"},
            {"agent": "codex", "threadId": "thread-1"},
        ]}}}});
        let chat = [json!({"id": 637588, "shell_type": "Chat"})];
        // The persisted row repeats the fork session's identity
        // (`(agent, botId, sessionId, threadId)`, no bot id here).
        let sessions = vec![json!({"agent": "codex", "threadId": "thread-1"})];
        let (inherited, _) =
            context_from(&input(&chat, &task_json, 5831, 5831, true, false), sessions);
        assert_eq!(
            inherited,
            vec![json!({"agent": "codex", "threadId": "thread-1"})]
        );
    }
}
