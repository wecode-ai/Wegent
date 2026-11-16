// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Admission only: never publish a journal, rewrite metadata, or update SQLite.
/// Call while holding a shared Home process lease that excludes migration.
pub(crate) fn is_current(home: &Path) -> Result<bool, String> {
    let path = home.join(JOURNAL);
    reject_link(&path)?;
    let (journal, compacted) = journal::load(&path)?;
    if compacted || !journal.complete {
        return Ok(false);
    }
    let (additions, threads) = scan_rollouts(home, &journal)?;
    if !additions.is_empty() {
        return Ok(false);
    }
    for database in open_databases(home, OpenFlags::SQLITE_OPEN_READ_ONLY)? {
        let mut statement = database
            .prepare("SELECT id FROM threads WHERE model_provider IS NOT ?1")
            .map_err(error)?;
        let rows = statement
            .query_map([ROUTER], |row| row.get::<_, String>(0))
            .map_err(error)?;
        for id in rows {
            if threads.contains(&id.map_err(error)?) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}
