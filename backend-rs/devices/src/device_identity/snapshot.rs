// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request-local owned-device resolution with one database read.
use super::{DeviceKindRow, canonical_device_id, record_id_from_route, resolve_device_alias};
use crate::sql_support::StatementArg;
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;

#[derive(FromMysqlRow)]
struct SnapshotDeviceRow {
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_json")]
    json: serde_json::Value,
}

/// A snapshot is scoped to this request and partitioned by device owner.
#[derive(Default)]
pub struct DeviceIdentitySnapshot {
    devices_by_user: HashMap<i64, Vec<DeviceKindRow>>,
    identities: HashMap<(i64, String), String>,
}

impl DeviceIdentitySnapshot {
    pub async fn load<M: Mysql>(mysql: &M, identities: Vec<(i64, String)>) -> MysqlResult<Self> {
        let mut scopes: BTreeMap<i64, Option<BTreeSet<i64>>> = BTreeMap::new();
        for (user, submitted) in identities {
            let submitted = submitted.trim();
            if submitted.is_empty() {
                continue;
            }
            let scope = scopes.entry(user).or_insert_with(|| Some(BTreeSet::new()));
            if let Some(ids) = scope {
                match record_id_from_route(submitted) {
                    Some(id) => {
                        ids.insert(id);
                    }
                    None => *scope = None,
                }
            }
        }
        if scopes.is_empty() {
            return Ok(Self::default());
        }
        let mut clauses = Vec::new();
        let mut arguments = Vec::new();
        for (user, ids) in scopes {
            arguments.push(StatementArg::Int(user));
            let mut clause = "kinds.user_id = ?".to_string();
            if let Some(ids) = ids {
                let placeholders = vec!["?"; ids.len()].join(", ");
                clause.push_str(&format!(" AND kinds.id IN ({placeholders})"));
                arguments.extend(ids.into_iter().map(StatementArg::Int));
            }
            clauses.push(format!("({clause})"));
        }
        let sql = format!(
            "SELECT kinds.user_id AS kinds_user_id, kinds.id AS kinds_id, \
             kinds.name AS kinds_name, kinds.json AS kinds_json FROM kinds \
             WHERE ({}) AND kinds.kind = 'Device' \
             AND kinds.namespace = 'default' AND kinds.is_active = true",
            clauses.join(" OR ")
        );
        let rows: Vec<SnapshotDeviceRow> = mysql.fetch_all(sql, arguments).await?;
        let mut snapshot = Self::default();
        for row in rows {
            snapshot
                .devices_by_user
                .entry(row.user_id)
                .or_default()
                .push(DeviceKindRow {
                    id: row.id,
                    name: row.name,
                    json: row.json,
                });
        }
        Ok(snapshot)
    }

    /// Cache misses as well as resolved aliases; a repeated unknown ID is cheap.
    pub fn resolve(&mut self, user_id: i64, device_id: &str) -> String {
        let key = (user_id, device_id.to_string());
        self.identities
            .entry(key)
            .or_insert_with(|| {
                let devices = self
                    .devices_by_user
                    .get(&user_id)
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                resolve_device_alias(devices, device_id)
                    .map(canonical_device_id)
                    .unwrap_or_else(|| device_id.trim().to_string())
            })
            .clone()
    }

    pub fn device_count(&self) -> usize {
        self.devices_by_user.values().map(Vec::len).sum()
    }
}
