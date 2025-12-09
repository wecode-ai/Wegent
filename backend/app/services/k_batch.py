# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Batch operation service for Kubernetes-style API
"""
import asyncio
import json
import logging
import os
from typing import Any, Dict, List

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


def load_resources_from_file(file_path: str):
    try:
        if not os.path.exists(file_path):
            logger.info(f"Resource file not found: {file_path}")
            return None, None

        with open(file_path, "r") as file:
            resources = json.load(file)

        if not resources:
            logger.info("No resources to apply (empty file).")
            return None, None

        logger.info(f"Loaded resources from {file_path}")
        return resources, None

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse resource file: {file_path}, error={e}")
        return None, {"error": "Invalid resource file format", "details": str(e)}
    except Exception as e:
        logger.error(f"Failed to read resource file: {file_path}, error={e}")
        return None, {"error": "Failed to read resource file", "details": str(e)}


async def apply_default_resources_async(user_id: int):

    try:
        resource_file_path = "/app/resource.json"
        logger.info(
            f"Loading resources from {resource_file_path} for user_id={user_id}"
        )
        resources, error = load_resources_from_file(resource_file_path)

        if error:
            logger.warning(f"Error loading resources for user_id={user_id}: {error}")
            return error

        if not resources:
            logger.info(
                f"No resources found in {resource_file_path} for user_id={user_id}"
            )
            return None

        logger.info(f"Found {len(resources)} resources to apply for user_id={user_id}")
        results = await apply_user_resources_async(user_id, resources)
        logger.info(
            f"[SUCCESS] Default resources applied successfully: user_id={user_id}, results={results}"
        )
        return results
    except json.JSONDecodeError as e:
        logger.error(
            f"Failed to parse DEFAULT_RESOURCES: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Invalid DEFAULT_RESOURCES format", "details": str(e)}
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
    Used when default resources need to be applied synchronously during user creation.
    """
    try:
        resource_file_path = "/app/resource.json"
        logger.info(
            f"Loading resources from {resource_file_path} for user_id={user_id}"
        )
        resources, error = load_resources_from_file(resource_file_path)

        if error:
            logger.warning(f"Error loading resources for user_id={user_id}: {error}")
            return error

        if not resources:
            logger.info(
                f"No resources found in {resource_file_path} for user_id={user_id}"
            )
            return None

        logger.info(f"Found {len(resources)} resources to apply for user_id={user_id}")
        results = batch_service.apply_resources(user_id, resources)
        logger.info(
            f"[SUCCESS] Default resources applied successfully: user_id={user_id}, results={results}"
        )
        return results
    except json.JSONDecodeError as e:
        logger.error(
            f"Failed to parse DEFAULT_RESOURCES: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Invalid DEFAULT_RESOURCES format", "details": str(e)}
    except Exception as e:
        logger.error(
            f"[ERROR] Failed to apply default resources: user_id={user_id}, error={e}",
            exc_info=True,
        )
        return {"error": "Failed to apply default resources", "details": str(e)}
