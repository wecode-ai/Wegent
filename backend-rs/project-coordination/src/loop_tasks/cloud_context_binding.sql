SELECT {columns}
FROM loop_items
WHERE loop_items.task_user_id = ?
  AND loop_items.device_id IN ({device_ids})
  AND loop_items.task_id = ?
  AND (loop_items.unlinked_at IS NULL OR loop_items.unlinked_at IN
       ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))
  AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN
       ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))
  AND loop_items.resource_type IN ('execution')
ORDER BY loop_items.linked_at DESC, loop_items.id DESC
LIMIT 1
