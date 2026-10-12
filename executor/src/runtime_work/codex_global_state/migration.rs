use std::io::Read;

use super::*;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectStateQuery {
    protocol_version: u8,
    state: Map<String, Value>,
    oplog: String,
}

pub(super) fn parse_record(line: &str) -> Result<CodexGlobalStateOplogRecord, ()> {
    let mut record: CodexGlobalStateOplogRecord =
        serde_json::from_str(line.trim()).map_err(|_| ())?;
    if record.version != CODEX_GLOBAL_STATE_OPLOG_VERSION {
        return Err(());
    }
    record.workspace_path = normalize_workspace_path(&record.workspace_path);
    if matches!(
        record.kind.as_str(),
        OPLOG_KIND_UPSERT
            | OPLOG_KIND_RENAME
            | OPLOG_KIND_REMOVE
            | OPLOG_KIND_UPSERT_REMOTE_PROJECT
            | OPLOG_KIND_ACTIVATE_PROJECT
    ) && record.workspace_path.is_empty()
    {
        return Err(());
    }
    record.label = record
        .label
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    Ok(record)
}

fn valid_import_operation(record: &CodexGlobalStateOplogRecord) -> bool {
    match record.kind.as_str() {
        OPLOG_KIND_UPSERT | OPLOG_KIND_REMOVE | OPLOG_KIND_UPSERT_REMOTE_PROJECTS => true,
        OPLOG_KIND_RENAME => record.label.is_some(),
        OPLOG_KIND_UPSERT_LOCAL_PROJECT => record.project_key.is_some() && record.label.is_some(),
        OPLOG_KIND_UPSERT_REMOTE_PROJECT => {
            record.project_key.is_some() && record.remote_host_id.is_some()
        }
        OPLOG_KIND_REORDER_PROJECT
        | OPLOG_KIND_ACTIVATE_PROJECT
        | OPLOG_KIND_PROJECT_APPEARANCE => record.project_key.is_some(),
        OPLOG_KIND_PIN_PROJECT => record.project_key.is_some() && record.pinned.is_some(),
        OPLOG_KIND_REORDER_THREAD => record.project_key.is_some() && record.thread_id.is_some(),
        OPLOG_KIND_PIN_THREAD => record.thread_id.is_some() && record.pinned.is_some(),
        _ => false,
    }
}

fn project_state(mut query: ProjectStateQuery) -> Result<Map<String, Value>, String> {
    if query.protocol_version != 1 {
        return Err("Unsupported project-state query version".into());
    }
    let mut operations = Vec::new();
    for (index, line) in query.oplog.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let operation = parse_record(line)
            .ok()
            .filter(valid_import_operation)
            .ok_or_else(|| {
                format!(
                    "Invalid or unsupported project operation at line {}",
                    index + 1
                )
            })?;
        operations.push(operation);
    }
    apply_codex_global_state_ops(&mut query.state, &operations);
    Ok(query.state)
}

// Pure stdin/stdout projection: never resolve a Home, start a runtime, or flush source files.
pub fn run_project_state_query() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "Cannot read project-state query".to_owned())?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err("Project-state query is too large".into());
    }
    let query: ProjectStateQuery =
        serde_json::from_slice(&input).map_err(|_| "Invalid project-state query".to_owned())?;
    let state = project_state(query)?;
    println!("{}", json!({"protocol_version": 1, "state": state}));
    Ok(())
}
