# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
YAML initialization module for loading initial data from YAML files.
This module scans a directory for YAML files and creates initial resources.
It also supports initializing Skills from ZIP packages in the skills subdirectory.
"""

import io
import logging
import zipfile
from pathlib import Path
from typing import Any, Dict, List

import yaml
from sqlalchemy.orm import Session

from app.core.config import settings
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


def ensure_default_user(db: Session) -> tuple[int, bool]:
    """
    Ensure the default admin user exists.

    Args:
        db: Database session

    Returns:
        Tuple of (User ID of the default admin user, is_newly_created)
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
            role="admin",
        )
        db.add(admin_user)
        db.commit()
        db.refresh(admin_user)
        logger.info(f"Created default admin user with ID: {admin_user.id}")
        return admin_user.id, True
    else:
        logger.info(f"Default admin user already exists with ID: {admin_user.id}")
        return admin_user.id, False


def apply_yaml_resources(
    user_id: int, resources: List[Dict[str, Any]], force: bool = False
) -> List[Dict[str, Any]]:
    """
    Apply YAML resources - only create new resources, skip existing ones.
    This ensures user modifications are preserved after restart.

    Args:
        user_id: User ID to apply resources for
        resources: List of resource documents
        force: If True, delete existing resources and recreate them

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
        updated_count = 0

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
                    if force:
                        # Force mode: delete and recreate
                        kind_service.delete_resource(user_id, kind, namespace, name)
                        resource_id = kind_service.create_resource(
                            user_id, kind, resource
                        )
                        logger.info(
                            f"Force updated {kind}/{name} in namespace {namespace} (id={resource_id})"
                        )
                        results.append(
                            {
                                "kind": kind,
                                "name": name,
                                "namespace": namespace,
                                "operation": "updated",
                                "success": True,
                            }
                        )
                        updated_count += 1
                    else:
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
            f"{updated_count} updated, {skipped_count} skipped, {len(resources)} total"
        )
        return results

    except Exception as e:
        logger.error(f"Failed to apply resources: {e}", exc_info=True)
        return []


def apply_public_resources(
    db: Session, resources: List[Dict[str, Any]], force: bool = False
) -> List[Dict[str, Any]]:
    """
    Apply public resources (Shell, Ghost, Bot, Team) to the kinds table (user_id=0).
    Only creates new resources, skips existing ones (create-only mode).

    Args:
        db: Database session
        resources: List of resource documents (Shell, Ghost, Bot, Team)
        force: If True, delete existing resources and recreate them

    Returns:
        List of operation results
    """
    if not resources:
        logger.info("No public resources to apply")
        return []

    from app.models.kind import Kind

    # Supported public resource kinds
    supported_kinds = {"Shell", "Ghost", "Bot", "Team"}

    results = []
    created_count = 0
    skipped_count = 0
    updated_count = 0

    for resource in resources:
        try:
            kind = resource.get("kind")
            if kind not in supported_kinds:
                logger.warning(f"Unsupported public resource kind: {kind}, skipping")
                continue

            metadata = resource.get("metadata", {})
            name = metadata.get("name")
            namespace = metadata.get("namespace", "default")

            if not name:
                logger.error(f"Public {kind} missing name in metadata")
                results.append(
                    {
                        "kind": kind,
                        "name": "unknown",
                        "namespace": namespace,
                        "operation": "failed",
                        "success": False,
                        "error": "Missing name in metadata",
                    }
                )
                continue

            # Check if public resource already exists
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == kind,
                    Kind.name == name,
                    Kind.namespace == namespace,
                )
                .first()
            )

            if existing:
                if force:
                    # Force mode: delete and recreate
                    db.delete(existing)
                    db.commit()
                    new_resource = Kind(
                        user_id=0,
                        kind=kind,
                        name=name,
                        namespace=namespace,
                        json=resource,
                        is_active=True,
                    )
                    db.add(new_resource)
                    db.commit()
                    db.refresh(new_resource)
                    logger.info(
                        f"Force updated public {kind} {name} in namespace {namespace} (id={new_resource.id})"
                    )
                    results.append(
                        {
                            "kind": kind,
                            "name": name,
                            "namespace": namespace,
                            "operation": "updated",
                            "success": True,
                        }
                    )
                    updated_count += 1
                else:
                    # Skip existing public resources to preserve modifications
                    logger.info(
                        f"Skipping existing public {kind} {name} in namespace {namespace}"
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
                # Create new public resource
                new_resource = Kind(
                    user_id=0,
                    kind=kind,
                    name=name,
                    namespace=namespace,
                    json=resource,
                    is_active=True,
                )
                db.add(new_resource)
                db.commit()
                db.refresh(new_resource)
                logger.info(
                    f"Created public {kind} {name} in namespace {namespace} (id={new_resource.id})"
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
            logger.error(f"Failed to process public {kind}: {e}")
            results.append(
                {
                    "kind": resource.get("kind", "unknown"),
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
        f"Public resources initialization complete: {created_count} created, "
        f"{updated_count} updated, {skipped_count} skipped, {len(resources)} total"
    )
    return results


def apply_skills_from_directory(
    db: Session, user_id: int, skills_dir: Path, force: bool = False
) -> List[Dict[str, Any]]:
    """
    Apply skills from a directory containing skill folders.
    Each skill folder should contain a SKILL.md file and related scripts.

    Skills from init_data are created as PUBLIC skills (user_id=0) so they
    can be accessed by all users.

    Args:
        db: Database session
        user_id: User ID (not used for skill creation, kept for API compatibility)
        skills_dir: Directory containing skill folders
        force: If True, delete existing skills and recreate them

    Returns:
        List of operation results
    """
    from app.services.adapters.skill_kinds import skill_kinds_service

    if not skills_dir.exists() or not skills_dir.is_dir():
        logger.info(f"Skills directory does not exist: {skills_dir}")
        return []

    results = []
    created_count = 0
    skipped_count = 0
    updated_count = 0

    # Public skills use user_id=0 so they can be accessed by all users
    public_user_id = 0

    # Find all skill folders (directories containing SKILL.md)
    for skill_folder in skills_dir.iterdir():
        if not skill_folder.is_dir():
            continue

        skill_md_path = skill_folder / "SKILL.md"
        if not skill_md_path.exists():
            logger.debug(f"Skipping {skill_folder.name}: no SKILL.md found")
            continue

        skill_name = skill_folder.name
        namespace = "default"

        try:
            # Check if public skill already exists (user_id=0)
            existing = skill_kinds_service.get_skill_by_name(
                db, name=skill_name, namespace=namespace, user_id=public_user_id
            )

            if existing:
                if force:
                    # Force mode: delete and recreate
                    # Get skill ID from metadata.labels (Skill CRD stores ID in labels)
                    skill_id = int(existing.metadata.labels.get("id"))
                    skill_kinds_service.delete_skill(
                        db, skill_id=skill_id, user_id=public_user_id
                    )
                    logger.info(
                        f"Deleted existing public skill for force update: {skill_name}"
                    )
                else:
                    logger.info(f"Skipping existing public skill: {skill_name}")
                    results.append(
                        {
                            "kind": "Skill",
                            "name": skill_name,
                            "namespace": namespace,
                            "operation": "skipped",
                            "success": True,
                            "reason": "already_exists",
                        }
                    )
                    skipped_count += 1
                    continue

            # Create ZIP file in memory from skill folder
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
                for file_path in skill_folder.rglob("*"):
                    if file_path.is_file():
                        # Archive path should be: skill_name/filename
                        arcname = f"{skill_name}/{file_path.relative_to(skill_folder)}"
                        zip_file.write(file_path, arcname)

            zip_content = zip_buffer.getvalue()
            zip_filename = f"{skill_name}.zip"

            # Create skill as PUBLIC (user_id=0) using skill_kinds_service
            skill = skill_kinds_service.create_skill(
                db,
                name=skill_name,
                namespace=namespace,
                file_content=zip_content,
                file_name=zip_filename,
                user_id=public_user_id,
            )

            operation = "updated" if existing and force else "created"
            logger.info(f"{operation.capitalize()} public skill: {skill_name}")
            results.append(
                {
                    "kind": "Skill",
                    "name": skill_name,
                    "namespace": namespace,
                    "operation": operation,
                    "success": True,
                }
            )
            if operation == "updated":
                updated_count += 1
            else:
                created_count += 1

        except Exception as e:
            logger.error(f"Failed to create public skill {skill_name}: {e}")
            results.append(
                {
                    "kind": "Skill",
                    "name": skill_name,
                    "namespace": namespace,
                    "operation": "failed",
                    "success": False,
                    "error": str(e),
                }
            )

    logger.info(
        f"Public skills initialization complete: {created_count} created, "
        f"{updated_count} updated, {skipped_count} skipped"
    )
    return results


def scan_and_apply_yaml_directory(
    user_id: int, directory: Path, db: Session, force: bool = False
) -> Dict[str, Any]:
    """
    Scan a directory for YAML files and apply all resources as PUBLIC (user_id=0).

    All resources (Shell, Ghost, Bot, Team) from init_data are created as public
    resources so they can be accessed by all users.

    Args:
        user_id: User ID (kept for API compatibility, not used for resource creation)
        directory: Directory to scan
        db: Database session for public resources handling
        force: If True, delete existing resources and recreate them

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

    public_resources = []  # All resources are now public (user_id=0)
    files_processed = []

    # Load all resources from all YAML files
    for yaml_file in yaml_files:
        logger.info(f"Processing {yaml_file.name}...")
        documents = load_yaml_documents(yaml_file)
        logger.info(f"Loaded {len(documents)} documents from {yaml_file.name}")

        # Filter valid resource documents - all go to public resources
        for doc in documents:
            if not isinstance(doc, dict) or "kind" not in doc or "metadata" not in doc:
                continue

            kind = doc.get("kind")
            metadata = doc.get("metadata", {})

            # All resources (Shell, Ghost, Bot, Team) are now public
            public_resources.append(doc)
            logger.info(f"  Added public resource: {kind}/{metadata.get('name')}")

        if documents:
            files_processed.append(yaml_file.name)

    logger.info(
        f"[scan_and_apply_yaml_directory] Total public resources: {len(public_resources)}"
    )

    # Apply skills from skills subdirectory FIRST
    # This must be done before other resources because Ghosts may reference skills
    skills_dir = directory / "skills"
    skill_results = []
    if skills_dir.exists():
        logger.info(f"Applying skills from {skills_dir} (force={force})...")
        skill_results = apply_skills_from_directory(
            db, user_id, skills_dir, force=force
        )
        logger.info(f"Skills applied: {len(skill_results)} results")

    # Apply all public resources (Shell, Ghost, Bot, Team)
    # Order matters: Shell -> Ghost -> Bot -> Team (due to references)
    # Sort resources by kind to ensure correct order
    kind_order = {"Shell": 0, "Ghost": 1, "Bot": 2, "Team": 3}
    sorted_resources = sorted(
        public_resources, key=lambda r: kind_order.get(r.get("kind"), 99)
    )

    public_results = []
    if sorted_resources:
        logger.info(
            f"Applying {len(sorted_resources)} public resources (force={force})..."
        )
        public_results = apply_public_resources(db, sorted_resources, force=force)
        logger.info(f"Public resources applied: {len(public_results)} results")

    # Combine results
    public_success = sum(1 for r in public_results if r.get("success"))
    skill_success = sum(1 for r in skill_results if r.get("success"))
    total_resources = len(public_resources) + len(skill_results)
    total_success = public_success + skill_success

    return {
        "status": "completed",
        "files_processed": len(files_processed),
        "files": files_processed,
        "resources_total": total_resources,
        "resources_applied": total_success,
        "resources_failed": total_resources - total_success,
        "public_resources": len(public_resources),
        "skills": len(skill_results),
    }


def run_yaml_initialization(db: Session, skip_lock: bool = False) -> Dict[str, Any]:
    """
    Main entry point for YAML initialization.
    Scans the configured directory and applies all YAML resources as PUBLIC (user_id=0).

    All resources (Shell, Ghost, Bot, Team, Skill) from init_data are created as public
    resources so they can be accessed by all users.

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

    # Skip YAML initialization in production environment
    # Production deployments should use pre-configured databases or manual initialization
    if settings.ENVIRONMENT == "production":
        logger.info(
            "YAML initialization is skipped in production environment. "
            "Set ENVIRONMENT=development or use manual initialization if needed."
        )
        return {"status": "skipped", "reason": "production environment"}

    force = settings.INIT_DATA_FORCE
    logger.info(f"Starting YAML initialization (force={force})...")

    # Ensure default admin user exists
    try:
        logger.info("Ensuring default admin user exists...")
        user_id, is_new_user = ensure_default_user(db)
        logger.info(
            f"Default admin user ready with ID: {user_id}, is_new_user: {is_new_user}"
        )
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
        # Apply all public resources (Shell, Ghost, Bot, Team, Skill)
        # All resources are now public (user_id=0) and accessible by all users
        summary = scan_and_apply_yaml_directory(user_id, init_dir, db, force=force)

        logger.info(f"YAML initialization completed: {summary}")
        return summary
    except Exception as e:
        logger.error(f"Error during YAML initialization: {e}", exc_info=True)
        return {"status": "error", "reason": str(e)}
