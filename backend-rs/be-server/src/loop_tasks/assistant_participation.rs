use crate::{http_compat::FastApiError, state::AppState};
use std::sync::Arc;
use wegent_project_participation::{ParticipationState, ParticipationSupport};

struct GatewayParticipation(Arc<AppState>);

#[async_trait::async_trait]
impl ParticipationSupport for GatewayParticipation {
    async fn active_owner(&self, task_id: i64) -> brz_mysql::MysqlResult<Option<i64>> {
        Ok(
            wegent_task_views::task_detail_api::repository::get_active_non_deleted_task(
                self.0.task_store.as_ref(),
                task_id,
                None,
            )
            .await?
            .map(|task| task.user_id),
        )
    }

    async fn ensure_issue_shadow(&self, item_id: &str, user_id: i32) -> Result<(), FastApiError> {
        super::assignments::ensure_shadow(&self.0, item_id, user_id).await
    }

    async fn require_issue_read(&self, item_id: &str, user_id: i32) -> Result<(), FastApiError> {
        super::assignments::require_issue_read_for_user(&self.0, item_id, user_id).await
    }
}

impl AppState {
    pub(crate) fn participation_state(self: &Arc<Self>) -> ParticipationState {
        ParticipationState {
            mysql: self.mysql.clone(),
            redis: self.redis.clone(),
            local_emit: Arc::new(crate::background_jobs::project::notifications::GatewayEmit),
            support: Arc::new(GatewayParticipation(Arc::clone(self))),
        }
    }
}

#[cfg(test)]
mod mysql_tests {
    #[tokio::test]
    #[ignore = "requires disposable loopback MySQL; invoked by Backend Rust CI"]
    async fn reads_execution_sources_from_the_deployed_schema() -> anyhow::Result<()> {
        crate::migrations::mysql_tests::isolated(async |mysql| {
            crate::migrations::mysql_tests::seed_collaboration(mysql).await?;
            wegent_project_participation::test_support::assert_execution_sources(mysql).await
        })
        .await
    }
}
