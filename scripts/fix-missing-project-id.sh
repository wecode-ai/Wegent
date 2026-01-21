#!/bin/bash
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# Fix missing project_id column in tasks table
# This script handles the case where Alembic migration record exists
# but the actual DDL operations were not executed

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get MySQL connection parameters from environment or use defaults
MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_USER="${MYSQL_USER:-root}"
MYSQL_PASSWORD="${MYSQL_ROOT_PASSWORD:-123456}"
MYSQL_DATABASE="${MYSQL_DATABASE:-task_manager}"

# Docker container name
MYSQL_CONTAINER="${MYSQL_CONTAINER:-wegent-mysql}"

echo -e "${YELLOW}Checking database schema for missing project_id column...${NC}"

# Check if running in Docker or local
if command -v docker &> /dev/null && docker ps --format '{{.Names}}' | grep -q "^${MYSQL_CONTAINER}$"; then
    MYSQL_CMD="docker exec ${MYSQL_CONTAINER} mysql -h${MYSQL_HOST} -P${MYSQL_PORT} -u${MYSQL_USER} -p${MYSQL_PASSWORD} ${MYSQL_DATABASE}"
    echo -e "${GREEN}Using Docker MySQL container: ${MYSQL_CONTAINER}${NC}"
else
    MYSQL_CMD="mysql -h${MYSQL_HOST} -P${MYSQL_PORT} -u${MYSQL_USER} -p${MYSQL_PASSWORD} ${MYSQL_DATABASE}"
    echo -e "${GREEN}Using local MySQL connection${NC}"
fi

# Check if project_id column exists in tasks table
echo -e "\n${YELLOW}Step 1: Checking if project_id column exists...${NC}"
COLUMN_EXISTS=$(${MYSQL_CMD} -sN -e "
SELECT COUNT(*) 
FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = '${MYSQL_DATABASE}' 
AND TABLE_NAME = 'tasks' 
AND COLUMN_NAME = 'project_id';
" 2>/dev/null || echo "0")

if [ "$COLUMN_EXISTS" -eq "0" ]; then
    echo -e "${RED}✗ project_id column is missing!${NC}"
    echo -e "${YELLOW}Applying fix...${NC}\n"
    
    # Step 1: Create projects table if not exists
    echo -e "${YELLOW}Step 2: Creating projects table (if not exists)...${NC}"
    ${MYSQL_CMD} -e "
    CREATE TABLE IF NOT EXISTS projects (
        id INT NOT NULL AUTO_INCREMENT COMMENT 'Primary key',
        user_id INT NOT NULL DEFAULT 0 COMMENT 'Project owner user ID',
        name VARCHAR(100) NOT NULL DEFAULT '' COMMENT 'Project name',
        description VARCHAR(256) NOT NULL DEFAULT '' COMMENT 'Project description',
        color VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'Project color identifier (e.g., #FF5733)',
        sort_order INT NOT NULL DEFAULT 0 COMMENT 'Sort order for display',
        is_expanded TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is expanded in UI',
        is_active TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Whether the project is active (soft delete)',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Creation timestamp',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last update timestamp',
        PRIMARY KEY (id),
        KEY idx_projects_user_id (user_id),
        KEY idx_projects_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Projects table for task organization';
    " 2>&1 > /dev/null
    echo -e "${GREEN}✓ Projects table created${NC}"
    
    # Step 2: Add project_id column to tasks table
    echo -e "\n${YELLOW}Step 3: Adding project_id column to tasks table...${NC}"
    ${MYSQL_CMD} -e "
    ALTER TABLE tasks 
    ADD COLUMN project_id INT NOT NULL DEFAULT 0 COMMENT 'Project ID for task grouping';
    " 2>&1 > /dev/null
    echo -e "${GREEN}✓ project_id column added${NC}"
    
    # Step 3: Create index on project_id
    echo -e "\n${YELLOW}Step 4: Creating index on project_id...${NC}"
    ${MYSQL_CMD} -e "
    CREATE INDEX idx_tasks_project_id ON tasks(project_id);
    " 2>&1 > /dev/null
    echo -e "${GREEN}✓ Index created${NC}"
    
    # Verify the fix
    echo -e "\n${YELLOW}Step 5: Verifying the fix...${NC}"
    ${MYSQL_CMD} -e "DESCRIBE tasks;" 2>/dev/null | grep "project_id"
    
    echo -e "\n${GREEN}✓✓✓ Fix applied successfully! ✓✓✓${NC}"
    echo -e "${GREEN}The project_id column has been added to the tasks table.${NC}"
    echo -e "${YELLOW}Please restart your backend service:${NC}"
    echo -e "  docker restart wegent-backend"
    
else
    echo -e "${GREEN}✓ project_id column already exists, no action needed${NC}"
    
    # Check if index exists
    INDEX_EXISTS=$(${MYSQL_CMD} -sN -e "
    SELECT COUNT(*) 
    FROM information_schema.STATISTICS 
    WHERE TABLE_SCHEMA = '${MYSQL_DATABASE}' 
    AND TABLE_NAME = 'tasks' 
    AND INDEX_NAME = 'idx_tasks_project_id';
    " 2>/dev/null || echo "0")
    
    if [ "$INDEX_EXISTS" -eq "0" ]; then
        echo -e "${YELLOW}Creating missing index...${NC}"
        ${MYSQL_CMD} -e "CREATE INDEX idx_tasks_project_id ON tasks(project_id);" 2>&1 > /dev/null
        echo -e "${GREEN}✓ Index created${NC}"
    else
        echo -e "${GREEN}✓ Index also exists${NC}"
    fi
fi

echo -e "\n${GREEN}Schema verification complete!${NC}"
