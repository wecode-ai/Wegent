//! Indexed storage for connection consumers and collectors. No hot path loads a whole journal.
use super::*;
use rusqlite::{params, Connection, Transaction};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

// An executor owns one event database. Queue its writes before acquiring a SQLite lock.
static WRITER: Mutex<()> = Mutex::new(());

pub(super) enum Scope<'a> {
    Row(&'a str, &'a str),
    Task(&'a str),
    Waiting(&'a str),
    TaskProjection(&'a str),
    TaskEvents(&'a str),
    Source(&'a str),
    Activation(&'a str, &'a str),
    Cloud(&'a str),
    Active,
    Observers,
    PendingStops,
    #[cfg(test)]
    All,
}

fn storage(error: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new("control_storage_failed", error.to_string())
}

fn lock_writer() -> MutexGuard<'static, ()> {
    WRITER.lock().unwrap_or_else(|error| error.into_inner())
}

fn open(path: &Path) -> Result<Connection, AppIpcError> {
    std::fs::create_dir_all(path.parent().expect("event store parent")).map_err(storage)?;
    let mut connection = Connection::open(path).map_err(storage)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(storage)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage)?;
    if version == 1 {
        return Ok(connection);
    }
    if version != 0 {
        return Err(storage("Unsupported connection event store version"));
    }
    connection
        .execute_batch("PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;")
        .map_err(storage)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    if transaction
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(storage)?
        == 1
    {
        transaction.commit().map_err(storage)?;
        return Ok(connection);
    }
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS records (
        section TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        task TEXT, source TEXT, status TEXT, expires INTEGER, cloud TEXT, active INTEGER NOT NULL, metadata TEXT NOT NULL, waiting INTEGER NOT NULL, consuming INTEGER NOT NULL, consumers INTEGER NOT NULL DEFAULT 0, stop_pending INTEGER NOT NULL, stop_attempt INTEGER NOT NULL,
        PRIMARY KEY(section,id));
        CREATE INDEX IF NOT EXISTS records_task ON records(section,task,status);
        CREATE INDEX IF NOT EXISTS records_waiting ON records(section,task,waiting);
        CREATE INDEX IF NOT EXISTS records_active ON records(section,active,expires);
        CREATE INDEX IF NOT EXISTS records_source_status ON records(section,source,status);
        CREATE INDEX IF NOT EXISTS records_source ON records(section,source);
        CREATE INDEX IF NOT EXISTS records_status ON records(section,status);
        CREATE INDEX IF NOT EXISTS records_expiry ON records(section,expires);
        CREATE INDEX IF NOT EXISTS records_stops ON records(section,stop_pending,stop_attempt);
        CREATE INDEX IF NOT EXISTS records_cloud ON records(section,cloud);
        CREATE INDEX IF NOT EXISTS records_consumers ON records(section,consumers);
        CREATE INDEX IF NOT EXISTS records_consuming ON records(source,consuming);
        CREATE TRIGGER IF NOT EXISTS collector_insert AFTER INSERT ON records WHEN NEW.section='observations' BEGIN
          UPDATE records SET consumers=(SELECT COUNT(*) FROM records WHERE source=NEW.id AND consuming=1)
            WHERE section='observations' AND id=NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS consumer_insert AFTER INSERT ON records WHEN NEW.consuming=1 BEGIN
          UPDATE records SET consumers=consumers+1 WHERE section='observations' AND id=NEW.source;
        END;
        CREATE TRIGGER IF NOT EXISTS consumer_update AFTER UPDATE OF source,consuming ON records BEGIN
          UPDATE records SET consumers=consumers-OLD.consuming WHERE section='observations' AND id=OLD.source;
          UPDATE records SET consumers=consumers+NEW.consuming WHERE section='observations' AND id=NEW.source;
        END;
        CREATE TRIGGER IF NOT EXISTS consumer_delete AFTER DELETE ON records WHEN OLD.consuming=1 BEGIN
          UPDATE records SET consumers=consumers-1 WHERE section='observations' AND id=OLD.source;
        END;",
        )
        .map_err(storage)?;
    transaction
        .pragma_update(None, "user_version", 1)
        .map_err(storage)?;
    transaction.commit().map_err(storage)?;
    Ok(connection)
}

fn save(
    transaction: &Transaction<'_>,
    section: &str,
    id: &str,
    record: &Value,
) -> Result<(), AppIpcError> {
    // Preserve the stopped generation as a fence without retaining provider snapshots.
    let tombstone = (section == "observers" && record["status"] == "stopped" && record["cloud_stop_pending"] != true)
        .then(|| json!({"id":id,"consumer_key":record["consumer_key"],"generation":record["generation"],"device_id":record["device_id"],"status":"stopped","cloud_stop_pending":false}));
    let record = tombstone.as_ref().unwrap_or(record);
    let value = serde_json::to_string(record).map_err(storage)?;
    let consuming = match section {
        "operations" => !matches!(record["status"].as_str(), Some("cancelled" | "delivered")),
        "observers" => record["status"] != "stopped",
        _ => false,
    };
    let waiting = !record["waiting_goal"].is_null()
        && matches!(
            record["status"].as_str(),
            Some("preparing" | "armed" | "pending" | "resuming_goal")
        );
    let active = match section {
        "operations" => {
            matches!(
                record["status"].as_str(),
                Some("preparing" | "armed" | "pending" | "resuming_goal")
            ) || record["cloud_cancel_pending"] == true
                || record["cloud_refresh_pending"] == true
        }
        "observers" => record["status"] != "stopped",
        _ => false,
    };
    let metadata = if section == "observations" {
        let fields: serde_json::Map<String, Value> = record
            .as_object()
            .ok_or_else(|| storage("Invalid observation record"))?
            .iter()
            .filter(|(key, _)| !matches!(key.as_str(), "events" | "checkpoint"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        serde_json::to_string(&fields).map_err(storage)?
    } else if section == "operations" {
        serde_json::to_string(&public_subscription(record)).map_err(storage)?
    } else {
        "{}".into()
    };
    let cloud = record["cloud_subscription"]["id"]
        .as_str()
        .or_else(|| record["cloud_registration"]["subscription_id"].as_str());
    transaction.execute("INSERT INTO records(section,id,value,task,source,status,expires,cloud,active,metadata,waiting,consuming,consumers,stop_pending,stop_attempt)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,0,?13,?14) ON CONFLICT(section,id) DO UPDATE SET
        value=excluded.value,task=excluded.task,source=excluded.source,status=excluded.status,expires=excluded.expires,cloud=excluded.cloud,active=excluded.active,metadata=excluded.metadata,waiting=excluded.waiting,consuming=excluded.consuming,stop_pending=excluded.stop_pending,stop_attempt=excluded.stop_attempt",
        params![section,id,value,record["task_id"].as_str(),record["observation_id"].as_str(),record["status"].as_str(),record["expires_at"].as_i64(),cloud,active,metadata,waiting,consuming,record["cloud_stop_pending"] == true,record["last_stop_attempt"].as_i64().unwrap_or(0)]).map_err(storage)?;
    Ok(())
}

fn load(connection: &Connection, scope: Scope<'_>) -> Result<Value, AppIpcError> {
    let mut state = json!({"version":1,"operations":{},"observations":{},"observers":{}});
    let now = now_ms();
    let (sql, args): (&str, Vec<&dyn rusqlite::ToSql>) = match &scope {
        Scope::Row(section, id) => ("SELECT section,id,value FROM records WHERE section=?1 AND id=?2", vec![section,id]),
        Scope::Task(task) => ("SELECT section,id,value FROM records WHERE section='operations' AND task=?1", vec![task]),
        Scope::TaskProjection(task) => ("SELECT section,id,metadata FROM records WHERE section='operations' AND task=?1 AND status IN ('preparing','armed','pending','resuming_goal','needs_attention','error','delivered')", vec![task]),
        Scope::Waiting(task) => ("SELECT section,id,value FROM records WHERE section='operations' AND task=?1 AND waiting=1", vec![task]),
        Scope::TaskEvents(task) => ("SELECT section,id,value FROM records WHERE section='operations' AND task=?1 UNION ALL SELECT section,id,value FROM records WHERE section='observations' AND id IN (SELECT source FROM records WHERE section='operations' AND task=?1)", vec![task]),
        Scope::Source(id) => ("SELECT section,id,value FROM records WHERE section='observations' AND id=?1 UNION ALL SELECT section,id,value FROM records WHERE section='operations' AND source=?1 AND status='armed'", vec![id]),
        Scope::Activation(source, id) => ("SELECT section,id,value FROM records WHERE section='observations' AND id=?1 UNION ALL SELECT section,id,value FROM records WHERE section='operations' AND source=?1 AND status='armed' UNION ALL SELECT section,id,value FROM records WHERE section='operations' AND id=?2 AND status IS NOT 'armed'", vec![source,id]),
        Scope::Cloud(id) => ("SELECT section,id,value FROM records WHERE section='operations' AND cloud=?1", vec![id]),
        Scope::Active => ("SELECT section,id,value FROM records WHERE section='operations' AND active=1 UNION ALL SELECT section,id,value FROM records WHERE section='observers' AND active=1 UNION ALL SELECT section,id,metadata FROM records WHERE section='observations' AND id IN (SELECT source FROM records WHERE section IN ('operations','observers') AND active=1)", vec![]),
        Scope::Observers => ("SELECT section,id,value FROM records WHERE section='observers' AND active=1 AND expires<=?1 ORDER BY expires LIMIT 100", vec![&now]),
        Scope::PendingStops => ("SELECT section,id,value FROM records WHERE section='observers' AND stop_pending=1 ORDER BY stop_attempt LIMIT 1", vec![]),
        #[cfg(test)]
        Scope::All => ("SELECT section,id,value FROM records", vec![]),
    };
    let mut statement = connection.prepare(sql).map_err(storage)?;
    let rows = statement
        .query_map(args.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(storage)?;
    for row in rows {
        let (section, id, value) = row.map_err(storage)?;
        state[&section][&id] = serde_json::from_str(&value).map_err(storage)?;
    }
    Ok(state)
}

pub(super) fn read<T>(
    path: &Path,
    scope: Scope<'_>,
    query: impl FnOnce(&Value) -> Result<T, AppIpcError>,
) -> Result<T, AppIpcError> {
    let connection = open(path)?;
    query(&load(&connection, scope)?)
}

fn edit<T>(
    transaction: &Transaction<'_>,
    scope: Scope<'_>,
    update: impl FnOnce(&mut Value) -> Result<T, AppIpcError>,
) -> Result<T, AppIpcError> {
    let mut state = load(transaction, scope)?;
    let original = state.clone();
    let result = update(&mut state)?;
    for section in ["operations", "observations", "observers"] {
        let rows = state[section]
            .as_object()
            .ok_or_else(|| storage("Invalid connection event section"))?;
        for (id, record) in rows {
            if original[section].get(id) != Some(record) {
                save(transaction, section, id, record)?;
            }
        }
        for id in original[section]
            .as_object()
            .unwrap()
            .keys()
            .filter(|id| !rows.contains_key(*id))
        {
            transaction
                .execute(
                    "DELETE FROM records WHERE section=?1 AND id=?2",
                    params![section, id],
                )
                .map_err(storage)?;
        }
    }
    Ok(result)
}

pub(super) fn update<T>(
    path: &Path,
    scope: Scope<'_>,
    update: impl FnOnce(&mut Value) -> Result<T, AppIpcError>,
) -> Result<T, AppIpcError> {
    let _writer = lock_writer();
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let result = edit(&transaction, scope, update)?;
    transaction.commit().map_err(storage)?;
    Ok(result)
}

pub(super) fn update_and_read(
    path: &Path,
    scope: Scope<'_>,
    update: impl FnOnce(&mut Value) -> Result<(), AppIpcError>,
    projection: Scope<'_>,
) -> Result<Value, AppIpcError> {
    let _writer = lock_writer();
    let mut connection = open(path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    edit(&transaction, scope, update)?;
    let projected = load(&transaction, projection)?;
    transaction.commit().map_err(storage)?;
    Ok(projected)
}

#[cfg(test)]
pub(in crate::runtime_work::handler) fn transact<T>(
    path: &Path,
    update: impl FnOnce(&mut Value) -> Result<T, AppIpcError>,
) -> Result<T, AppIpcError> {
    self::update(path, Scope::All, update)
}

/// The indexed consumer count is updated in the same transaction as each lease.
/// A bounded batch keeps reclamation independent of the number of past activations.
pub(super) fn unreferenced(path: &Path) -> Result<Vec<String>, AppIpcError> {
    let connection = open(path)?;
    let mut statement = connection
        .prepare("SELECT id FROM records WHERE section='observations' AND consumers=0 LIMIT 32")
        .map_err(storage)?;
    let rows = statement.query_map([], |row| row.get(0)).map_err(storage)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage)
}

pub(super) fn remove_unreferenced(path: &Path, id: &str) -> Result<(), AppIpcError> {
    let _writer = lock_writer();
    let connection = open(path)?;
    connection
        .execute(
            "DELETE FROM records WHERE section='observations' AND id=?1 AND consumers=0",
            [id],
        )
        .map_err(storage)?;
    let mut statement = connection
        .prepare("PRAGMA incremental_vacuum(64)")
        .map_err(storage)?;
    let mut rows = statement.query([]).map_err(storage)?;
    while rows.next().map_err(storage)?.is_some() {}
    Ok(())
}

#[cfg(test)]
mod tests;
