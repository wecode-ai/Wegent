#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Batch import/delete evaluation topic permissions from a namelist file.

Usage:
    cd /path/to/backend
    uv run python scripts/batch_import_eval_permissions.py \
        --topic-id 123 \
        --namelist namelist.txt \
        --action grant \
        --role respondent \
        --granted-by 1

Arguments:
    --topic-id:     Topic ID to manage permissions for
    --namelist:     Path to file containing usernames (one per line)
    --action:       Action to perform (grant or delete)
    --role:         Role to grant (respondent, grader, question_creator)
    --granted-by:   User ID who is granting the permissions (default: 1)
    --dry-run:      Show what would be done without making changes

Examples:
    # Grant respondent permissions
    uv run python scripts/batch_import_eval_permissions.py -t 123 -f namelist.txt -a grant -r respondent

    # Grant grader permissions
    uv run python scripts/batch_import_eval_permissions.py -t 123 -f namelist.txt -a grant -r grader

    # Delete permissions (remove users from topic)
    uv run python scripts/batch_import_eval_permissions.py -t 123 -f namelist.txt -a delete

    # Dry run to preview changes
    uv run python scripts/batch_import_eval_permissions.py -t 123 -f namelist.txt -a grant -r respondent --dry-run
"""

import argparse
import logging
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from shared.models.db import User
from wecode.models.evaluation import EvalPermission, EvalTopic, PermissionRole

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


VALID_ROLES = {
    "respondent": PermissionRole.RESPONDENT,
    "grader": PermissionRole.GRADER,
    "question_creator": PermissionRole.QUESTION_CREATOR,
}


def read_namelist(filepath: str) -> list[str]:
    """Read usernames from file, one per line."""
    path = Path(filepath)
    if not path.exists():
        logger.error(f"File not found: {filepath}")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        usernames = [line.strip() for line in f if line.strip()]

    logger.info(f"Read {len(usernames)} usernames from {filepath}")
    return usernames


def get_user_ids_by_usernames(
    db: Session, usernames: list[str]
) -> dict[str, int | None]:
    """Lookup user IDs by usernames."""
    result = {}
    found_count = 0
    not_found = []

    for username in usernames:
        user = db.query(User).filter(User.user_name == username).first()
        if user:
            result[username] = user.id
            found_count += 1
        else:
            result[username] = None
            not_found.append(username)

    logger.info(f"Found {found_count}/{len(usernames)} users in database")
    if not_found:
        logger.warning(f"Users not found: {', '.join(not_found)}")

    return result


def check_topic_exists(db: Session, topic_id: int) -> EvalTopic | None:
    """Check if topic exists."""
    topic = db.query(EvalTopic).filter(EvalTopic.id == topic_id).first()
    if not topic:
        logger.error(f"Topic {topic_id} not found")
        return None
    return topic


def grant_permission(
    db: Session,
    topic_id: int,
    user_id: int,
    role: str,
    granted_by: int,
) -> tuple[bool, bool]:
    """
    Grant permission to a user.

    Returns:
        Tuple of (success, is_update) where:
        - success: True if operation succeeded
        - is_update: True if existing permission was updated, False if new
    """
    # Check for existing permission
    existing = (
        db.query(EvalPermission)
        .filter(
            EvalPermission.topic_id == topic_id,
            EvalPermission.user_id == user_id,
        )
        .first()
    )

    if existing:
        # Update existing permission
        old_role = existing.role
        existing.role = role
        existing.granted_by = granted_by
        db.flush()
        logger.debug(f"Updated permission for user {user_id}: {old_role} -> {role}")
        return True, True

    # Create new permission
    permission = EvalPermission(
        topic_id=topic_id,
        user_id=user_id,
        role=role,
        granted_by=granted_by,
    )
    db.add(permission)
    db.flush()
    return True, False


def delete_permission(
    db: Session,
    topic_id: int,
    user_id: int,
) -> tuple[bool, bool]:
    """
    Delete permission from a user.

    Returns:
        Tuple of (success, had_permission) where:
        - success: True if operation succeeded
        - had_permission: True if user had permission before deletion
    """
    existing = (
        db.query(EvalPermission)
        .filter(
            EvalPermission.topic_id == topic_id,
            EvalPermission.user_id == user_id,
        )
        .first()
    )

    if existing:
        db.delete(existing)
        db.flush()
        logger.debug(f"Deleted permission for user {user_id}")
        return True, True

    return True, False


def main():
    parser = argparse.ArgumentParser(
        description="Batch import/delete evaluation topic permissions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    # Grant permissions
    %(prog)s -t 123 -f namelist.txt -a grant -r respondent
    %(prog)s --topic-id 123 --namelist namelist.txt --action grant --role grader --granted-by 5

    # Delete permissions
    %(prog)s -t 123 -f namelist.txt -a delete

    # Dry run
    %(prog)s -t 123 -f namelist.txt -a grant -r respondent --dry-run
        """,
    )

    parser.add_argument(
        "-t",
        "--topic-id",
        type=int,
        required=True,
        help="Topic ID to manage permissions for",
    )
    parser.add_argument(
        "-f",
        "--namelist",
        type=str,
        required=True,
        help="Path to file containing usernames (one per line)",
    )
    parser.add_argument(
        "-a",
        "--action",
        type=str,
        choices=["grant", "delete"],
        default="grant",
        help="Action to perform: grant (add/update permissions) or delete (remove permissions) (default: grant)",
    )
    parser.add_argument(
        "-r",
        "--role",
        type=str,
        choices=list(VALID_ROLES.keys()),
        default="respondent",
        help="Role to grant (required for grant action, default: respondent)",
    )
    parser.add_argument(
        "-g",
        "--granted-by",
        type=int,
        default=1,
        help="User ID who is granting the permissions (default: 1)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without making changes",
    )

    args = parser.parse_args()

    # Validate role for grant action
    role_value = VALID_ROLES[args.role]

    # Read namelist
    usernames = read_namelist(args.namelist)
    if not usernames:
        logger.error("No usernames found in file")
        sys.exit(1)

    # Database operations
    db = SessionLocal()
    try:
        # Check topic exists
        topic = check_topic_exists(db, args.topic_id)
        if not topic:
            sys.exit(1)

        logger.info(f"Topic: {topic.name} (ID: {topic.id})")
        logger.info(f"Action: {args.action}")
        if args.action == "grant":
            logger.info(f"Role to grant: {args.role}")
            logger.info(f"Granted by user ID: {args.granted_by}")

        # Lookup users
        user_map = get_user_ids_by_usernames(db, usernames)

        # Filter out users that don't exist
        valid_users = {
            username: user_id
            for username, user_id in user_map.items()
            if user_id is not None
        }

        if not valid_users:
            logger.error("No valid users found")
            sys.exit(1)

        # Preview changes in dry-run mode
        if args.dry_run:
            logger.info("\n=== DRY RUN MODE (no changes will be made) ===")
            for username, user_id in valid_users.items():
                existing = (
                    db.query(EvalPermission)
                    .filter(
                        EvalPermission.topic_id == args.topic_id,
                        EvalPermission.user_id == user_id,
                    )
                    .first()
                )
                if args.action == "grant":
                    if existing:
                        logger.info(
                            f"Would update: {username} (ID: {user_id}): {existing.role} -> {args.role}"
                        )
                    else:
                        logger.info(
                            f"Would create: {username} (ID: {user_id}) -> {args.role}"
                        )
                else:  # delete
                    if existing:
                        logger.info(
                            f"Would delete: {username} (ID: {user_id}) - had role: {existing.role}"
                        )
                    else:
                        logger.info(
                            f"Would skip: {username} (ID: {user_id}) - no permission to delete"
                        )
            logger.info("\nDry run complete. No changes were made.")
            return

        # Execute action
        if args.action == "grant":
            logger.info("\n=== Granting permissions ===")
            created_count = 0
            updated_count = 0
            failed_count = 0

            for username, user_id in valid_users.items():
                try:
                    success, is_update = grant_permission(
                        db, args.topic_id, user_id, role_value, args.granted_by
                    )
                    if success:
                        if is_update:
                            updated_count += 1
                            logger.info(f"Updated: {username} -> {args.role}")
                        else:
                            created_count += 1
                            logger.info(f"Created: {username} -> {args.role}")
                except Exception as e:
                    failed_count += 1
                    logger.error(f"Failed to grant permission to {username}: {e}")

            # Commit changes
            db.commit()

            # Summary
            logger.info("\n=== Summary ===")
            logger.info(f"Total users in file: {len(usernames)}")
            logger.info(f"Users found in database: {len(valid_users)}")
            logger.info(f"Permissions created: {created_count}")
            logger.info(f"Permissions updated: {updated_count}")
            logger.info(f"Failed: {failed_count}")

        else:  # delete action
            logger.info("\n=== Deleting permissions ===")
            deleted_count = 0
            skipped_count = 0
            failed_count = 0

            for username, user_id in valid_users.items():
                try:
                    success, had_permission = delete_permission(
                        db, args.topic_id, user_id
                    )
                    if success:
                        if had_permission:
                            deleted_count += 1
                            logger.info(f"Deleted: {username}")
                        else:
                            skipped_count += 1
                            logger.info(f"Skipped: {username} (no permission found)")
                except Exception as e:
                    failed_count += 1
                    logger.error(f"Failed to delete permission for {username}: {e}")

            # Commit changes
            db.commit()

            # Summary
            logger.info("\n=== Summary ===")
            logger.info(f"Total users in file: {len(usernames)}")
            logger.info(f"Users found in database: {len(valid_users)}")
            logger.info(f"Permissions deleted: {deleted_count}")
            logger.info(f"Skipped (no permission): {skipped_count}")
            logger.info(f"Failed: {failed_count}")

        if failed_count > 0:
            sys.exit(1)

    except Exception as e:
        logger.error(f"Error: {e}")
        db.rollback()
        sys.exit(1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
