//! Background retention reads indexed facts and references, never historical JSON payloads.
use super::*;

const CLEANUP_BATCH: usize = 100;
const COMMIT_BATCH: usize = 25;
const MAX_COMMITS: usize = 4;
const CLEANUP_BUDGET: Duration = Duration::from_millis(100);
const EXPIRED: &str = "l.resource_type IN ('stand_in_event','stand_in_action','stand_in_route')
    AND julianday(l.updated_at) < julianday(?1)";

#[cfg(test)]
#[path = "stand_in_retention_tests.rs"]
mod tests;

enum HistoryChange {
    Delete(String),
    Compact(String, String),
}

impl LocalTaskStore {
    /// Maintenance never initializes a database or waits for a foreground writer.
    pub fn maintain_stand_in_history(path: &Path) -> Result<usize, TaskRuntimeError> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::ZERO)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        Self::prune_stand_in_history(&connection, Utc::now(), CLEANUP_BUDGET)
    }

    fn prune_stand_in_history(
        connection: &Connection,
        at: chrono::DateTime<Utc>,
        budget: Duration,
    ) -> Result<usize, TaskRuntimeError> {
        let started = std::time::Instant::now();
        let mut changed = 0;
        let result = Self::prune_history_pass(connection, at, started, budget, &mut changed);
        if started.elapsed() > budget && !budget.is_zero() {
            crate::logging::log_executor_event(
                "stand-in history maintenance yielded after budget",
                &[
                    ("elapsed_ms", started.elapsed().as_millis().to_string()),
                    ("records", changed.to_string()),
                ],
            );
        }
        result.map(|()| changed)
    }

    fn prune_history_pass(
        connection: &Connection,
        at: chrono::DateTime<Utc>,
        started: std::time::Instant,
        budget: Duration,
        changed: &mut usize,
    ) -> Result<(), TaskRuntimeError> {
        let mut kinds = ["stand_in_action", "stand_in_route", "stand_in_event"]
            .into_iter().map(|kind| {
                let cursor = connection.query_row(
                    "SELECT updated_jd,item_id,checked_at FROM stand_in_retention_cursor WHERE resource_type=?1",
                    [kind], |row| Ok((row.get::<_, f64>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?)),
                ).optional()?.unwrap_or((0.0,String::new(),String::new()));
                Ok((kind,cursor))
            }).collect::<Result<Vec<_>,rusqlite::Error>>()?;
        kinds.sort_by(|a, b| a.1 .2.cmp(&b.1 .2));
        let mut scanned = 0;
        let mut commits = 0;
        for (kind, (jd, id, _)) in kinds {
            if started.elapsed() >= budget || scanned >= CLEANUP_BATCH || commits >= MAX_COMMITS {
                break;
            }
            let rows = {
                let mut query = connection.prepare(
                    "SELECT id,julianday(updated_at) FROM loop_items
                     WHERE resource_type IN ('stand_in_event','stand_in_action','stand_in_route')
                       AND resource_type=?1 AND julianday(updated_at)<julianday(?2)
                       AND (julianday(updated_at),id)>(?3,?4)
                     ORDER BY julianday(updated_at),id LIMIT ?5",
                )?;
                let rows = query
                    .query_map(
                        params![
                            kind,
                            (at - chrono::Duration::days(7)).to_rfc3339(),
                            jd,
                            id,
                            CLEANUP_BATCH - scanned
                        ],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            if rows.is_empty() {
                Self::save_retention_cursor(connection, kind, 0.0, "", at)?;
                commits += 1;
            }
            for chunk in rows.chunks(COMMIT_BATCH) {
                // The deadline is a scheduling budget, not a transaction timeout:
                // never roll back completed work simply because one chunk ran long.
                if started.elapsed() >= budget || commits >= MAX_COMMITS {
                    break;
                }
                let (tx, changes) = Self::plan_history_chunk(connection, at, chunk)?;
                let count = Self::apply_history_changes(&tx, changes)?;
                let (id, jd) = chunk.last().expect("nonempty retention chunk");
                Self::save_retention_cursor(&tx, kind, *jd, id, at)?;
                tx.commit()?;
                *changed += count;
                scanned += chunk.len();
                commits += 1;
            }
        }
        Ok(())
    }

    fn plan_history_chunk<'store>(
        connection: &'store Connection,
        at: chrono::DateTime<Utc>,
        chunk: &[(String, f64)],
    ) -> Result<(rusqlite::Transaction<'store>, Vec<HistoryChange>), TaskRuntimeError> {
        // Candidates were scanned without a writer. Admit this bounded chunk
        // before checking references so unrelated WAL commits cannot invalidate
        // its read snapshot during promotion. The maintenance connection never waits.
        let tx = rusqlite::Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
        let mut changes = Vec::new();
        for (id, _) in chunk {
            if let Some(change) = Self::plan_history_record(&tx, at, id)? {
                changes.push(change);
            }
        }
        Ok((tx, changes))
    }

    fn save_retention_cursor(
        connection: &Connection,
        kind: &str,
        jd: f64,
        id: &str,
        at: chrono::DateTime<Utc>,
    ) -> Result<(), TaskRuntimeError> {
        connection.execute(
            "INSERT INTO stand_in_retention_cursor(resource_type,updated_jd,item_id,checked_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(resource_type) DO UPDATE SET updated_jd=excluded.updated_jd,item_id=excluded.item_id,checked_at=excluded.checked_at",
            params![kind,jd,id,at.to_rfc3339()],
        )?;
        Ok(())
    }

    fn plan_history_record(
        tx: &Connection,
        at: chrono::DateTime<Utc>,
        id: &str,
    ) -> Result<Option<HistoryChange>, TaskRuntimeError> {
        let cutoff = (at - chrono::Duration::days(7)).to_rfc3339();
        // Legacy rows have no indexed facts. The owner explicitly chose expiry
        // rather than parsing/backfilling their historical payloads.
        let mut deletable = tx.query_row(
            &format!(
                "SELECT EXISTS (
               SELECT l.id FROM loop_items l WHERE {EXPIRED} AND l.id=?2
               AND NOT EXISTS (SELECT 1 FROM stand_in_history h WHERE h.id=l.id) )"
            ),
            params![cutoff, id],
            |row| row.get::<_, bool>(0),
        )?;
        deletable |= tx.query_row(&format!(
            "SELECT EXISTS (
               SELECT l.id FROM loop_items l JOIN stand_in_history h ON h.id=l.id
               WHERE {EXPIRED} AND l.id=?2 AND h.resource_type='stand_in_action'
               AND h.status IN ('succeeded','failed','cancelled') AND h.kind!='run_arrangement'
               AND NOT EXISTS (SELECT 1 FROM stand_in_history s
                 WHERE s.user_id=h.user_id AND s.resource_type='stand_in_processing' AND s.batch_id=h.batch_id)
               AND NOT EXISTS (SELECT 1 FROM stand_in_history s
                 WHERE s.user_id=h.user_id AND s.resource_type='stand_in_processing' AND s.error_command_id=h.id)
               AND NOT EXISTS (
                 SELECT 1 FROM stand_in_history_refs r JOIN stand_in_history e ON e.id=r.event_id
                 WHERE r.owner_id=h.id AND e.user_id=h.user_id AND e.resource_type='stand_in_event' AND e.status='pending'
                 AND NOT EXISTS (
                   SELECT 1 FROM stand_in_history_refs newer_ref
                   JOIN stand_in_history newer ON newer.id=newer_ref.owner_id
                   JOIN loop_items newer_item ON newer_item.id=newer.id
                   WHERE newer_ref.event_id=e.id AND newer.user_id=h.user_id
                     AND newer.resource_type='stand_in_action' AND newer.status='failed' AND newer.kind=h.kind
                     AND (newer_item.created_at>l.created_at OR (newer_item.created_at=l.created_at AND newer.id>h.id))
                 ) AND h.status='failed'
               ) )"
        ), params![cutoff, id], |row| row.get::<_,bool>(0))?;
        deletable |= tx.query_row(&format!(
            "SELECT EXISTS (
               SELECT l.id FROM loop_items l JOIN stand_in_history h ON h.id=l.id
               WHERE {EXPIRED} AND l.id=?2 AND h.resource_type='stand_in_route'
               AND NOT EXISTS (SELECT 1 FROM stand_in_history a WHERE a.user_id=h.user_id
                 AND a.resource_type IN ('stand_in_action','stand_in_processing') AND a.batch_id=h.batch_id)
               AND NOT EXISTS (SELECT 1 FROM stand_in_history s WHERE s.user_id=h.user_id
                 AND s.resource_type='stand_in_processing' AND s.router_batch_id=h.batch_id) )"
        ), params![cutoff, id], |row| row.get::<_,bool>(0))?;
        if deletable {
            return Ok(Some(HistoryChange::Delete(id.to_owned())));
        }
        let events = {
            let mut query = tx.prepare(&format!(
                "SELECT h.id,h.user_id,h.status,h.event_created_at FROM loop_items l
                 JOIN stand_in_history h ON h.id=l.id WHERE {EXPIRED} AND l.id=?2
                 AND h.resource_type='stand_in_event' AND h.status IN ('handled','cancelled','migrated') AND h.compacted=0
                 AND NOT EXISTS (SELECT 1 FROM stand_in_history_refs r
                   JOIN stand_in_history owner ON owner.id=r.owner_id
                   WHERE r.event_id=h.id AND owner.user_id=h.user_id
                     AND owner.resource_type IN ('stand_in_action','stand_in_processing')) "
            ))?;
            let rows = query
                .query_map(params![cutoff, id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        if let Some((id, user, status, created_at)) = events.into_iter().next() {
            let marker = json!({"id":id,"userId":user,"status":status,"createdAt":created_at,"roleScoped":true,"compacted":true});
            return Ok(Some(HistoryChange::Compact(id, marker.to_string())));
        }
        Ok(None)
    }

    fn apply_history_changes(
        tx: &Connection,
        changes: Vec<HistoryChange>,
    ) -> Result<usize, TaskRuntimeError> {
        let mut deletes = Vec::new();
        let mut compactions = Vec::new();
        for change in changes {
            match change {
                HistoryChange::Delete(id) => deletes.push(id),
                HistoryChange::Compact(id, marker) => compactions.push((id, marker)),
            }
        }
        let mut changed = 0;
        if !deletes.is_empty() {
            let placeholders = vec!["?"; deletes.len()].join(",");
            changed += tx.execute(
                &format!("DELETE FROM loop_items WHERE id IN ({placeholders})"),
                rusqlite::params_from_iter(&deletes),
            )?;
        }
        let mut update = tx.prepare_cached("UPDATE loop_items SET metadata=?2 WHERE id=?1")?;
        let mut compact =
            tx.prepare_cached("UPDATE stand_in_history SET compacted=1 WHERE id=?1")?;
        for (id, marker) in compactions {
            changed += update.execute(params![id, marker])?;
            compact.execute([id])?;
        }
        Ok(changed)
    }
}
