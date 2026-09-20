// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Application extension for optional employee identities and group membership.
use async_trait::async_trait;

use crate::erp_types::EmployeeInfo;

/// Provider contract for an optional employee directory.
///
/// The standalone application leaves the extension unconfigured. Applications
/// with a directory can supply an implementation at startup.
#[async_trait]
pub trait ErpProvider<R: brz_redis::Redis = brz_redis::RedisService>: Send + Sync {
    /// Read an employee identifier from the configured directory.
    async fn employee_id(&self, _user_id: i64) -> brz_mysql::MysqlResult<Option<String>> {
        Ok(None)
    }

    /// Resolve an employee identity, refreshing the stored profile if needed.
    async fn resolve_employee_id(
        &self,
        _redis: Option<&R>,
        user_id: i32,
    ) -> brz_mysql::MysqlResult<Option<String>> {
        self.employee_id(i64::from(user_id)).await
    }

    /// Read already-cached department membership without an upstream request.
    async fn cached_membership(
        &self,
        _redis: Option<&R>,
        _user_id: i64,
        _ssn: &str,
        _dept_ids: &[String],
    ) -> Vec<String> {
        Vec::new()
    }

    /// Check which departments the employee belongs to. Implementations own
    /// their cache and directory access. Returns a subset of `dept_ids`.
    async fn membership_with_cache(
        &self,
        redis: Option<&R>,
        user_id: i32,
        ssn: &str,
        dept_ids: &[String],
    ) -> Vec<String>;

    /// Search for an employee by keyword. The default returns `None`.
    async fn search_employee(&self, keyword: &str) -> Option<EmployeeInfo>;

    /// Entity type exposed by this directory provider. Open-source builds
    /// return `None`; private deployments register their concrete entity type
    /// (such as a department) through the permissions registry.
    fn entity_type(&self) -> Option<&'static str> {
        None
    }

    /// Whether an external directory is configured.
    #[allow(dead_code, reason = "used by future open-source build / callers")]
    fn configured(&self) -> bool {
        false
    }
}

/// Standalone provider when no external employee directory is configured.
#[allow(dead_code, reason = "injected by the future open-source build")]
pub struct NoopErpProvider;

#[async_trait]
impl<R: brz_redis::Redis> ErpProvider<R> for NoopErpProvider {
    async fn membership_with_cache(
        &self,
        _redis: Option<&R>,
        _user_id: i32,
        _ssn: &str,
        _dept_ids: &[String],
    ) -> Vec<String> {
        Vec::new()
    }

    async fn search_employee(&self, _keyword: &str) -> Option<EmployeeInfo> {
        None
    }
}
