# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility functions for Shell type detection and classification.

This module provides unified Shell lookup and information retrieval functions
that can be used across different services (bot_kinds, executor_kinds, etc.).
"""

import logging
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Shell
from app.services.capability_lookup import ExecutionCapabilityLookup
from app.services.capability_reference_service import (
    get_referenced_capability,
    list_referenced_capabilities_by_namespace,
)

logger = logging.getLogger(__name__)


def find_shell_json(
    db: Session, shell_name: str, user_id: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    """
    Find shell JSON data by name from public shells or user-defined shells.

    Args:
        db: Database session
        shell_name: Shell name
        user_id: User ID (optional, for looking up user-defined shells)

    Returns:
        Shell JSON data or None if not found
    """
    # Try public shell first (user_id=0)
    shell_row = (
        db.query(Kind.json)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if shell_row and isinstance(shell_row[0], dict):
        return shell_row[0]

    if user_id is None:
        return None

    # Try personal namespace
    shell_row = (
        db.query(Kind.json)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,  # noqa: E712
        )
        .first()
    )
    if shell_row and isinstance(shell_row[0], dict):
        return shell_row[0]
    referenced_shell = get_referenced_capability(
        db,
        kind="Shell",
        name=shell_name,
        user_id=user_id,
        namespace="default",
    )
    if referenced_shell and isinstance(referenced_shell.json, dict):
        return referenced_shell.json

    # Try group namespaces
    from app.services.group_permission import get_user_groups

    user_groups = get_user_groups(db, user_id)
    for group_name in user_groups:
        shell_row = (
            db.query(Kind.json)
            .filter(
                Kind.kind == "Shell",
                Kind.name == shell_name,
                Kind.namespace == group_name,
                Kind.is_active == True,  # noqa: E712
            )
            .first()
        )
        if shell_row and isinstance(shell_row[0], dict):
            return shell_row[0]
        referenced_shell = get_referenced_capability(
            db,
            kind="Shell",
            name=shell_name,
            user_id=user_id,
            namespace=group_name,
        )
        if referenced_shell and isinstance(referenced_shell.json, dict):
            return referenced_shell.json

    return None


def get_shell_by_name(
    db: Session,
    shell_name: str,
    user_id: int,
    namespace: str = "default",
    *,
    lookup: ExecutionCapabilityLookup | None = None,
) -> Optional[Kind]:
    """
    Get a Shell by name, checking user's shells, group shells, and public shells.

    Args:
        db: Database session
        shell_name: Name of the shell (e.g., 'ClaudeCode', 'my-custom-shell')
        user_id: User ID
        namespace: Namespace (default: 'default')

    Returns:
        Kind object (for user/group shells) or public shell Kind object (for public shells),
        or None if not found.
    """
    lookup = lookup or ExecutionCapabilityLookup(db, user_id)
    if lookup.db is not db or lookup.user_id != user_id:
        raise ValueError("Shell lookup belongs to a different resource owner")
    user_shell = lookup.personal("Shell", shell_name, namespace)

    if user_shell:
        logger.debug(f"Found user shell '{shell_name}' for user {user_id}")
        return user_shell
    referenced_shell = lookup.referenced("Shell", shell_name, namespace)
    if referenced_shell:
        return referenced_shell

    # Then, try to find in user's accessible groups (if namespace != 'default')
    if namespace != "default":
        user_groups = lookup.groups
        if namespace in user_groups:
            group_shell = lookup.group("Shell", shell_name, [namespace])
            if group_shell:
                logger.debug(
                    f"Found group shell '{shell_name}' in namespace '{namespace}'"
                )
                return group_shell

    # Finally, try to find in public shells (user_id=0, namespace='default')
    public_shell = lookup.public("Shell", shell_name)

    if public_shell:
        logger.debug(f"Found public shell '{shell_name}'")
        return public_shell

    logger.warning(
        f"Shell '{shell_name}' not found in user shells, group shells, or public shells"
    )
    return None


def get_shell_info_by_name(
    db: Session, shell_name: str, user_id: int, namespace: str = "default"
) -> Dict[str, Any]:
    """
    Get shell information by shell name.

    Checks user's shells, group shells, and public shells.
    If namespace is 'default', also searches in all user's accessible groups.

    Args:
        db: Database session
        shell_name: Name of the shell (e.g., 'ClaudeCode', 'my-custom-shell')
        user_id: User ID
        namespace: Namespace (default: 'default'). If 'default', searches all accessible namespaces.

    Returns:
        Dict with:
            - shell_type: The actual agent type (e.g., 'ClaudeCode', 'Agno', 'Dify')
            - support_model: List of supported models
            - execution_type: 'local_engine' or 'external_api'
            - base_image: Base Docker image (optional)
            - is_custom: Whether this is a user-defined custom shell

    Raises:
        ValueError: If shell is not found
    """
    from app.services.group_permission import get_user_groups

    # First, try to find in user's custom shells (namespace='default')
    user_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .first()
    )

    if user_shell and isinstance(user_shell.json, dict):
        shell_crd = Shell.model_validate(user_shell.json)
        result = {
            "shell_type": shell_crd.spec.shellType,
            "support_model": shell_crd.spec.supportModel or [],
            "execution_type": "local_engine",
            "base_image": shell_crd.spec.baseImage,
            "is_custom": True,
            "namespace": user_shell.namespace,  # Return the actual namespace
        }
        if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
            result["execution_type"] = shell_crd.metadata.labels["type"]
        logger.info(
            f"Found user shell '{shell_name}', "
            f"shell_type={result['shell_type']}, execution_type={result['execution_type']}, "
            f"base_image={result['base_image']}, namespace={result['namespace']}"
        )
        return result

    referenced_shell = get_referenced_capability(
        db,
        kind="Shell",
        name=shell_name,
        user_id=user_id,
        namespace="default",
    )
    if referenced_shell and isinstance(referenced_shell.json, dict):
        shell_crd = Shell.model_validate(referenced_shell.json)
        labels = shell_crd.metadata.labels or {}
        return {
            "shell_type": shell_crd.spec.shellType,
            "support_model": shell_crd.spec.supportModel or [],
            "execution_type": labels.get("type", "local_engine"),
            "base_image": shell_crd.spec.baseImage,
            "is_custom": True,
            "is_reference": True,
            "namespace": "default",
        }

    # Then, try to find in user's accessible groups
    # If namespace is specified and not 'default', only search that namespace
    # If namespace is 'default', search all user's groups
    user_groups = get_user_groups(db, user_id)
    namespaces_to_search = [namespace] if namespace != "default" else user_groups

    for ns in namespaces_to_search:
        if ns == "default":
            continue  # Already searched above
        group_shell = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.name == shell_name,
                Kind.namespace == ns,
                Kind.is_active == True,
            )
            .first()
        )
        if group_shell and isinstance(group_shell.json, dict):
            shell_crd = Shell.model_validate(group_shell.json)
            result = {
                "shell_type": shell_crd.spec.shellType,
                "support_model": shell_crd.spec.supportModel or [],
                "execution_type": "local_engine",
                "base_image": shell_crd.spec.baseImage,
                "is_custom": True,  # Group shells are also custom
                "namespace": group_shell.namespace,  # Return the actual namespace
            }
            if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
                result["execution_type"] = shell_crd.metadata.labels["type"]
            logger.info(
                f"Found group shell '{shell_name}' in namespace '{ns}', "
                f"shell_type={result['shell_type']}, execution_type={result['execution_type']}, "
                f"base_image={result['base_image']}, namespace={result['namespace']}"
            )
            return result
        referenced_shell = get_referenced_capability(
            db,
            kind="Shell",
            name=shell_name,
            user_id=user_id,
            namespace=ns,
        )
        if referenced_shell and isinstance(referenced_shell.json, dict):
            shell_crd = Shell.model_validate(referenced_shell.json)
            labels = shell_crd.metadata.labels or {}
            return {
                "shell_type": shell_crd.spec.shellType,
                "support_model": shell_crd.spec.supportModel or [],
                "execution_type": labels.get("type", "local_engine"),
                "base_image": shell_crd.spec.baseImage,
                "is_custom": True,
                "is_reference": True,
                "namespace": ns,
            }

    # Finally, try to find in public shells (user_id=0, namespace='default')
    public_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .first()
    )

    if public_shell and isinstance(public_shell.json, dict):
        shell_crd = Shell.model_validate(public_shell.json)
        result = {
            "shell_type": shell_crd.spec.shellType,
            "support_model": shell_crd.spec.supportModel or [],
            "execution_type": "local_engine",
            "base_image": shell_crd.spec.baseImage,
            "is_custom": False,
            "namespace": public_shell.namespace,  # Return the actual namespace (should be 'default')
        }
        if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
            result["execution_type"] = shell_crd.metadata.labels["type"]
        logger.info(
            f"Found public shell '{shell_name}', "
            f"shell_type={result['shell_type']}, execution_type={result['execution_type']}, "
            f"base_image={result['base_image']}, namespace={result['namespace']}"
        )
        return result

    # Shell not found - raise error
    raise ValueError(
        f"Shell '{shell_name}' not found in user shells, group shells, or public shells"
    )


def get_shell_type(
    db: Session, shell_name: str, shell_namespace: str, user_id: int
) -> str:
    """
    Get the shell type (local_engine or external_api) for a given shell.

    Shell type is stored in metadata.labels.type

    Args:
        db: Database session
        shell_name: Name of the shell
        shell_namespace: Namespace of the shell
        user_id: User ID

    Returns:
        "local_engine" or "external_api"

    Raises:
        ValueError: If shell is not found
    """
    shell_info = get_shell_info_by_name(db, shell_name, user_id, shell_namespace)
    return shell_info["execution_type"]


def is_external_api_shell(
    db: Session, shell_name: str, shell_namespace: str, user_id: int
) -> bool:
    """
    Check if a shell is an external API type

    Args:
        db: Database session
        shell_name: Name of the shell
        shell_namespace: Namespace of the shell
        user_id: User ID

    Returns:
        True if the shell is an external API type, False otherwise
    """
    shell_type = get_shell_type(db, shell_name, shell_namespace, user_id)
    return shell_type == "external_api"


def is_local_engine_shell(
    db: Session, shell_name: str, shell_namespace: str, user_id: int
) -> bool:
    """
    Check if a shell is a local engine type

    Args:
        db: Database session
        shell_name: Name of the shell
        shell_namespace: Namespace of the shell
        user_id: User ID

    Returns:
        True if the shell is a local engine type, False otherwise
    """
    shell_type = get_shell_type(db, shell_name, shell_namespace, user_id)
    return shell_type == "local_engine"


def get_shells_by_names_batch(
    db: Session,
    shell_keys: Set[Tuple[str, str]],
    user_id: int,
) -> Dict[Tuple[str, str], Kind]:
    """
    Batch-fetch shells by (name, namespace) keys using the same precedence as
    ``get_shell_by_name``: user-owned direct Shell, referenced Shell, direct
    group Shell, then public Shell fallback.

    Args:
        db: Database session
        shell_keys: Set of (name, namespace) tuples to query
        user_id: User ID

    Returns:
        Dict mapping (name, namespace) to Kind objects
    """
    if not shell_keys:
        return {}

    shell_map: Dict[Tuple[str, str], Kind] = {}
    lookup = ExecutionCapabilityLookup(db, user_id)

    def build_exact_filters(keys: Set[Tuple[str, str]]):
        """Build exact name-and-namespace filters for a Shell batch."""
        return (
            or_(*[and_(Kind.name == n, Kind.namespace == ns) for (n, ns) in keys])
            if keys
            else None
        )

    # 1. User-owned direct Shells have the highest precedence.
    user_shell_filter = build_exact_filters(shell_keys)
    if user_shell_filter is not None:
        user_shells = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.is_active.is_(True),
            )
            .filter(user_shell_filter)
            .all()
        )

        for shell in user_shells:
            shell_map[(shell.name, shell.namespace)] = shell

    # 2. Resolve only the reference namespaces represented by missing Bot keys.
    missing_keys = shell_keys - set(shell_map)
    if missing_keys:
        requested_namespaces = list(
            dict.fromkeys(namespace for _, namespace in missing_keys)
        )
        references_by_namespace = list_referenced_capabilities_by_namespace(
            db,
            kind="Shell",
            user_id=user_id,
            namespaces=requested_namespaces,
        )
        for name, namespace in missing_keys:
            referenced_shell = next(
                (
                    shell
                    for shell in references_by_namespace.get(namespace, [])
                    if shell.name == name
                ),
                None,
            )
            if referenced_shell:
                shell_map[(name, namespace)] = referenced_shell

    # 3. Group Shells are direct namespace resources owned by any group member.
    missing_keys = shell_keys - set(shell_map)
    group_keys = {
        (name, namespace)
        for name, namespace in missing_keys
        if namespace in lookup.groups
    }
    group_shell_filter = build_exact_filters(group_keys)
    if group_shell_filter is not None:
        group_shells = (
            db.query(Kind)
            .filter(
                Kind.kind == "Shell",
                Kind.is_active.is_(True),
            )
            .filter(group_shell_filter)
            .all()
        )
        for shell in group_shells:
            shell_map[(shell.name, shell.namespace)] = shell

    # 4. Public Shells are the final fallback by name.
    missing_keys = shell_keys - set(shell_map)
    missing_names = {name for name, _ in missing_keys}
    if missing_names:
        public_shells = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.namespace == "default",
                Kind.is_active.is_(True),
                Kind.name.in_(missing_names),
            )
            .all()
        )
        public_shells_by_name = {shell.name: shell for shell in public_shells}
        for name, namespace in missing_keys:
            public_shell = public_shells_by_name.get(name)
            if public_shell:
                shell_map[(name, namespace)] = public_shell

    logger.debug(f"Batch fetched {len(shell_map)} shells for {len(shell_keys)} keys")

    return shell_map
