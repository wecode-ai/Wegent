# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
YAML initialization module for loading initial data from YAML files.
This module scans a directory for YAML files and creates initial resources.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List

import yaml
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.public_shell import PublicShell
from app.models.user import User
from app.services.k_batch import batch_service

logger = logging.getLogger(__name__)


def load_yaml_documents(file_path: Path) -> List[Dict[str, Any]]:
    """
    Load YAML documents from a file.

    Args:
        file_path: Path to the YAML file

    Returns:
        List of parsed YAML documents
    """
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            documents = list(yaml.safe_load_all(f))
            # Filter out None/empty documents
            documents = [doc for doc in documents if doc]
            logger.info(f"Loaded {len(documents)} documents from {file_path}")
            return documents
    except Exception as e:
        logger.error(f"Failed to load YAML file {file_path}: {e}")
        return []


def ensure_default_user(db: Session) -> int:
    """
    Ensure the default admin user exists.

    Args:
        db: Database session

    Returns:
        User ID of the default admin user
    """
    # Check for admin user
    admin_user = db.query(User).filter(User.user_name == "admin").first()

    if not admin_user:
        logger.info("Creating default admin user")
        # Default admin user (admin/Wegent2025!)
        admin_user = User(
            user_name="admin",
            password_hash="$2b$12$5jQMrJGO8NMXmF90f/xnKeLtM/Deh912k4GRPx.q3nTGOg1e1IJzW",
            email="admin@example.com",
            git_info=[],
            is_active=True,
        )
        db.add(admin_user)
        db.commit()
        db.refresh(admin_user)
        logger.info(f"Created default admin user with ID: {admin_user.id}")
    else:
        logger.info(f"Default admin user already exists with ID: {admin_user.id}")

    return admin_user.id


def apply_yaml_resources(
    user_id: int, resources: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Apply YAML resources - only create new resources, skip existing ones.
    This ensures user modifications are preserved after restart.

    Args:
        user_id: User ID to apply resources for
        resources: List of resource documents

    Returns:
        List of operation results
    """
    if not resources:
        logger.info("No resources to apply")
        return []

    try:
        from app.core.exceptions import ValidationException
        from app.services.kind import kind_service

        results = []
        created_count = 0
        skipped_count = 0

        for resource in resources:
            try:
                kind = resource.get("kind")
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")

                if kind not in batch_service.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")

                namespace = resource["metadata"]["namespace"]
                name = resource["metadata"]["name"]

                # Check if resource already exists
                existing = kind_service.get_resource(user_id, kind, namespace, name)

                if existing:
                    # Skip existing resources to preserve user modifications
                    logger.info(
                        f"Skipping existing {kind}/{name} in namespace {namespace}"
                    )
                    results.append(
                        {
                            "kind": kind,
                            "name": name,
                            "namespace": namespace,
                            "operation": "skipped",
                            "success": True,
                            "reason": "already_exists",
                        }
                    )
                    skipped_count += 1
                else:
                    # Create new resource
                    resource_id = kind_service.create_resource(user_id, kind, resource)
                    logger.info(
                        f"Created {kind}/{name} in namespace {namespace} (id={resource_id})"
                    )
                    results.append(
                        {
                            "kind": kind,
                            "name": name,
                            "namespace": namespace,
                            "operation": "created",
                            "success": True,
                        }
                    )
                    created_count += 1

            except Exception as e:
                logger.error(f"Failed to process resource: {e}")
                results.append(
                    {
                        "kind": kind if "kind" in locals() else "unknown",
                        "name": resource.get("metadata", {}).get("name", "unknown"),
                        "namespace": resource.get("metadata", {}).get(
                            "namespace", "default"
                        ),
                        "operation": "failed",
                        "success": False,
                        "error": str(e),
                    }
                )

        logger.info(
            f"YAML initialization complete: {created_count} created, "
            f"{skipped_count} skipped, {len(resources)} total"
        )
        return results

    except Exception as e:
        logger.error(f"Failed to apply resources: {e}", exc_info=True)
        return []


def apply_public_shells(
    db: Session, resources: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Apply public shell resources to the public_shells table.
    Only creates new shells, skips existing ones (create-only mode).

    Args:
        db: Database session
        resources: List of Shell resource documents

    Returns:
        List of operation results
    """
    if not resources:
        logger.info("No public shells to apply")
        return []

    results = []
    created_count = 0
    skipped_count = 0

    for resource in resources:
        try:
            metadata = resource.get("metadata", {})
            name = metadata.get("name")
            namespace = metadata.get("namespace", "default")

            if not name:
                logger.error("Public shell missing name in metadata")
                results.append(
                    {
                        "kind": "Shell",
                        "name": "unknown",
                        "namespace": namespace,
                        "operation": "failed",
                        "success": False,
                        "error": "Missing name in metadata",
                    }
                )
                continue

            # Check if public shell already exists
            existing = (
                db.query(PublicShell)
                .filter(PublicShell.name == name, PublicShell.namespace == namespace)
                .first()
            )

            if existing:
                # Skip existing public shells to preserve modifications
                logger.info(
                    f"Skipping existing public shell {name} in namespace {namespace}"
                )
                results.append(
                    {
                        "kind": "Shell",
                        "name": name,
                        "namespace": namespace,
                        "operation": "skipped",
                        "success": True,
                        "reason": "already_exists",
                    }
                )
                skipped_count += 1
            else:
                # Create new public shell
                new_shell = PublicShell(
                    name=name, namespace=namespace, json=resource, is_active=True
                )
                db.add(new_shell)
                db.commit()
                db.refresh(new_shell)
                logger.info(
                    f"Created public shell {name} in namespace {namespace} (id={new_shell.id})"
                )
                results.append(
                    {
                        "kind": "Shell",
                        "name": name,
                        "namespace": namespace,
                        "operation": "created",
                        "success": True,
                    }
                )
                created_count += 1

        except Exception as e:
            logger.error(f"Failed to process public shell: {e}")
            results.append(
                {
                    "kind": "Shell",
                    "name": resource.get("metadata", {}).get("name", "unknown"),
                    "namespace": resource.get("metadata", {}).get(
                        "namespace", "default"
                    ),
                    "operation": "failed",
                    "success": False,
                    "error": str(e),
                }
            )

    logger.info(
        f"Public shells initialization complete: {created_count} created, "
        f"{skipped_count} skipped, {len(resources)} total"
    )
    return results


def scan_and_apply_yaml_directory(
    user_id: int, directory: Path, db: Session
) -> Dict[str, Any]:
    """
    Scan a directory for YAML files and apply all resources.

    Args:
        user_id: User ID to apply resources for
        directory: Directory to scan
        db: Database session for public_shells handling

    Returns:
        Summary of operations
    """
    logger.info(f"[scan_and_apply_yaml_directory] Starting with directory: {directory}")

    if not directory.exists():
        logger.warning(f"Initialization directory does not exist: {directory}")
        return {"status": "skipped", "reason": "directory not found"}

    if not directory.is_dir():
        logger.error(f"Initialization path is not a directory: {directory}")
        return {"status": "error", "reason": "not a directory"}

    # Collect all YAML files
    logger.info(f"[scan_and_apply_yaml_directory] Collecting YAML files...")
    yaml_files = sorted(directory.glob("*.yaml")) + sorted(directory.glob("*.yml"))

    if not yaml_files:
        logger.info(f"No YAML files found in {directory}")
        return {"status": "skipped", "reason": "no yaml files"}

    logger.info(
        f"Found {len(yaml_files)} YAML files in {directory}: {[f.name for f in yaml_files]}"
    )

    user_resources = []  # Resources for kinds table (user-owned)
    public_shell_resources = []  # Resources for public_shells table
    files_processed = []

    # Load all resources from all YAML files
    for yaml_file in yaml_files:
        logger.info(f"Processing {yaml_file.name}...")
        documents = load_yaml_documents(yaml_file)
        logger.info(f"Loaded {len(documents)} documents from {yaml_file.name}")

        # Filter and categorize valid resource documents
        for doc in documents:
            if not isinstance(doc, dict) or "kind" not in doc or "metadata" not in doc:
                continue

            kind = doc.get("kind")
            metadata = doc.get("metadata", {})

            # Check if this is a public shell (no user_id in metadata)
            if kind == "Shell" and "user_id" not in metadata:
                public_shell_resources.append(doc)
                logger.info(f"  Added public shell: {metadata.get('name')}")
            else:
                # User-owned resource
                user_resources.append(doc)
                logger.info(f"  Added user resource: {kind}/{metadata.get('name')}")

        if documents:
            files_processed.append(yaml_file.name)

    logger.info(
        f"[scan_and_apply_yaml_directory] Total resources: {len(user_resources)} user, {len(public_shell_resources)} public shells"
    )

    # Apply public shells FIRST (goes to public_shells table)
    # This must be done before user resources because Bots may reference public shells
    public_shell_results = []
    if public_shell_resources:
        logger.info(f"Applying {len(public_shell_resources)} public shell resources...")
        public_shell_results = apply_public_shells(db, public_shell_resources)
        logger.info(f"Public shells applied: {len(public_shell_results)} results")

    # Apply user resources (goes to kinds table)
    # This is done after public shells so that Bots can reference them
    user_results = []
    if user_resources:
        logger.info(
            f"Applying {len(user_resources)} user resources for user_id={user_id}..."
        )
        user_results = apply_yaml_resources(user_id, user_resources)
        logger.info(f"User resources applied: {len(user_results)} results")

    # Combine results
    user_success = sum(1 for r in user_results if r.get("success"))
    shell_success = sum(1 for r in public_shell_results if r.get("success"))
    total_resources = len(user_resources) + len(public_shell_resources)
    total_success = user_success + shell_success

    return {
        "status": "completed",
        "files_processed": len(files_processed),
        "files": files_processed,
        "resources_total": total_resources,
        "resources_applied": total_success,
        "resources_failed": total_resources - total_success,
        "user_resources": len(user_resources),
        "public_shells": len(public_shell_resources),
    }


def run_yaml_initialization(db: Session, skip_lock: bool = False) -> Dict[str, Any]:
    """
    Main entry point for YAML initialization.
    Scans the configured directory and applies all YAML resources.

    Note: Distributed locking is now handled by the caller (main.py) using a unified
    startup lock that covers both Alembic migrations and YAML initialization.

    Args:
        db: Database session
        skip_lock: Deprecated parameter, kept for backward compatibility

    Returns:
        Summary of initialization
    """
    if not settings.INIT_DATA_ENABLED:
        logger.info("YAML initialization is disabled (INIT_DATA_ENABLED=False)")
        return {"status": "disabled"}

    logger.info("Starting YAML initialization...")

    # Ensure default admin user exists
    try:
        logger.info("Ensuring default admin user exists...")
        user_id = ensure_default_user(db)
        logger.info(f"Default admin user ready with ID: {user_id}")
    except Exception as e:
        logger.error(f"Failed to create default user: {e}", exc_info=True)
        return {"status": "error", "reason": "failed to create default user"}

    # Scan and apply YAML resources
    init_dir = Path(settings.INIT_DATA_DIR)
    logger.info(f"Initial INIT_DATA_DIR: {init_dir}")

    # If path doesn't exist and is an absolute path, try relative to backend directory
    if not init_dir.exists() and init_dir.is_absolute():
        # Try relative path for local development
        relative_dir = Path(__file__).parent.parent.parent / "init_data"
        logger.info(f"Checking relative path: {relative_dir}")
        if relative_dir.exists():
            init_dir = relative_dir
            logger.info(f"Using relative path for local development: {init_dir}")
        else:
            logger.warning(f"Relative path does not exist: {relative_dir}")

    logger.info(f"Scanning initialization directory: {init_dir}")

    try:
        summary = scan_and_apply_yaml_directory(user_id, init_dir, db)
        logger.info(f"YAML initialization completed: {summary}")
        return summary
    except Exception as e:
        logger.error(f"Error during YAML initialization: {e}", exc_info=True)
        return {"status": "error", "reason": str(e)}
