// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Read-only evidence for rejected runner selections, without credential data.

use super::authority;
use crate::plugins_marketplace::query::PluginQuery;
use crate::sql_support::id_in_clause;
use anyhow::Result;
use brz_mysql::FromMysqlRow;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(FromMysqlRow, Serialize)]
struct Grant {
    id: i64,
    device_id: i64,
    scope: String,
    scope_id: String,
    role: String,
    status: String,
}

#[derive(FromMysqlRow, Serialize)]
struct Device {
    id: i64,
    kind: String,
    namespace: String,
    is_active: bool,
    owner_user_id: i64,
}

pub(super) struct EnvironmentDenial<'a> {
    pub project_id: &'a str,
    pub issue_id: &'a str,
    pub agent_id: &'a str,
    pub user_id: i64,
    pub policy: &'a Value,
    pub policy_source: &'a str,
    pub authorized_ids: &'a BTreeSet<i64>,
}

impl EnvironmentDenial<'_> {
    pub(super) async fn record(self, query: &mut impl PluginQuery) {
        let evidence = self.evidence(query).await;
        tracing::warn!(
            event = "runner_environment_denied",
            evidence = %evidence,
            "Runner routing denial"
        );
    }

    async fn evidence(&self, query: &mut impl PluginQuery) -> Value {
        let mut evidence = json!({
            "event": "runner_environment_denied",
            "phase": "execution",
            "project_id": self.project_id,
            "issue_id": self.issue_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
            "execution_policy": {
                "mode": match self.policy["mode"].as_str() {
                    Some("fixed") => "fixed",
                    Some("project_pool") => "project_pool",
                    _ => "invalid",
                },
                "environment_id": authority::integer(&self.policy["environment_id"]),
            },
            "policy_source": self.policy_source,
            "authorized_environment_ids": self.authorized_ids,
        });
        match self.details(query).await {
            Ok(details) => evidence.as_object_mut().unwrap().extend(details),
            // Diagnostic reads must never replace the original routing error.
            Err(_) => evidence["diagnostic_lookup_failed"] = json!(true),
        }
        evidence
    }

    async fn details(
        &self,
        query: &mut impl PluginQuery,
    ) -> Result<serde_json::Map<String, Value>> {
        let workspace_id = authority::parent_on(query, self.project_id).await?;
        let grants: Vec<Grant> = query
            .fetch_all(
                "SELECT id,resource_id AS device_id,entity_type AS scope,entity_id AS scope_id,\
                 `role`,status FROM resource_members WHERE resource_type='Device' \
                 AND ((entity_type='workspace' AND entity_id=?) \
                 OR (entity_type='project' AND entity_id=?)) ORDER BY id",
                (workspace_id.to_string(), self.project_id),
            )
            .await?;
        let mut ids = self.authorized_ids.clone();
        ids.extend(grants.iter().map(|grant| grant.device_id));
        ids.extend(authority::integer(&self.policy["environment_id"]));
        let (clause, args) = id_in_clause("id", &ids.into_iter().collect::<Vec<_>>());
        let devices: Vec<Device> = query
            .fetch_all(
                format!(
                    "SELECT id,kind,namespace,is_active,user_id AS owner_user_id \
                     FROM kinds WHERE {clause} ORDER BY id"
                ),
                args,
            )
            .await?;
        Ok(serde_json::Map::from_iter([
            ("workspace_id".into(), json!(workspace_id)),
            ("grants".into(), json!(grants)),
            ("devices".into(), json!(devices)),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::mysql_rows::{Row, Value as Col};
    use crate::sql_test_support::{KindQueryCapture, mysql_rows::MysqlRows};

    fn grant(scope: &str, role: &str, status: &str) -> Row {
        vec![
            ("id", Col::I64(1)),
            ("device_id", Col::I64(42)),
            ("scope", Col::Text(scope.into())),
            ("scope_id", Col::Text("7".into())),
            ("role", Col::Text(role.into())),
            ("status", Col::Text(status.into())),
        ]
    }

    #[tokio::test]
    async fn denied_grants_and_inactive_devices_remain_visible_without_secrets() {
        let database = MysqlRows::start_results(|sql| {
            if sql.contains("AS workspace_id") {
                let row = vec![("workspace_id", Col::I64(7))];
                return (row.clone(), vec![row]);
            }
            if sql.contains("FROM resource_members WHERE resource_type='Device'") {
                let rows = vec![
                    grant("workspace", "Viewer", "approved"),
                    grant("project", "Developer", "pending"),
                ];
                return (rows[0].clone(), rows);
            }
            assert!(sql.contains("FROM kinds WHERE id IN (?, ?)"), "{sql}");
            assert!(
                !sql.contains("json"),
                "device configurations must not be read"
            );
            let row = vec![
                ("id", Col::I64(42)),
                ("kind", Col::Text("Device".into())),
                ("namespace", Col::Text("other".into())),
                ("is_active", Col::I8(0)),
                ("owner_user_id", Col::I64(86)),
            ];
            (row.clone(), vec![row])
        })
        .await;
        let policy = json!({"mode":"fixed","environment_id":"42","api_key":"DO-NOT-LOG"});
        let authorized = BTreeSet::from([99]);
        let evidence = EnvironmentDenial {
            project_id: "project-1",
            issue_id: "issue-42",
            agent_id: "agent-1",
            user_id: 86,
            policy: &policy,
            policy_source: "personal_default",
            authorized_ids: &authorized,
        }
        .evidence(&mut &database.mysql)
        .await;

        assert_eq!(evidence["execution_policy"]["environment_id"], 42);
        assert_eq!(evidence["authorized_environment_ids"], json!([99]));
        assert_eq!(evidence["workspace_id"], 7);
        assert_eq!(evidence["issue_id"], "issue-42");
        assert_eq!(evidence["policy_source"], "personal_default");
        assert_eq!(evidence["grants"][0]["role"], "Viewer");
        assert_eq!(evidence["grants"][1]["status"], "pending");
        assert_eq!(evidence["devices"][0]["namespace"], "other");
        assert_eq!(evidence["devices"][0]["is_active"], false);
        assert!(!evidence.to_string().contains("DO-NOT-LOG"));
        assert_eq!(database.queries().len(), 3);
    }

    #[tokio::test]
    async fn failed_diagnostic_reads_preserve_the_routing_context() {
        let database = KindQueryCapture::failing_reads();
        let policy = json!({"mode":"fixed","environment_id":"42"});
        let authorized = BTreeSet::new();
        let evidence = EnvironmentDenial {
            project_id: "project-1",
            issue_id: "issue-42",
            agent_id: "agent-1",
            user_id: 86,
            policy: &policy,
            policy_source: "fixed",
            authorized_ids: &authorized,
        }
        .evidence(&mut &database)
        .await;

        assert_eq!(evidence["event"], "runner_environment_denied");
        assert_eq!(evidence["execution_policy"]["environment_id"], 42);
        assert_eq!(evidence["diagnostic_lookup_failed"], true);
        assert_eq!(database.queries().len(), 1);
        assert!(database.writes().is_empty());
    }
}
