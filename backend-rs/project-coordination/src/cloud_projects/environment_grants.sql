SELECT resource_id, entity_type, `role` AS grant_role, status
FROM resource_members
WHERE resource_type = 'Device'
  AND ((entity_type = 'workspace' AND entity_id = ?)
       OR (entity_type = 'project' AND entity_id = ?))
