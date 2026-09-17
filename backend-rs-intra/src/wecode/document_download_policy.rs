//! Organization namespace default for original knowledge-document downloads.
//! Source: `wecode.service.knowledge.document_protection_policy`.

use async_trait::async_trait;
use brz_mysql::{FromMysqlRow, MysqlResult, MysqlService};
use wegent_backend_rs::knowledge_download_policy::DocumentDownloadPolicy;

pub(super) struct WecodeDocumentDownloadPolicy;

#[derive(FromMysqlRow)]
struct NamespaceLevel {
    namespace_level: String,
}

#[async_trait]
impl DocumentDownloadPolicy for WecodeDocumentDownloadPolicy {
    async fn original_download_allowed(
        &self,
        mysql: &MysqlService,
        namespace: &str,
        configured: Option<bool>,
    ) -> MysqlResult<bool> {
        if let Some(allowed) = configured {
            return Ok(allowed);
        }
        if namespace == "default" || namespace.is_empty() {
            return Ok(true);
        }
        let row: Option<NamespaceLevel> = mysql
            .fetch_optional(
                "SELECT namespace.level AS namespace_level FROM namespace \
                 WHERE namespace.name = ? AND namespace.is_active IS true LIMIT 1",
                (namespace,),
            )
            .await?;
        Ok(row.is_none_or(|row| row.namespace_level != "organization"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configured_decision_and_personal_default_do_not_query() {
        let mysql = MysqlService::connect_lazy("mysql://user:pw@127.0.0.1:1/test").unwrap();
        let policy = WecodeDocumentDownloadPolicy;
        assert!(
            policy
                .original_download_allowed(&mysql, "org-x", Some(true))
                .await
                .unwrap()
        );
        assert!(
            !policy
                .original_download_allowed(&mysql, "org-x", Some(false))
                .await
                .unwrap()
        );
        assert!(
            policy
                .original_download_allowed(&mysql, "default", None)
                .await
                .unwrap()
        );
    }
}
