// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};

/// Current explicit invitations grant only native Issue reads, never project access.
pub async fn permits_read<M: Mysql>(mysql: &M, item_id: &str, user_id: i32) -> MysqlResult<bool> {
    let row: Option<Invitation> = mysql
        .fetch_optional(INVITATION_SQL, (user_id, item_id, user_id, user_id))
        .await?;
    Ok(row.is_some())
}

#[derive(FromMysqlRow)]
pub struct Invitation {
    #[allow(dead_code)]
    pub id: String,
}

pub const INVITATION_SQL: &str = "SELECT issue.id FROM loop_items issue \
         JOIN loop_items project ON project.id = issue.cloud_project_id \
         JOIN (SELECT resource_id, CAST(MIN(entity_id) AS SIGNED) workspace_id FROM resource_members \
         WHERE resource_type = 'CloudProject' AND entity_type = 'workspace' AND status = 'approved' \
         GROUP BY resource_id HAVING COUNT(DISTINCT entity_id) = 1) parent ON parent.resource_id = CAST(project.id AS SIGNED) \
         JOIN kinds workspace ON workspace.id = parent.workspace_id AND workspace.kind = 'CollaborationWorkspace' AND workspace.is_active = 1 \
         JOIN users recipient ON recipient.id = ? AND recipient.is_active = 1 \
         WHERE issue.id = ? AND issue.resource_type = 'task' \
         AND (issue.deleted_at IS NULL OR issue.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND project.resource_type = 'project' AND project.status = 'active' \
         AND (project.deleted_at IS NULL OR project.deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(project.metadata, '$.task_provider')), 'local') = 'local' \
         AND (issue.assignee_user_id = ? OR EXISTS (SELECT 1 FROM loop_items invitation \
         WHERE invitation.resource_type = 'collaborator' AND invitation.loop_item_id = issue.id \
         AND invitation.user_id = ?)) LIMIT 1";
