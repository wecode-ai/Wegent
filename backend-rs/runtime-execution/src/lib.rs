// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Durable Runtime execution and project chat activity projections.

#![forbid(unsafe_code)]

use brz_mysql::{MysqlResult, MysqlTransaction};
use wegent_project_coordination::project_chat_message::Message;

use wegent_backend_persistence::sql_support;
use wegent_device_identity as device_identity;
use wegent_devices::device_online_state;
use wegent_project_coordination::{loop_tasks, project_chat_message, project_store};
use wegent_python_compat::json_compat;

pub mod device_reconcile;
pub mod execution_aggregate;
mod execution_intent;
pub mod runtime_projection;
pub mod workspace_cleanup_intents;

/// Issue state changes applied inside the Runtime observation transaction.
#[async_trait::async_trait]
pub trait ProjectionActivities<T: MysqlTransaction>: Send + Sync {
    async fn start(&self, tx: &mut T, message: &mut Message, owner: Option<i64>)
    -> MysqlResult<()>;

    async fn finish(
        &self,
        tx: &mut T,
        message: &mut Message,
        status: &str,
        detail: &str,
    ) -> MysqlResult<()>;
}

#[cfg(test)]
struct TestActivities;

#[cfg(test)]
#[async_trait::async_trait]
impl<T: MysqlTransaction> ProjectionActivities<T> for TestActivities {
    async fn start(&self, _: &mut T, _: &mut Message, _: Option<i64>) -> MysqlResult<()> {
        unreachable!("this fixture does not start an Issue activity")
    }

    async fn finish(&self, _: &mut T, _: &mut Message, _: &str, _: &str) -> MysqlResult<()> {
        unreachable!("this fixture does not finish an Issue activity")
    }
}
