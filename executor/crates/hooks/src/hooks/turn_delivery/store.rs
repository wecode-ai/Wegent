// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use wegent_workspace::turn_file_changes::GitTurnRange;

use crate::hooks::model::{CommandHookConfig, TurnCompletedInput, TurnHookReceipt};

pub(super) const LEASE_MS: i64 = 60_000;

// Paused deliveries retain their payloads. Ordering belongs to a consumer,
// so one unavailable plugin must not hold another plugin's workspace hostage.
const SCHEDULE: &str = "WITH ready_deliveries AS (
    SELECT d.id,d.event,d.next_attempt FROM turn_deliveries d JOIN turn_events e ON e.id=d.event
    WHERE d.complete=0 AND d.plugin_id IN (SELECT value FROM json_each(?1))
        AND NOT EXISTS (SELECT 1 FROM turn_deliveries prior
            JOIN turn_events earlier ON earlier.id=prior.event
            WHERE prior.plugin_id=d.plugin_id AND prior.handler_id=d.handler_id
                AND prior.complete=0 AND earlier.id<e.id
                AND (earlier.workspace=e.workspace OR earlier.session_id=e.session_id))),
    due_events AS (
        SELECT e.*, MAX(e.next_attempt,COALESCE((SELECT MIN(d.next_attempt)
            FROM ready_deliveries d WHERE d.event=e.id),0)) AS due
        FROM turn_events e WHERE e.state<>'complete' AND (e.state='cleanup'
            OR NOT EXISTS (SELECT 1 FROM turn_deliveries d WHERE d.event=e.id AND d.complete=0)
            OR EXISTS (SELECT 1 FROM ready_deliveries d WHERE d.event=e.id)))";

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Target {
    pub plugin_id: String,
    pub handler_id: String,
    pub directory: PathBuf,
    pub config: CommandHookConfig,
}

pub(super) struct Delivery {
    pub id: i64,
    pub target: Target,
}

pub(super) struct Event {
    pub id: i64,
    pub input: TurnCompletedInput,
    pub range: Option<GitTurnRange>,
    pub ready: bool,
    pub directory: PathBuf,
    pub deliveries: Vec<Delivery>,
}

pub(super) struct Store {
    db: Connection,
}

impl Store {
    pub fn enqueue_at(
        path: &Path,
        input: TurnCompletedInput,
        range: Option<GitTurnRange>,
        targets: Vec<Target>,
        artifacts: &Path,
    ) -> Result<TurnHookReceipt, String> {
        match Self::open(path) {
            Ok(mut store) => store.enqueue(input, range, targets, artifacts),
            Err(original) => {
                if let Some(range) = range {
                    range.release_if_unqueued().map_err(|error| {
                        format!("{original}; unqueued range release failed: {error}")
                    })?;
                }
                Err(original)
            }
        }
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        fs::create_dir_all(path.parent().ok_or("Turn hook database has no parent")?)
            .map_err(error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let file = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .map_err(error)?;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(error)?;
        }
        let db = Connection::open(path).map_err(error)?;
        db.busy_timeout(Duration::from_secs(5)).map_err(error)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS turn_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
                workspace TEXT NOT NULL, input TEXT NOT NULL, range_json TEXT,
                directory TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
                owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_error TEXT,
                UNIQUE(session_id, turn_id));
            CREATE TABLE IF NOT EXISTS turn_deliveries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event INTEGER NOT NULL REFERENCES turn_events(id),
                plugin_id TEXT NOT NULL, handler_id TEXT NOT NULL, target TEXT NOT NULL,
                complete INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT,
                UNIQUE(event, plugin_id, handler_id));
            CREATE INDEX IF NOT EXISTS turn_pending ON turn_events(state, next_attempt);
            CREATE INDEX IF NOT EXISTS turn_delivery_event ON turn_deliveries(event, complete);
            CREATE INDEX IF NOT EXISTS turn_delivery_consumer ON turn_deliveries(plugin_id, handler_id, complete, event);
            CREATE TABLE IF NOT EXISTS discarded_turn_ranges (
                range_json TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt INTEGER NOT NULL DEFAULT 0);",
        )
        .map_err(error)?;
        Ok(Self { db })
    }

    pub fn enqueue(
        &mut self,
        input: TurnCompletedInput,
        range: Option<GitTurnRange>,
        targets: Vec<Target>,
        artifacts: &Path,
    ) -> Result<TurnHookReceipt, String> {
        let result = self.enqueue_transaction(input, range.clone(), targets, artifacts);
        if let Some(range) = range {
            if let Err(original) = &result {
                // A failed commit can have an ambiguous outcome. Check durable
                // ownership before releasing a range that was not acknowledged.
                let serialized = serde_json::to_string(&range).map_err(error)?;
                let referenced: bool = self
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM turn_events WHERE range_json=?1
                     UNION SELECT 1 FROM discarded_turn_ranges WHERE range_json=?1)",
                        [&serialized],
                        |row| row.get(0),
                    )
                    .map_err(|error| {
                        format!("{original}; cannot verify range ownership, pins retained: {error}")
                    })?;
                if referenced {
                    range.mark_queued();
                } else {
                    range.release_if_unqueued().map_err(|error| {
                        format!("{original}; unqueued range release failed: {error}")
                    })?;
                }
            } else {
                range.mark_queued();
            }
        }
        result
    }

    fn enqueue_transaction(
        &mut self,
        mut input: TurnCompletedInput,
        range: Option<GitTurnRange>,
        targets: Vec<Target>,
        artifacts: &Path,
    ) -> Result<TurnHookReceipt, String> {
        super::normalize_input(&mut input)?;
        let transaction = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let range_json = range
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(error)?;
        let existing: Option<(String, u64, usize, Option<String>)> = transaction.query_row(
            "SELECT event_id,id,(SELECT COUNT(*) FROM turn_deliveries WHERE event=turn_events.id),range_json
             FROM turn_events WHERE session_id=?1 AND turn_id=?2",
            params![input.session_id, input.turn_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(error)?;
        if let Some((event_id, sequence, queued_handlers, original_range)) = existing {
            if let Some(range_json) =
                range_json.filter(|value| Some(value) != original_range.as_ref())
            {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO discarded_turn_ranges(range_json) VALUES (?1)",
                        [&range_json],
                    )
                    .map_err(error)?;
            }
            transaction.commit().map_err(error)?;
            return Ok(TurnHookReceipt {
                event_id,
                sequence,
                queued_handlers,
            });
        }
        input.event_id = format!(
            "turn:{}:{}:{}:{}",
            input.session_id.len(),
            input.session_id,
            input.turn_id.len(),
            input.turn_id
        );
        let workspace = range
            .as_ref()
            .map(|range| range.workspace_path().to_path_buf())
            .or_else(|| {
                input.file_changes["workspace_path"]
                    .as_str()
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| input.cwd.clone());
        transaction
            .execute(
                "INSERT INTO turn_events
            (event_id,session_id,turn_id,workspace,input,range_json,directory)
            VALUES (?1,?2,?3,?4,'',?5,'')",
                params![
                    input.event_id,
                    input.session_id,
                    input.turn_id,
                    workspace.to_string_lossy(),
                    range_json
                ],
            )
            .map_err(error)?;
        let id = transaction.last_insert_rowid();
        input.sequence = id as u64;
        transaction
            .execute(
                "UPDATE turn_events SET input=?2,directory=?3 WHERE id=?1",
                params![
                    id,
                    serde_json::to_string(&input).map_err(error)?,
                    artifacts.join(id.to_string()).to_string_lossy()
                ],
            )
            .map_err(error)?;
        for target in &targets {
            transaction
                .execute(
                    "INSERT INTO turn_deliveries (event,plugin_id,handler_id,target)
                VALUES (?1,?2,?3,?4)",
                    params![
                        id,
                        target.plugin_id,
                        target.handler_id,
                        serde_json::to_string(target).map_err(error)?
                    ],
                )
                .map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        Ok(TurnHookReceipt {
            event_id: input.event_id,
            sequence: input.sequence,
            queued_handlers: targets.len(),
        })
    }

    pub fn claim(
        &mut self,
        now: i64,
        owner: &str,
        plugins: &[String],
    ) -> Result<Option<Event>, String> {
        let plugins = serde_json::to_string(plugins).map_err(error)?;
        let transaction = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let query = format!(
            "{SCHEDULE} SELECT id,input,range_json,directory,state FROM due_events
            WHERE due<=?2 AND (owner IS NULL OR lease_until<=?2) ORDER BY id LIMIT 1"
        );
        let row: Option<(i64, String, Option<String>, String, String)> = transaction
            .query_row(&query, params![plugins, now], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .optional()
            .map_err(error)?;
        let Some((id, input, range, directory, state)) = row else {
            return Ok(None);
        };
        transaction
            .execute(
                "UPDATE turn_events SET owner=?2,lease_until=?3 WHERE id=?1",
                params![id, owner, now + LEASE_MS],
            )
            .map_err(error)?;
        let deliveries = {
            let query = format!(
                "{SCHEDULE} SELECT d.id,d.target FROM ready_deliveries r
                JOIN turn_deliveries d ON d.id=r.id
                WHERE r.event=?3 AND r.next_attempt<=?2 ORDER BY r.id"
            );
            let mut statement = transaction.prepare(&query).map_err(error)?;
            let rows = statement
                .query_map(params![plugins, now, id], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(error)?;
            rows.map(|row| {
                let (id, target) = row.map_err(error)?;
                Ok(Delivery {
                    id,
                    target: serde_json::from_str(&target).map_err(error)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?
        };
        transaction.commit().map_err(error)?;
        Ok(Some(Event {
            id,
            input: serde_json::from_str(&input).map_err(error)?,
            range: range
                .map(|value| serde_json::from_str(&value).map_err(error))
                .transpose()?,
            ready: state != "queued",
            directory: directory.into(),
            deliveries,
        }))
    }

    pub fn renew(&self, id: i64, owner: &str, now: i64) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_events SET lease_until=?3 WHERE id=?1 AND owner=?2",
            params![id, owner, now + LEASE_MS],
        )
    }

    pub fn release_owner(&self, owner: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE turn_events SET owner=NULL,lease_until=0 WHERE owner=?1",
                [owner],
            )
            .map_err(error)?;
        Ok(())
    }

    pub fn ready(&self, id: i64, owner: &str, input: &TurnCompletedInput) -> Result<(), String> {
        self.update_owned("UPDATE turn_events SET state='ready',input=?3,last_error=NULL WHERE id=?1 AND owner=?2",
            params![id,owner,serde_json::to_string(input).map_err(error)?])
    }

    pub fn released(&self, id: i64, owner: &str) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_events SET range_json=NULL WHERE id=?1 AND owner=?2",
            params![id, owner],
        )
    }

    pub fn acknowledge(&self, id: i64, event: i64, owner: &str) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_deliveries SET complete=1,last_error=NULL WHERE id=?1
            AND event=?2 AND EXISTS (SELECT 1 FROM turn_events WHERE id=?2 AND owner=?3)",
            params![id, event, owner],
        )
    }

    pub fn retry_delivery(
        &self,
        id: i64,
        event: i64,
        owner: &str,
        now: i64,
        message: &str,
    ) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_deliveries SET attempts=attempts+1,last_error=?5,
            next_attempt=?4+MIN(300000,1000*(1 << MIN(attempts,8))) WHERE id=?1 AND event=?2
            AND EXISTS (SELECT 1 FROM turn_events WHERE id=?2 AND owner=?3)",
            params![id, event, owner, now, message],
        )
    }

    pub fn retry_event(&self, id: i64, owner: &str, now: i64, message: &str) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_events SET attempts=attempts+1,last_error=?4,
            next_attempt=?3+MIN(300000,1000*(1 << MIN(attempts,8))),owner=NULL,lease_until=0
            WHERE id=?1 AND owner=?2",
            params![id, owner, now, message],
        )
    }

    pub fn finish(&mut self, id: i64, owner: &str) -> Result<bool, String> {
        let transaction = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let pending: Option<i64> = transaction
            .query_row(
                "SELECT MIN(next_attempt) FROM turn_deliveries
            WHERE event=?1 AND complete=0",
                [id],
                |row| row.get(0),
            )
            .map_err(error)?;
        let changed = if let Some(next) = pending {
            transaction.execute(
                "UPDATE turn_events SET next_attempt=?3,owner=NULL,lease_until=0
                WHERE id=?1 AND owner=?2",
                params![id, owner, next],
            )
        } else {
            transaction.execute(
                "UPDATE turn_events SET state='cleanup',last_error=NULL
                WHERE id=?1 AND owner=?2",
                params![id, owner],
            )
        }
        .map_err(error)?;
        if changed != 1 {
            return Err("Turn hook lease lost".to_owned());
        }
        transaction.commit().map_err(error)?;
        Ok(pending.is_none())
    }

    pub fn complete(&self, id: i64, owner: &str) -> Result<(), String> {
        self.update_owned(
            "UPDATE turn_events SET state='complete',input='{}',owner=NULL,lease_until=0
            WHERE id=?1 AND owner=?2 AND state='cleanup'",
            params![id, owner],
        )
    }

    #[cfg(test)]
    pub fn pending(&self) -> Result<usize, String> {
        self.db
            .query_row(
                "SELECT (SELECT COUNT(*) FROM turn_events WHERE state<>'complete')+
                    (SELECT COUNT(*) FROM discarded_turn_ranges)",
                [],
                |row| row.get(0),
            )
            .map_err(error)
    }

    pub fn deliverable(&self, plugins: &[String]) -> Result<usize, String> {
        let query = format!(
            "{SCHEDULE} SELECT (SELECT COUNT(*) FROM due_events)+
            (SELECT COUNT(*) FROM discarded_turn_ranges)"
        );
        self.db
            .query_row(
                &query,
                [serde_json::to_string(plugins).map_err(error)?],
                |row| row.get(0),
            )
            .map_err(error)
    }

    pub fn discarded_range(&self, now: i64) -> Result<Option<(String, GitTurnRange)>, String> {
        let serialized: Option<String> = self
            .db
            .query_row(
                "SELECT range_json FROM discarded_turn_ranges
            WHERE next_attempt<=?1 ORDER BY next_attempt LIMIT 1",
                [now],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        serialized
            .map(|value| Ok((value.clone(), serde_json::from_str(&value).map_err(error)?)))
            .transpose()
    }

    pub fn discard_released(&self, serialized: &str) -> Result<(), String> {
        self.db
            .execute(
                "DELETE FROM discarded_turn_ranges WHERE range_json=?1",
                [serialized],
            )
            .map_err(error)?;
        Ok(())
    }

    pub fn retry_discarded(&self, serialized: &str, now: i64) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE discarded_turn_ranges SET attempts=attempts+1,
            next_attempt=?2+MIN(300000,1000*(1 << MIN(attempts,8))) WHERE range_json=?1",
                params![serialized, now],
            )
            .map_err(error)?;
        Ok(())
    }

    pub fn next_due(&self, plugins: &[String]) -> Result<Option<i64>, String> {
        let query = format!(
            "{SCHEDULE} SELECT MIN(due) FROM (
            SELECT CASE WHEN owner IS NULL THEN due ELSE MAX(due,lease_until) END due
            FROM due_events
            UNION ALL SELECT next_attempt FROM discarded_turn_ranges)"
        );
        self.db
            .query_row(
                &query,
                [serde_json::to_string(plugins).map_err(error)?],
                |row| row.get(0),
            )
            .map_err(error)
    }

    fn update_owned(&self, sql: &str, params: impl rusqlite::Params) -> Result<(), String> {
        if self.db.execute(sql, params).map_err(error)? != 1 {
            return Err("Turn hook lease lost".to_owned());
        }
        Ok(())
    }
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
