#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Migration script to fix custom shells that are missing supportModel inheritance.

This script updates all custom shells (user-defined and group shells) to inherit
the supportModel attribute from their base shell if it's missing or empty.

Usage:
    python backend/scripts/fix_custom_shell_support_model.py
"""

import sys
from pathlib import Path

# Add backend directory to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.schemas.kind import Shell


def fix_custom_shells(db: Session) -> dict:
    """
    Fix custom shells to inherit supportModel from their base shell.

    Returns:
        Dict with statistics: {
            'total_custom_shells': int,
            'fixed': int,
            'skipped': int,
            'errors': list
        }
    """
    stats = {
        "total_custom_shells": 0,
        "fixed": 0,
        "skipped": 0,
        "errors": [],
    }

    # Query all custom shells (shells with baseShellRef)
    custom_shells = (
        db.query(Kind)
        .filter(
            Kind.kind == "Shell",
            Kind.is_active == True,  # noqa: E712
        )
        .all()
    )

    for shell in custom_shells:
        try:
            if not isinstance(shell.json, dict):
                continue

            shell_crd = Shell.model_validate(shell.json)

            # Skip if not a custom shell (no baseShellRef)
            if not shell_crd.spec.baseShellRef:
                continue

            stats["total_custom_shells"] += 1

            # Check if supportModel is already set and not empty
            if shell_crd.spec.supportModel:
                print(
                    f"✓ Shell '{shell.name}' already has supportModel: {shell_crd.spec.supportModel}"
                )
                stats["skipped"] += 1
                continue

            # Find the base shell
            base_shell_name = shell_crd.spec.baseShellRef
            base_shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,  # Public shells
                    Kind.kind == "Shell",
                    Kind.name == base_shell_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,  # noqa: E712
                )
                .first()
            )

            if not base_shell:
                error_msg = f"Base shell '{base_shell_name}' not found for custom shell '{shell.name}'"
                print(f"✗ {error_msg}")
                stats["errors"].append(error_msg)
                continue

            if not isinstance(base_shell.json, dict):
                error_msg = f"Base shell '{base_shell_name}' has invalid JSON"
                print(f"✗ {error_msg}")
                stats["errors"].append(error_msg)
                continue

            base_shell_crd = Shell.model_validate(base_shell.json)
            base_support_model = base_shell_crd.spec.supportModel or []

            # Update the custom shell's supportModel
            shell_crd.spec.supportModel = base_support_model
            shell.json = shell_crd.model_dump(mode="json")

            db.add(shell)
            print(
                f"✓ Fixed shell '{shell.name}' (namespace: {shell.namespace}): "
                f"inherited supportModel {base_support_model} from '{base_shell_name}'"
            )
            stats["fixed"] += 1

        except Exception as e:
            error_msg = f"Error processing shell '{shell.name}': {str(e)}"
            print(f"✗ {error_msg}")
            stats["errors"].append(error_msg)

    # Commit all changes
    if stats["fixed"] > 0:
        db.commit()
        print(f"\n✓ Committed {stats['fixed']} changes to database")
    else:
        print("\n✓ No changes needed")

    return stats


def main():
    """Main function"""
    print("=" * 60)
    print("Custom Shell supportModel Migration Script")
    print("=" * 60)
    print()

    db = SessionLocal()
    try:
        stats = fix_custom_shells(db)

        print()
        print("=" * 60)
        print("Migration Summary")
        print("=" * 60)
        print(f"Total custom shells found: {stats['total_custom_shells']}")
        print(f"Fixed: {stats['fixed']}")
        print(f"Skipped (already correct): {stats['skipped']}")
        print(f"Errors: {len(stats['errors'])}")

        if stats["errors"]:
            print("\nErrors:")
            for error in stats["errors"]:
                print(f"  - {error}")

        if stats["fixed"] > 0:
            print("\n✓ Migration completed successfully!")
        else:
            print("\n✓ All custom shells already have correct supportModel")

        return 0 if len(stats["errors"]) == 0 else 1

    except Exception as e:
        print(f"\n✗ Migration failed: {str(e)}")
        db.rollback()
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
