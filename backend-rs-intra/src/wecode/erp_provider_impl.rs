//! Private ERP implementation using the shared application clients.
use async_trait::async_trait;

use crate::wecode::erp::ErpClient;
use wegent_backend_rs::erp_provider::ErpProvider;
use wegent_backend_rs::erp_types::EmployeeInfo;

/// Wrap the real `ErpClient` as an [`ErpProvider`].
pub struct ErpClientProvider<M: brz_mysql::Mysql> {
    pub client: ErpClient,
    pub mysql: M,
}

#[async_trait]
impl<R: brz_redis::Redis> ErpProvider<R> for ErpClientProvider<brz_mysql::MysqlService> {
    async fn employee_id(&self, user_id: i64) -> brz_mysql::MysqlResult<Option<String>> {
        super::employee_profiles::employee_id(&self.mysql, user_id).await
    }
    async fn resolve_employee_id(
        &self,
        redis: Option<&R>,
        user_id: i32,
    ) -> brz_mysql::MysqlResult<Option<String>> {
        super::employee_sync::resolve_employee_id(&self.mysql, redis, self, user_id).await
    }
    async fn cached_membership(
        &self,
        redis: Option<&R>,
        user_id: i64,
        ssn: &str,
        dept_ids: &[String],
    ) -> Vec<String> {
        super::employee_cache::cached_membership(redis, user_id, ssn, dept_ids).await
    }

    async fn membership_with_cache(
        &self,
        redis: Option<&R>,
        user_id: i32,
        ssn: &str,
        dept_ids: &[String],
    ) -> Vec<String> {
        self.client
            .membership_with_cache(redis, user_id, ssn, dept_ids)
            .await
    }

    async fn search_employee(&self, keyword: &str) -> Option<EmployeeInfo> {
        self.client.search_employee(keyword).await
    }

    fn configured(&self) -> bool {
        self.client.configured()
    }

    fn entity_type(&self) -> Option<&'static str> {
        Some("org_department")
    }
}
