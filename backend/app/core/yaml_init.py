# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
YAML initialization module for loading initial data from YAML files.
This module scans a directory for YAML files and uses the existing batch service
to apply resources, ensuring consistency with the API layer.
"""

import os
import logging
from pathlib import Path
from typing import List, Dict, Any
import yaml

from app.core.config import settings
from app.services.k_batch import batch_service
from app.models.user import User
from sqlalchemy.orm import Session

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
        with open(file_path, 'r', encoding='utf-8') as f:
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
            is_active=True
        )
        db.add(admin_user)
        db.commit()
        db.refresh(admin_user)
        logger.info(f"Created default admin user with ID: {admin_user.id}")
    else:
        logger.info(f"Default admin user already exists with ID: {admin_user.id}")

    return admin_user.id


def apply_yaml_resources(user_id: int, resources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
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
        from app.services.kind import kind_service
        from app.core.exceptions import ValidationException

        results = []
        created_count = 0
        skipped_count = 0

        for resource in resources:
            try:
                kind = resource.get('kind')
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")

                if kind not in batch_service.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")

                namespace = resource['metadata']['namespace']
                name = resource['metadata']['name']

                # Check if resource already exists
                existing = kind_service.get_resource(user_id, kind, namespace, name)

                if existing:
                    # Skip existing resources to preserve user modifications
                    logger.info(f"Skipping existing {kind}/{name} in namespace {namespace}")
                    results.append({
                        'kind': kind,
                        'name': name,
                        'namespace': namespace,
                        'operation': 'skipped',
                        'success': True,
                        'reason': 'already_exists'
                    })
                    skipped_count += 1
                else:
                    # Create new resource
                    resource_id = kind_service.create_resource(user_id, kind, resource)
                    logger.info(f"Created {kind}/{name} in namespace {namespace} (id={resource_id})")
                    results.append({
                        'kind': kind,
                        'name': name,
                        'namespace': namespace,
                        'operation': 'created',
                        'success': True
                    })
                    created_count += 1

            except Exception as e:
                logger.error(f"Failed to process resource: {e}")
                results.append({
                    'kind': kind if 'kind' in locals() else 'unknown',
                    'name': resource.get('metadata', {}).get('name', 'unknown'),
                    'namespace': resource.get('metadata', {}).get('namespace', 'default'),
                    'operation': 'failed',
                    'success': False,
                    'error': str(e)
                })

        logger.info(
            f"YAML initialization complete: {created_count} created, "
            f"{skipped_count} skipped, {len(resources)} total"
        )
        return results

    except Exception as e:
        logger.error(f"Failed to apply resources: {e}", exc_info=True)
        return []


def scan_and_apply_yaml_directory(user_id: int, directory: Path) -> Dict[str, Any]:
    """
    Scan a directory for YAML files and apply all resources.

    Args:
        user_id: User ID to apply resources for
        directory: Directory to scan

    Returns:
        Summary of operations
    """
    if not directory.exists():
        logger.warning(f"Initialization directory does not exist: {directory}")
        return {"status": "skipped", "reason": "directory not found"}

    if not directory.is_dir():
        logger.error(f"Initialization path is not a directory: {directory}")
        return {"status": "error", "reason": "not a directory"}

    # Collect all YAML files
    yaml_files = sorted(directory.glob("*.yaml")) + sorted(directory.glob("*.yml"))

    if not yaml_files:
        logger.info(f"No YAML files found in {directory}")
        return {"status": "skipped", "reason": "no yaml files"}

    logger.info(f"Found {len(yaml_files)} YAML files in {directory}")

    all_resources = []
    files_processed = []

    # Load all resources from all YAML files
    for yaml_file in yaml_files:
        logger.info(f"Processing {yaml_file.name}")
        documents = load_yaml_documents(yaml_file)

        # Filter for valid resource documents (must have 'kind' and 'metadata')
        resources = [
            doc for doc in documents
            if isinstance(doc, dict) and 'kind' in doc and 'metadata' in doc
        ]

        if resources:
            all_resources.extend(resources)
            files_processed.append(yaml_file.name)
            logger.info(f"Loaded {len(resources)} resources from {yaml_file.name}")

    # Apply all resources at once
    if not all_resources:
        logger.info("No valid resources found in YAML files")
        return {
            "status": "completed",
            "files_processed": len(files_processed),
            "resources_applied": 0
        }

    logger.info(f"Applying {len(all_resources)} total resources for user_id={user_id}")
    results = apply_yaml_resources(user_id, all_resources)

    success_count = sum(1 for r in results if r.get('success'))

    return {
        "status": "completed",
        "files_processed": len(files_processed),
        "files": files_processed,
        "resources_total": len(all_resources),
        "resources_applied": success_count,
        "resources_failed": len(results) - success_count
    }


def run_yaml_initialization(db: Session) -> Dict[str, Any]:
    """
    Main entry point for YAML initialization.
    Scans the configured directory and applies all YAML resources.

    Args:
        db: Database session

    Returns:
        Summary of initialization
    """
    if not settings.INIT_DATA_ENABLED:
        logger.info("YAML initialization is disabled (INIT_DATA_ENABLED=False)")
        return {"status": "disabled"}

    logger.info("Starting YAML initialization...")

    # Ensure default admin user exists
    try:
        user_id = ensure_default_user(db)
    except Exception as e:
        logger.error(f"Failed to create default user: {e}", exc_info=True)
        return {"status": "error", "reason": "failed to create default user"}

    # Scan and apply YAML resources
    init_dir = Path(settings.INIT_DATA_DIR)
    logger.info(f"Scanning initialization directory: {init_dir}")

    summary = scan_and_apply_yaml_directory(user_id, init_dir)

    logger.info(f"YAML initialization completed: {summary}")
    return summary
