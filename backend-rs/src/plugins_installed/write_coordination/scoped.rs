//! Device-independent installation leases and their shared parent CAS.

use super::*;
use serde_json::Value;

#[derive(FromMysqlRow)]
struct Installation {
    id: i64,
    name: String,
    json: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PluginRevision {
    pub(super) id: i64,
    pub(super) name: String,
    pub(super) revision: i64,
}

pub(crate) fn installation_write_revision(document: &Value) -> MysqlResult<i64> {
    if !document.is_object() || document.get("spec").is_some_and(|spec| !spec.is_object()) {
        return Err(coordination_error("plugin_write_conflict"));
    }
    match document.pointer("/spec/writeRevision") {
        None => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|value| *value >= 0 && *value < i64::MAX)
            .ok_or_else(|| coordination_error("plugin_write_conflict")),
    }
}

impl<'a, R: Redis> PluginWriteLease<'a, R> {
    pub(crate) async fn acquire_names(
        redis: Option<&'a R>,
        user_id: i64,
        names: Vec<String>,
    ) -> MysqlResult<Self> {
        Self::acquire_names_wait(redis, user_id, names, ACQUIRE_WAIT).await
    }

    pub(crate) async fn acquire_names_wait(
        redis: Option<&'a R>,
        user_id: i64,
        mut names: Vec<String>,
        wait: Duration,
    ) -> MysqlResult<Self> {
        let redis = redis.ok_or_else(|| coordination_error("plugin_write_unavailable"))?;
        names.sort();
        names.dedup();
        if names.is_empty() {
            names.push("@empty".to_owned());
        }
        let wait = if names.len() > 1 {
            Duration::ZERO
        } else {
            wait
        };
        let deadline = Instant::now() + wait;
        let mut acquired: Option<Self> = None;
        for name in names {
            let mut random = [0u8; 16];
            getrandom::getrandom(&mut random)
                .map_err(|_| coordination_error("plugin_write_unavailable"))?;
            let token = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let wait = deadline.saturating_duration_since(Instant::now());
            match Self::acquire_named_token(redis, user_id, &name, token, wait).await {
                Ok(lease) => {
                    if let Some(group) = acquired.as_mut() {
                        group.additional.push((lease.key, lease.token));
                    } else {
                        acquired = Some(lease);
                    }
                }
                Err(error) => {
                    if let Some(group) = acquired {
                        group.release().await;
                    }
                    return Err(error);
                }
            }
        }
        acquired.ok_or_else(|| coordination_error("plugin_write_conflict"))
    }

    pub(crate) fn include(&mut self, other: Self) {
        self.deadline = self.deadline.min(other.deadline);
        self.additional.push((other.key, other.token));
        self.additional.extend(other.additional);
        match (&mut self.installations, other.installations) {
            (Some(owned), Some(more)) => {
                owned.extend(more);
                owned.sort();
                owned.dedup();
            }
            _ => self.installations = None,
        }
    }

    pub(crate) fn for_installations(mut self, ids: Vec<i64>) -> Self {
        self.installations = Some(ids);
        self
    }

    pub(crate) fn installation_ids(&self) -> Option<&[i64]> {
        self.installations.as_deref()
    }

    pub(crate) fn owns_installation(&self, id: i64) -> bool {
        self.installations
            .as_ref()
            .is_none_or(|ids| ids.contains(&id))
    }

    pub(crate) async fn acquire_installed<M: Mysql>(
        mysql: &M,
        redis: Option<&'a R>,
        user_id: i64,
        ids: Option<&[i64]>,
    ) -> MysqlResult<Self> {
        let (names, ids) = mysql
            .with_transaction(async |tx| installation_scope(tx, user_id, ids).await)
            .await?;
        Ok(Self::acquire_names(redis, user_id, names)
            .await?
            .for_installations(ids))
    }

    pub(crate) async fn acquire_installed_on<T: MysqlTransaction>(
        tx: &mut T,
        redis: Option<&'a R>,
        user_id: i64,
        ids: &[i64],
    ) -> MysqlResult<Self> {
        let (names, ids) = installation_scope(tx, user_id, Some(ids)).await?;
        Ok(Self::acquire_names(redis, user_id, names)
            .await?
            .for_installations(ids))
    }

    pub(crate) async fn read_plugin_revisions<T: MysqlTransaction>(
        &self,
        tx: &mut T,
    ) -> MysqlResult<Vec<PluginRevision>> {
        let prefix = format!("wegent:plugin-write:{}:", self.user_id);
        let mut revisions = Vec::new();
        for key in std::iter::once(&self.key).chain(self.additional.iter().map(|(key, _)| key)) {
            let name = key
                .strip_prefix(&prefix)
                .ok_or_else(|| coordination_error("plugin_write_conflict"))?;
            if matches!(name, "@account-policy" | "@sync-init" | "@empty") {
                continue;
            }
            let rows: Vec<Installation> = tx.fetch_all(
                "SELECT id,name,json FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND name=?", (self.user_id, name),
            ).await?;
            if rows.is_empty() {
                return Err(coordination_error("plugin_write_conflict"));
            }
            for row in rows {
                if !self.owns_installation(row.id) {
                    continue;
                }
                revisions.push(PluginRevision {
                    id: row.id,
                    name: row.name,
                    revision: installation_write_revision(&row.json)?,
                });
            }
        }
        if self
            .installations
            .as_ref()
            .is_some_and(|ids| ids.len() != revisions.len())
        {
            return Err(coordination_error("plugin_write_conflict"));
        }
        self.verify_owned().await?;
        Ok(revisions)
    }

    pub(crate) async fn commit_plugin_revisions<T: MysqlTransaction>(
        &self,
        tx: &mut T,
        revisions: Vec<PluginRevision>,
    ) -> MysqlResult<()> {
        self.verify_owned().await?;
        for expected in revisions {
            let current: Installation = tx.fetch_optional(
                "SELECT id,name,json FROM kinds WHERE id=? AND user_id=? AND kind='InstalledPlugin' AND namespace='default'", (expected.id, self.user_id),
            ).await?.ok_or_else(|| coordination_error("plugin_write_conflict"))?;
            self.commit_plugin_revision(tx, expected, &current.name)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn commit_plugin_revision<T: MysqlTransaction>(
        &self,
        tx: &mut T,
        expected: PluginRevision,
        current_name: &str,
    ) -> MysqlResult<()> {
        self.verify_owned().await?;
        let updated = tx.execute(
                "UPDATE kinds SET json=JSON_SET(json,'$.spec.writeRevision',?),updated_at=NOW() WHERE id=? AND user_id=? AND kind='InstalledPlugin' AND namespace='default' AND name=? AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.writeRevision')) AS SIGNED),0)=?",
                (expected.revision+1, expected.id, self.user_id, current_name, expected.revision),
            ).await?;
        if updated.rows_affected != 1 {
            return Err(coordination_error("plugin_write_conflict"));
        }
        Ok(())
    }
}

async fn installation_scope<T: MysqlTransaction>(
    tx: &mut T,
    user_id: i64,
    ids: Option<&[i64]>,
) -> MysqlResult<(Vec<String>, Vec<i64>)> {
    if ids.is_some_and(<[i64]>::is_empty) {
        return Ok((Vec::new(), Vec::new()));
    }
    let rows: Vec<Installation> = tx.fetch_all("SELECT id,name,json FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default'", (user_id,)).await?;
    Ok(rows
        .into_iter()
        .filter(|row| ids.is_none_or(|ids| ids.contains(&row.id)))
        .map(|row| (row.name, row.id))
        .unzip())
}
