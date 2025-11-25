-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Rollback script for last_interaction_at column
-- This script reverts the changes made by add_last_interaction_at.sql

-- Step 1: Drop the index
DROP INDEX IF EXISTS idx_kinds_last_interaction_at ON kinds;

-- Step 2: Drop the column
ALTER TABLE kinds DROP COLUMN IF EXISTS last_interaction_at;
