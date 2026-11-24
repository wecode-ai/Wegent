// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Claims due rules and incoming events, admits runs, then dispatches after commit.

use anyhow::Result;
use brz_mysql::MysqlService;
use serde_json::Value;
use std::sync::Arc;
use wegent_identity::auth::AppAuthenticator;
use wegent_project_coordination::project_issues::IssueStore;
use wegent_project_coordination::project_store::{self as store, Node};

mod dispatch;
mod due;
mod events;
mod incoming;
mod incoming_hooks;

pub use due::{check, permits_scheduled_run};
pub use events::AutomationEvent;
pub use incoming::{pending, process};

pub struct Scheduler<'a> {
    pub mysql: &'a MysqlService,
    pub credential_key: &'a str,
    pub host: &'a dyn AutomationHost,
}

impl Scheduler<'_> {
    fn issue_store(&self) -> IssueStore<'_> {
        IssueStore {
            mysql: self.mysql,
            credential_key: self.credential_key,
        }
    }
}

pub enum AssignmentTarget {
    Human(i64),
    Agent(Box<Node>),
    Team(i64),
}

pub enum DispatchStatus<'a> {
    Failed(&'a str),
    Skipped(&'a str),
}

#[async_trait::async_trait]
pub trait AutomationHost: Sync {
    async fn assign(
        &self,
        project: &Node,
        rule: &Node,
        run: &Node,
        target: AssignmentTarget,
        context: Value,
        instructions: &str,
    ) -> Result<()>;

    async fn assign_group(
        &self,
        project: &Node,
        rule: &Node,
        run: &Node,
        group_id: &str,
        context: Value,
    ) -> Result<()>;

    async fn finish_dispatch(&self, run_id: &str, status: DispatchStatus<'_>) -> Result<()>;

    async fn continue_task(
        &self,
        binding: &Node,
        prompt: &str,
        selection: Option<&Value>,
    ) -> Result<()>;

    async fn wake_robot(&self) -> Result<()>;
}

brz_http_server::registry!(
    group = project_scheduler_ingress,
    dependencies(mysql: Arc<MysqlService>),
    auth = AppAuthenticator
);

pub fn routes(
    mysql: Arc<MysqlService>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(mysql = mysql; group = project_scheduler_ingress)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_project_scheduler_ingress::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
