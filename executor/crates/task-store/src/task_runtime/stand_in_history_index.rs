//! Indexed retention facts are recorded with new writes; legacy payloads are not backfilled.
use super::*;

pub(super) fn schema_is_current(connection: &Connection) -> Result<bool, rusqlite::Error> {
    connection.query_row(
        "SELECT count(*) = 12 FROM sqlite_master WHERE
         (type='table' AND name IN ('stand_in_history','stand_in_history_refs','stand_in_retention_cursor'))
         OR (type='index' AND name IN (
           'ix_stand_in_history_status','ix_stand_in_history_batch',
           'ix_stand_in_history_router_batch','ix_stand_in_history_error',
           'ix_stand_in_history_event_ref','ix_stand_in_history_retention',
           'ix_loop_items_loop_item_id','ix_loop_items_delivery_id','ix_stand_in_live_work'))",
        [],
        |row| row.get(0),
    )
}

pub(super) fn ensure_schema(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS stand_in_history (
           id TEXT PRIMARY KEY REFERENCES loop_items(id) ON DELETE CASCADE,
           resource_type TEXT NOT NULL, user_id INTEGER NOT NULL,
           status TEXT, kind TEXT, batch_id TEXT, router_batch_id TEXT,
           error_command_id TEXT, event_created_at TEXT, compacted INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_status
           ON stand_in_history(user_id, resource_type, status);
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_batch
           ON stand_in_history(user_id, resource_type, batch_id);
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_router_batch
           ON stand_in_history(user_id, resource_type, router_batch_id);
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_error
           ON stand_in_history(user_id, resource_type, error_command_id);
         CREATE TABLE IF NOT EXISTS stand_in_history_refs (
           owner_id TEXT NOT NULL REFERENCES stand_in_history(id) ON DELETE CASCADE,
           event_id TEXT NOT NULL, PRIMARY KEY(owner_id, event_id)
         );
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_event_ref
           ON stand_in_history_refs(event_id, owner_id);
         CREATE INDEX IF NOT EXISTS ix_stand_in_history_retention
           ON loop_items(resource_type, julianday(updated_at), id)
           WHERE resource_type IN ('stand_in_event','stand_in_action','stand_in_route');
         CREATE INDEX IF NOT EXISTS ix_loop_items_loop_item_id ON loop_items(loop_item_id);
         CREATE INDEX IF NOT EXISTS ix_loop_items_delivery_id ON loop_items(delivery_id);
         CREATE INDEX IF NOT EXISTS ix_stand_in_live_work
           ON loop_items(resource_type, json_extract(metadata,'$.status'),
                          json_extract(metadata,'$.userId'))
           WHERE resource_type IN ('stand_in_action','stand_in_event')
             AND CASE WHEN json_valid(metadata)
                      THEN json_extract(metadata,'$.status') IN ('pending','sending','failed')
                      ELSE 0 END;
         CREATE TABLE IF NOT EXISTS stand_in_retention_cursor (
           resource_type TEXT PRIMARY KEY, updated_jd REAL NOT NULL,
           item_id TEXT NOT NULL, checked_at TEXT NOT NULL
         );",
    )
}

pub(super) fn record(
    connection: &Connection,
    kind: &str,
    value: &Value,
) -> Result<(), TaskRuntimeError> {
    let id = value["id"].as_str();
    connection.execute(
        "INSERT INTO stand_in_history(id,resource_type,user_id,status,kind,batch_id,
           router_batch_id,error_command_id,event_created_at,compacted)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
         ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,status=excluded.status,
           kind=excluded.kind,batch_id=excluded.batch_id,router_batch_id=excluded.router_batch_id,
           error_command_id=excluded.error_command_id,event_created_at=excluded.event_created_at,
           compacted=excluded.compacted",
        params![
            id,
            kind,
            value["userId"].as_i64().unwrap_or_default(),
            value["status"].as_str(),
            value["kind"].as_str(),
            value["batchId"]
                .as_str()
                .or(value["result"]["snapshotId"].as_str()),
            value["routerSnapshot"]["id"].as_str(),
            value["error"]["commandId"].as_str(),
            value["createdAt"].as_str(),
            value["compacted"] == true
        ],
    )?;
    connection.execute("DELETE FROM stand_in_history_refs WHERE owner_id=?1", [id])?;
    let events = if kind == "stand_in_action" {
        value["arguments"]["eventIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
    } else if kind == "stand_in_processing" {
        [
            &value["snapshot"]["events"],
            &value["routerSnapshot"]["intake"],
        ]
        .into_iter()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|event| event["id"].as_str())
        .collect()
    } else {
        Vec::new()
    };
    let mut insert = connection.prepare_cached(
        "INSERT OR IGNORE INTO stand_in_history_refs(owner_id,event_id) VALUES (?1,?2)",
    )?;
    for event in events {
        insert.execute(params![id, event])?;
    }
    Ok(())
}
