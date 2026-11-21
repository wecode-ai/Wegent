// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge-base ACL for attachments associated with a document.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

/// `_check_knowledge_base_access`: `None` when the attachment is not a
/// knowledge-base document; otherwise the KB ACL verdict.
///
/// The source's `db.query(KnowledgeDocument).filter(attachment_id ==
/// id).first()` renders the full labeled projection as one statement, then
/// the ORM's `lazy="selectin"` external-source relationship fires for the
/// loaded document. `KnowledgeService.get_knowledge_base` is the shared KB
/// ACL port (`knowledge_documents_content::access`), which reproduces the
/// creator/direct-member/organization/group/entity resolution sequence.
pub async fn check_knowledge_base_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    attachment_id: i64,
    user_id: i32,
) -> MysqlResult<Option<bool>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    #[derive(Debug, FromMysqlRow)]
    struct KnowledgeDocumentRow {
        #[mysql(rename = "knowledge_documents_id")]
        id: i64,
        #[mysql(rename = "knowledge_documents_kind_id")]
        kind_id: i32,
    }
    let document: Option<KnowledgeDocumentRow> = mysql
        .fetch_optional(
            "SELECT knowledge_documents.id AS knowledge_documents_id, \
             knowledge_documents.kind_id AS knowledge_documents_kind_id, \
             knowledge_documents.attachment_id AS knowledge_documents_attachment_id, \
             knowledge_documents.name AS knowledge_documents_name, \
             knowledge_documents.file_extension AS knowledge_documents_file_extension, \
             knowledge_documents.file_size AS knowledge_documents_file_size, \
             knowledge_documents.status AS knowledge_documents_status, \
             knowledge_documents.user_id AS knowledge_documents_user_id, \
             knowledge_documents.is_active AS knowledge_documents_is_active, \
             knowledge_documents.index_status AS knowledge_documents_index_status, \
             knowledge_documents.index_generation AS knowledge_documents_index_generation, \
             knowledge_documents.splitter_config AS knowledge_documents_splitter_config, \
             knowledge_documents.source_type AS knowledge_documents_source_type, \
             knowledge_documents.source_config AS knowledge_documents_source_config, \
             knowledge_documents.origin AS knowledge_documents_origin, \
             knowledge_documents.folder_id AS knowledge_documents_folder_id, \
             knowledge_documents.summary AS knowledge_documents_summary, \
             knowledge_documents.chunks AS knowledge_documents_chunks, \
             knowledge_documents.created_at AS knowledge_documents_created_at, \
             knowledge_documents.updated_at AS knowledge_documents_updated_at \
             FROM knowledge_documents \
             WHERE knowledge_documents.attachment_id = ? \
             LIMIT 1",
            (attachment_id,),
        )
        .await?;
    let Some(document) = document else {
        return Ok(None);
    };
    // `external_source` (`lazy="selectin"`): loads with the document row.
    crate::knowledge_documents_content::reader::external_sources_by_document_ids(
        mysql,
        &[document.id],
    )
    .await?;
    let Some(knowledge_base) = crate::knowledge_documents_content::access::knowledge_base_record(
        mysql,
        i64::from(document.kind_id),
    )
    .await?
    else {
        return Ok(Some(false));
    };
    let access = crate::knowledge_documents_content::access::knowledge_base_access(
        mysql,
        redis,
        resolvers,
        &knowledge_base,
        i64::from(user_id),
    )
    .await
    .map_err(|_| brz_mysql::MysqlError::InvalidQuery {
        reason: "knowledge base access check failed".to_owned(),
    })?;
    Ok(Some(access))
}
