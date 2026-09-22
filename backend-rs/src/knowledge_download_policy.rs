// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Open-source knowledge document download decision and extension contract.

use async_trait::async_trait;
use brz_mysql::{MysqlResult, MysqlService};

/// Allows a deployment to apply its own original-document policy after the
/// knowledge-base access check has succeeded.
#[async_trait]
pub trait DocumentDownloadPolicy: Send + Sync {
    async fn original_download_allowed(
        &self,
        mysql: &MysqlService,
        namespace: &str,
        configured: Option<bool>,
    ) -> MysqlResult<bool>;
}

/// Source `app.services.knowledge.document_download_policy`: only an
/// explicit `allowDocumentDownload: false` disables original downloads.
pub struct DefaultDocumentDownloadPolicy;

#[async_trait]
impl DocumentDownloadPolicy for DefaultDocumentDownloadPolicy {
    async fn original_download_allowed(
        &self,
        _mysql: &MysqlService,
        _namespace: &str,
        configured: Option<bool>,
    ) -> MysqlResult<bool> {
        Ok(configured.unwrap_or(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_policy_allows_missing_and_null_and_respects_explicit_false() {
        let mysql = MysqlService::connect_lazy("mysql://user:pw@127.0.0.1:1/test").unwrap();
        let policy = DefaultDocumentDownloadPolicy;
        for configured in [None, Some(true)] {
            assert!(
                policy
                    .original_download_allowed(&mysql, "team-x", configured)
                    .await
                    .unwrap()
            );
        }
        assert!(
            !policy
                .original_download_allowed(&mysql, "team-x", Some(false))
                .await
                .unwrap()
        );
    }
}
