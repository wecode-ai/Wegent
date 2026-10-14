//! Interpret historical routing from existing metadata and execution records.
use rusqlite::Connection;
use serde_json::{json, Value};

pub(super) fn metadata(
    connection: &Connection,
    id: &str,
    resource_type: &str,
    mut metadata: Value,
) -> rusqlite::Result<Value> {
    if resource_type == "task" && metadata.get("runner_binding").is_none() {
        let mut statement = connection.prepare(
            "SELECT DISTINCT runtime_device_id FROM loop_item_executions
             WHERE loop_item_id=?1 AND runtime_device_id IS NOT NULL AND runtime_device_id!=''
             UNION SELECT device_id FROM loop_items
             WHERE resource_type='execution' AND loop_item_id=?1 AND device_id IS NOT NULL AND device_id!=''",
        )?;
        let devices = statement
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if devices.len() == 1 {
            metadata["runner_binding"] = json!({"environment_id": devices[0]});
        } else if devices.len() > 1 {
            metadata["runner_binding_conflict"] = json!(devices);
        }
    }
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_is_interpreted_without_writes_or_schema_changes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE loop_items(id TEXT, resource_type TEXT, loop_item_id TEXT, device_id TEXT);
             CREATE TABLE loop_item_executions(loop_item_id TEXT, runtime_device_id TEXT);
             INSERT INTO loop_items VALUES ('binding', 'execution', 'issue', 'runner-a');
             INSERT INTO loop_item_executions VALUES ('issue', 'runner-a');",
        ).unwrap();
        let read = metadata(&db, "issue", "task", json!({"tags":["keep"]})).unwrap();
        assert_eq!(read["tags"], json!(["keep"]));
        assert_eq!(read["runner_binding"]["environment_id"], "runner-a");
        assert_eq!(db.total_changes(), 2);
        let columns = db
            .prepare("PRAGMA table_info(loop_items)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|name| name == "runner_environment_id"));

        db.execute(
            "INSERT INTO loop_item_executions VALUES ('issue', 'runner-b')",
            [],
        )
        .unwrap();
        let conflict = metadata(&db, "issue", "task", json!({})).unwrap();
        assert_eq!(
            conflict["runner_binding_conflict"],
            json!(["runner-a", "runner-b"])
        );
        let fixed = metadata(
            &db,
            "issue",
            "task",
            json!({"runner_binding":{"environment_id":"runner-a"}}),
        )
        .unwrap();
        assert_eq!(fixed["runner_binding"]["environment_id"], "runner-a");
    }
}
