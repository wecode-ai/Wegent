-- SPDX-FileCopyrightText: 2025 Weibo, Inc.
--
-- SPDX-License-Identifier: Apache-2.0

-- Add last_interaction_at column to kinds table
-- This migration adds a new column to track user's last interaction time with tasks

-- Step 1: Add the column (allow NULL initially)
ALTER TABLE kinds ADD COLUMN last_interaction_at DATETIME NULL;

-- Step 2: Initialize existing data with created_at value
UPDATE kinds SET last_interaction_at = created_at WHERE last_interaction_at IS NULL;

-- Step 3: Make the column NOT NULL (after initialization)
ALTER TABLE kinds MODIFY COLUMN last_interaction_at DATETIME NOT NULL;

-- Step 4: Add index for performance (sorting by last_interaction_at)
CREATE INDEX idx_kinds_last_interaction_at ON kinds(last_interaction_at);
