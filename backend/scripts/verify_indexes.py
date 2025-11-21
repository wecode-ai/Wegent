#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Script to verify database indexes are created correctly
"""
import sys
import os

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import inspect
from app.db.session import engine
from app.models import Kind, Subtask, SharedTeam

def verify_indexes():
    """Verify that all expected indexes exist in the database"""
    inspector = inspect(engine)
    
    print("=" * 80)
    print("Database Index Verification")
    print("=" * 80)
    
    # Check Kind table indexes
    print("\n[Kind Table Indexes]")
    kind_indexes = inspector.get_indexes('kinds')
    expected_kind_indexes = [
        'idx_kind_user_kind',
        'idx_kind_user_kind_active',
        'idx_kind_user_name_namespace',
        'idx_kind_user_kind_name_namespace',
    ]
    
    print(f"Found {len(kind_indexes)} indexes:")
    for idx in kind_indexes:
        print(f"  - {idx['name']}: {idx['column_names']}")
    
    missing = []
    for expected in expected_kind_indexes:
        if not any(idx['name'] == expected for idx in kind_indexes):
            missing.append(expected)
    
    if missing:
        print(f"⚠️  Missing indexes: {', '.join(missing)}")
    else:
        print("✓ All expected indexes found")
    
    # Check Subtask table indexes
    print("\n[Subtask Table Indexes]")
    subtask_indexes = inspector.get_indexes('subtasks')
    expected_subtask_indexes = [
        'idx_subtask_task_user',
        'idx_subtask_task_status',
        'idx_subtask_task_role_status',
        'idx_subtask_task_message',
        'idx_subtask_executor',
    ]
    
    print(f"Found {len(subtask_indexes)} indexes:")
    for idx in subtask_indexes:
        print(f"  - {idx['name']}: {idx['column_names']}")
    
    missing = []
    for expected in expected_subtask_indexes:
        if not any(idx['name'] == expected for idx in subtask_indexes):
            missing.append(expected)
    
    if missing:
        print(f"⚠️  Missing indexes: {', '.join(missing)}")
    else:
        print("✓ All expected indexes found")
    
    # Check SharedTeam table indexes
    print("\n[SharedTeam Table Indexes]")
    shared_team_indexes = inspector.get_indexes('shared_teams')
    expected_shared_team_indexes = [
        'idx_user_team',
        'idx_user_active',
        'idx_team_active',
    ]
    
    print(f"Found {len(shared_team_indexes)} indexes:")
    for idx in shared_team_indexes:
        unique_marker = " (UNIQUE)" if idx.get('unique') else ""
        print(f"  - {idx['name']}: {idx['column_names']}{unique_marker}")
    
    missing = []
    for expected in expected_shared_team_indexes:
        if not any(idx['name'] == expected for idx in shared_team_indexes):
            missing.append(expected)
    
    if missing:
        print(f"⚠️  Missing indexes: {', '.join(missing)}")
    else:
        print("✓ All expected indexes found")
    
    print("\n" + "=" * 80)
    print("Verification Complete")
    print("=" * 80)

if __name__ == "__main__":
    try:
        verify_indexes()
    except Exception as e:
        print(f"Error verifying indexes: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)