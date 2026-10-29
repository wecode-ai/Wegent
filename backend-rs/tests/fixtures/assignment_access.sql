-- Match the Breeze connection collation used by CAST(... AS CHAR) in access unions.
ALTER TABLE loop_items CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE users (
  id INT PRIMARY KEY, user_name VARCHAR(100) NOT NULL, password_hash VARCHAR(100) DEFAULT '',
  email VARCHAR(100), git_info JSON, is_active TINYINT DEFAULT 1, role VARCHAR(20) DEFAULT 'user',
  auth_source VARCHAR(20) DEFAULT 'password', preferences TEXT, created_at DATETIME, updated_at DATETIME
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO users (id,user_name,git_info,preferences,created_at,updated_at) VALUES
  (7,'assignment-e2e-7',JSON_ARRAY(),'{}','2026-10-27 08:00:00','2026-10-27 08:00:00'),
  (8,'assignment-e2e-8',JSON_ARRAY(),'{}','2026-10-27 08:00:00','2026-10-27 08:00:00'),
  (9,'assignment-e2e-9',JSON_ARRAY(),'{}','2026-10-27 08:00:00','2026-10-27 08:00:00');
CREATE TABLE kinds (
  id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(64), name VARCHAR(100), namespace VARCHAR(100),
  json JSON, is_active TINYINT, created_at DATETIME, updated_at DATETIME
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO kinds VALUES
  (101,7,'CollaborationWorkspace','assignment-space','default',JSON_OBJECT(),1,'2026-10-27 08:00:00','2026-10-27 08:00:00');
CREATE TABLE resource_members (
  id BIGINT PRIMARY KEY, resource_type VARCHAR(64), resource_id BIGINT, entity_type VARCHAR(64),
  entity_id VARCHAR(100), entity_display_name VARCHAR(100), user_id INT, role VARCHAR(32),
  status VARCHAR(32), invited_by_user_id INT, share_link_id BIGINT, reviewed_by_user_id INT,
  reviewed_at DATETIME, copied_resource_id BIGINT, requested_at DATETIME, created_at DATETIME, updated_at DATETIME
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO resource_members (id,resource_type,resource_id,entity_type,entity_id,user_id,role,status) VALUES
  (1,'CloudProject',1001,'workspace','101',7,'Maintainer','approved'),
  (2,'CloudProject',1001,'user','7',7,'Maintainer','approved'),
  (3,'CloudProject',1001,'user','8',7,'Viewer','approved');
