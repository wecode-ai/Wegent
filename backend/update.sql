-- 删除外键约束
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_2; -- task_id外键
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_3; -- team_id外键
ALTER TABLE subtasks DROP FOREIGN KEY subtasks_ibfk_4; -- bot_id外键

-- 删除索引
ALTER TABLE subtasks DROP INDEX idx_task_sort;

-- 删除sort_order字段
ALTER TABLE subtasks DROP COLUMN sort_order;

-- 修改bot_id字段为bot_ids并更改类型
ALTER TABLE subtasks 
CHANGE COLUMN bot_id bot_ids JSON NOT NULL COMMENT 'JSON array of bot IDs, e.g. [1,2,3]';

-- 添加role字段
ALTER TABLE subtasks 
ADD COLUMN role ENUM('USER', 'ASSISTANT') NOT NULL DEFAULT 'ASSISTANT' AFTER bot_ids;

-- 添加message_id字段
ALTER TABLE subtasks 
ADD COLUMN message_id INT NOT NULL DEFAULT 1 AFTER error_message;

-- 添加parent_id字段
ALTER TABLE subtasks 
ADD COLUMN parent_id INT DEFAULT NULL AFTER message_id;

-- 添加executor_deleted_at字段
ALTER TABLE subtasks ADD COLUMN executor_deleted_at DATETIME NULL AFTER executor_name;

-- Create models table
CREATE TABLE IF NOT EXISTS models (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    config JSON NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `idx_model_name` (`name`)
);

-- Create agents table
CREATE TABLE IF NOT EXISTS agents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    config JSON,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `idx_agent_name` (`name`)
);