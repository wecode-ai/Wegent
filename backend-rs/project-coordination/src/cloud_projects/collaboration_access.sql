WITH parents AS (
    SELECT resource_id AS project_id, CAST(MIN(entity_id) AS SIGNED) AS workspace_id
    FROM resource_members
    WHERE resource_type = 'CloudProject' AND entity_type = 'workspace' AND status = 'approved'
    GROUP BY resource_id HAVING COUNT(DISTINCT entity_id) = 1
), memberships AS (
    SELECT resource_type, resource_id,
           MIN(CASE `role` WHEN 'Owner' THEN 1 WHEN 'Maintainer' THEN 1
               WHEN 'Developer' THEN 2 WHEN 'Reporter' THEN 4 WHEN 'Viewer' THEN 4 END) AS priority
    FROM resource_members
    WHERE entity_type = 'user' AND entity_id = '{user_id}' AND status = 'approved'
      AND `role` IN ('Owner', 'Maintainer', 'Developer', 'Reporter', 'Viewer')
    GROUP BY resource_type, resource_id
), access AS (
    SELECT loop_items.id AS project_id, parents.workspace_id,
           kinds.name AS workspace_name,
           CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(kinds.json, '$.metadata.publicId')), 'null') AS CHAR CHARACTER SET utf8mb4) AS workspace_public_id,
           CASE WHEN kinds.user_id = {user_id} THEN 0 ELSE space_member.priority END AS workspace_priority,
           direct.priority AS direct_priority,
           CASE WHEN kinds.user_id = {user_id} THEN 1
                WHEN space_member.priority = 1 THEN 1
                WHEN COALESCE(JSON_UNQUOTE(JSON_EXTRACT(loop_items.metadata, '$.membership_mode')), 'inherit') = 'inherit'
                THEN space_member.priority END AS inherited_priority,
           CASE WHEN EXISTS (
               SELECT 1 FROM resource_members AS public_grant
               WHERE public_grant.resource_type = 'CloudProject'
                 AND public_grant.resource_id = CAST(loop_items.id AS SIGNED)
                 AND public_grant.entity_type = 'authenticated_users' AND public_grant.entity_id = '*'
                 AND public_grant.status = 'approved' AND public_grant.`role` IN ('Developer', 'Viewer')
           ) THEN 4 END AS public_priority
    FROM loop_items
    JOIN parents ON parents.project_id = CAST(loop_items.id AS SIGNED)
    JOIN kinds ON kinds.id = parents.workspace_id AND kinds.kind = 'CollaborationWorkspace' AND kinds.is_active = true
    JOIN users AS caller ON caller.id = {user_id} AND caller.is_active = true
    LEFT JOIN memberships AS direct ON direct.resource_type = 'CloudProject' AND direct.resource_id = CAST(loop_items.id AS SIGNED)
    LEFT JOIN memberships AS space_member ON space_member.resource_type = 'Workspace' AND space_member.resource_id = kinds.id
    WHERE loop_items.resource_type = 'project' AND loop_items.status = 'active'
), resolved_access AS (
    SELECT access.*,
           CASE WHEN inherited_priority = 1 THEN 1
                ELSE COALESCE(direct_priority, inherited_priority, public_priority, 5)
           END AS priority
    FROM access
)
SELECT {columns}, access.priority AS anon_1_priority,
       access.workspace_id, access.workspace_name, access.workspace_public_id,
       access.workspace_priority, access.direct_priority, access.inherited_priority, access.public_priority
FROM loop_items JOIN resolved_access AS access ON access.project_id = loop_items.id
WHERE access.priority <= 4
{project_filter} {workspace_filter}
