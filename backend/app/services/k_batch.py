# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Batch operation service for Kubernetes-style API
"""
import logging
from pathlib import Path
from typing import Any, Dict, List

import yaml

from app.core.config import settings
from app.core.exceptions import ValidationException
from app.services.kind import kind_service

logger = logging.getLogger(__name__)


class BatchService:
    """Service for batch operations"""

    def __init__(self):
        # List of supported resource types
        self.supported_kinds = [
            "Ghost",
            "Model",
            "Shell",
            "Bot",
            "Team",
            "Workspace",
            "Task",
        ]

    def apply_resources(
        self, user_id: int, resources: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Apply multiple resources (create or update)"""
        results = []

        for resource in resources:
            try:
                kind = resource.get("kind")
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")

                if kind not in self.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")

                # Check if resource exists
                namespace = resource["metadata"]["namespace"]
                name = resource["metadata"]["name"]
                existing = kind_service.get_resource(user_id, kind, namespace, name)

                if existing:
                    # Update existing resource
                    resource_id = kind_service.update_resource(
                        user_id, kind, namespace, name, resource
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
                else:
                    # Create new resource
                    resource_id = kind_service.create_resource(user_id, kind, resource)
                    results.append(
                        {
                            "kind": kind,
                            "name": name,
                            "namespace": namespace,
                            "operation": "created",
                            "success": True,
                        }
                    )

            except Exception as e:
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

        return results

    def delete_resources(
        self, user_id: int, resources: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Delete multiple resources"""
        results = []

        for resource in resources:
            try:
                kind = resource.get("kind")
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")

                if kind not in self.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")

                namespace = resource["metadata"]["namespace"]
                name = resource["metadata"]["name"]

                kind_service.delete_resource(user_id, kind, namespace, name)
                results.append(
                    {
                        "kind": kind,
                        "name": name,
                        "namespace": namespace,
                        "operation": "deleted",
                        "success": True,
                    }
                )

            except Exception as e:
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

        return results


# Create service instance
batch_service = BatchService()


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


def load_resources_from_yaml_directory(directory: Path) -> List[Dict[str, Any]]:
    """
    Load all YAML resources from a directory.

    Args:
        directory: Path to the directory containing YAML files

    Returns:
        List of resource documents
    """
    if not directory.exists():
        logger.warning(f"Resource directory does not exist: {directory}")
        return []

    if not directory.is_dir():
        logger.error(f"Resource path is not a directory: {directory}")
        return []

    # Collect all YAML files
    yaml_files = sorted(directory.glob("*.yaml")) + sorted(directory.glob("*.yml"))

    if not yaml_files:
        logger.info(f"No YAML files found in {directory}")
        return []

    logger.info(
        f"Found {len(yaml_files)} YAML files in {directory}: {[f.name for f in yaml_files]}"
    )

    resources = []
    for yaml_file in yaml_files:
        logger.info(f"Processing {yaml_file.name}...")
        documents = load_yaml_documents(yaml_file)

        # Filter valid resource documents
        for doc in documents:
            if not isinstance(doc, dict) or "kind" not in doc or "metadata" not in doc:
                continue
            resources.append(doc)
            logger.info(
                f"  Added resource: {doc.get('kind')}/{doc.get('metadata', {}).get('name')}"
            )

    logger.info(f"Total resources loaded: {len(resources)}")
    return resources


async def apply_default_resources_async(user_id: int):
    """
    Asynchronous version of apply_default_resources.
    Loads YAML resources from NEW_USER_INIT_DATA_DIR and applies them for the user.
    """
    try:
        resource_dir = settings.NEW_USER_INIT_DATA_DIR
        if not resource_dir:
            logger.info(
                f"NEW_USER_INIT_DATA_DIR not configured, skipping default resources for user_id={user_id}"
            )
            return None

        directory = Path(resource_dir)
        logger.info(f"Loading resources from {directory} for user_id={user_id}")

        resources = load_resources_from_yaml_directory(directory)

        if not resources:
            logger.info(f"No resources found in {directory} for user_id={user_id}")
            return None

        logger.info(f"Found {len(resources)} resources to apply for user_id={user_id}")
        results = await apply_user_resources_async(user_id, resources)
        logger.info(
            f"[SUCCESS] Default resources applied successfully: user_id={user_id}, results={results}"
        )
        return results
    except yaml.YAMLError as e:
        logger.error(
            f"Failed to parse YAML resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Invalid YAML format", "details": str(e)}
    except Exception as e:
        logger.error(
            f"[ERROR] Failed to apply default resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Failed to apply default resources", "details": str(e)}


async def apply_user_resources_async(user_id: int, resources: List[Dict[str, Any]]):

    try:
        # Although batch_service.apply_resources is a synchronous function,
        # it won't block the main thread since this function is called through BackgroundTasks
        results = batch_service.apply_resources(user_id, resources)
        logger.info(
            f"[SUCCESS] Resources applied: user_id={user_id}, count={len(resources)}, results={results}"
        )
        return results
    except Exception as e:
        logger.error(
            f"[ERROR] Failed to apply resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Failed to apply resources", "details": str(e)}


def apply_default_resources_sync(user_id: int):
    """
    Synchronous version of apply_default_resources_async.
    Loads YAML resources from NEW_USER_INIT_DATA_DIR and applies them for the user.
    Used when default resources need to be applied synchronously during user creation.
    """
    try:
        resource_dir = settings.NEW_USER_INIT_DATA_DIR
        if not resource_dir:
            logger.info(
                f"NEW_USER_INIT_DATA_DIR not configured, skipping default resources for user_id={user_id}"
            )
            return None

        directory = Path(resource_dir)
        logger.info(f"Loading resources from {directory} for user_id={user_id}")

        resources = load_resources_from_yaml_directory(directory)

        if not resources:
            logger.info(f"No resources found in {directory} for user_id={user_id}")
            return None

        logger.info(f"Found {len(resources)} resources to apply for user_id={user_id}")
        results = batch_service.apply_resources(user_id, resources)
        logger.info(
            f"[SUCCESS] Default resources applied successfully: user_id={user_id}, results={results}"
        )
        return results
    except yaml.YAMLError as e:
        logger.error(
            f"Failed to parse YAML resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Invalid YAML format", "details": str(e)}
    except Exception as e:
        logger.error(
            f"[ERROR] Failed to apply default resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Failed to apply default resources", "details": str(e)}
