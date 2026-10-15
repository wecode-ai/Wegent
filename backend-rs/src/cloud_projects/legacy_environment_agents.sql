SELECT device_id, created_by_user_id, metadata FROM loop_items
WHERE resource_type = 'chat_agent' AND cloud_project_id = ? AND status = 'active'
  AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))
