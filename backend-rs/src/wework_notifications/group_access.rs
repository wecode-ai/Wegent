//! Stored group notification content requires current read authority on every fetch.

pub(super) const GROUP_READ_PREDICATE: &str = " AND (\
    (JSON_EXTRACT(wework_notifications.payload,'$.groupId') IS NULL AND NOT EXISTS (\
        SELECT 1 FROM loop_items inbox_group_kind \
        WHERE inbox_group_kind.resource_type='chat_group' \
        AND inbox_group_kind.id=JSON_UNQUOTE(JSON_EXTRACT(wework_notifications.payload,'$.projectId'))\
    )) OR EXISTS (\
        SELECT 1 FROM loop_items inbox_group \
        JOIN resource_members inbox_grant ON inbox_grant.resource_type='CollaborationChatGroup' \
        AND inbox_grant.resource_id=CAST(inbox_group.id AS SIGNED) \
        AND inbox_grant.entity_type='user' \
        AND CAST(inbox_grant.entity_id AS BINARY)=CAST(wework_notifications.user_id AS BINARY) \
        AND inbox_grant.status='approved' \
        AND inbox_grant.role IN ('Owner','Maintainer','Developer','Viewer') \
        JOIN users inbox_user ON inbox_user.id=wework_notifications.user_id AND inbox_user.is_active=1 \
        WHERE inbox_group.resource_type='chat_group' \
        AND inbox_group.id=COALESCE(\
            JSON_UNQUOTE(JSON_EXTRACT(wework_notifications.payload,'$.groupId')),\
            JSON_UNQUOTE(JSON_EXTRACT(wework_notifications.payload,'$.projectId'))) \
        AND inbox_group.status IN ('active','archived') \
        AND (inbox_group.deleted_at IS NULL OR inbox_group.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) \
        AND (JSON_EXTRACT(wework_notifications.payload,'$.itemId') IS NULL OR EXISTS (\
            SELECT 1 FROM loop_items inbox_thread WHERE inbox_thread.resource_type='task' \
            AND inbox_thread.id=JSON_UNQUOTE(JSON_EXTRACT(wework_notifications.payload,'$.itemId')) \
            AND inbox_thread.cloud_project_id=inbox_group.id \
            AND (inbox_thread.deleted_at IS NULL OR inbox_thread.deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))\
        ))\
    )\
)";
