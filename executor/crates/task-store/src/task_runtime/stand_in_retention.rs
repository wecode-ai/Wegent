//! Bounded, best-effort retention using only independent type and time columns.
use super::*;

const CLEANUP_BATCH: usize = 100;
const CLEANUP_BUDGET: Duration = Duration::from_millis(100);

#[cfg(test)]
#[path = "stand_in_retention_tests.rs"]
mod tests;

impl LocalTaskStore {
    /// Maintenance never creates/migrates a database or waits for a foreground writer.
    pub fn maintain_stand_in_history(path: &Path) -> Result<usize, TaskRuntimeError> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::ZERO)?;
        Self::prune_stand_in_history(&connection, Utc::now(), CLEANUP_BUDGET)
    }

    fn prune_stand_in_history(
        connection: &Connection,
        at: chrono::DateTime<Utc>,
        budget: Duration,
    ) -> Result<usize, TaskRuntimeError> {
        let started = std::time::Instant::now();
        connection.progress_handler(1000, Some(move || started.elapsed() >= budget));
        // One atomic statement bounds total deletions across all users and types.
        // Do not inspect metadata: every expired record follows the same policy.
        // julianday accepts both legacy SQLite timestamps and RFC3339 timestamps.
        let result = connection.execute(
            "DELETE FROM loop_items WHERE id IN (
               SELECT id FROM loop_items
               WHERE resource_type IN ('stand_in_event','stand_in_action','stand_in_route')
                 AND julianday(updated_at) < julianday(?1)
               LIMIT ?2
             )",
            params![(at - chrono::Duration::days(7)).to_rfc3339(), CLEANUP_BATCH],
        );
        // SQLite rolls back the statement on interruption. Remove the deadline
        // before this connection can be reused for foreground work.
        connection.progress_handler(0, None::<fn() -> bool>);
        Ok(result?)
    }
}
