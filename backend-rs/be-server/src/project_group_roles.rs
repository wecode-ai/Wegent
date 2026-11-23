// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::state::AppState;

pub(crate) struct ProjectGroupRoles {
    mysql: brz_mysql::MysqlService,
    redis: Option<brz_redis::RedisService>,
    resolvers: crate::permissions::EntityResolvers,
}

impl ProjectGroupRoles {
    pub(crate) fn new(app: &AppState) -> Self {
        Self {
            mysql: app.mysql.clone(),
            redis: app.redis.clone(),
            resolvers: app.entity_resolvers.clone(),
        }
    }
}

#[async_trait::async_trait]
impl wegent_project_coordination::TeamGroupRoles for ProjectGroupRoles {
    async fn effective_role(
        &self,
        user_id: i64,
        namespace: &str,
    ) -> brz_mysql::MysqlResult<Option<String>> {
        crate::knowledge_bases_all_grouped::membership::effective_role_in_group(
            &self.mysql,
            self.redis.as_ref(),
            &self.resolvers,
            user_id,
            namespace,
        )
        .await
    }
}
