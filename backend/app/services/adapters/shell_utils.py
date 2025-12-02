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
from app.models.public_shell import PublicShell
from app.schemas.kind import Shell

logger = logging.getLogger(__name__)


def get_shell_by_name(
    db: Session, shell_name: str, user_id: int, namespace: str = "default"
) -> Optional[Union[Kind, PublicShell]]:
    """
    Get a Shell by name, first checking user's custom shells, then public shells.

    Args:
        db: Database session
        shell_name: Name of the shell (e.g., 'ClaudeCode', 'my-custom-shell')
        user_id: User ID
        namespace: Namespace (default: 'default')

    Returns:
        Kind object (for user shells) or PublicShell object (for public shells),
        or None if not found.
    """
    # First, try to find in user's custom shells (kinds table)
    user_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if user_shell:
        logger.debug(f"Found user shell '{shell_name}' for user {user_id}")
        return user_shell

    # Then, try to find in public shells
    public_shell = (
        db.query(PublicShell)
        .filter(
            PublicShell.name == shell_name,
            PublicShell.namespace == namespace,
            PublicShell.is_active == True,
        )
        .first()
    )

    if public_shell:
        logger.debug(f"Found public shell '{shell_name}'")
        return public_shell

    logger.warning(f"Shell '{shell_name}' not found in user shells or public shells")
    return None


def get_shell_info_by_name(
    db: Session, shell_name: str, user_id: int, namespace: str = "default"
) -> Dict[str, Any]:
    """
    Get shell information by shell name.

    First tries to find a user-defined custom shell in kinds table,
    then falls back to public shells in public_shells table.

    Args:
        db: Database session
        shell_name: Name of the shell (e.g., 'ClaudeCode', 'my-custom-shell')
        user_id: User ID
        namespace: Namespace (default: 'default')

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
    # First, try to find in user's custom shells (kinds table)
    user_shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if user_shell and isinstance(user_shell.json, dict):
        shell_crd = Shell.model_validate(user_shell.json)
        # For custom shells, shellType contains the actual agent type
        result = {
            "shell_type": shell_crd.spec.shellType,
            "support_model": shell_crd.spec.supportModel or [],
            "execution_type": "local_engine",
            "base_image": shell_crd.spec.baseImage,
            "is_custom": True,
        }
        if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
            result["execution_type"] = shell_crd.metadata.labels["type"]
        logger.info(
            f"Found user shell '{shell_name}', "
            f"shell_type={result['shell_type']}, execution_type={result['execution_type']}, "
            f"base_image={result['base_image']}"
        )
        return result

    # Then, try to find in public shells
    public_shell = (
        db.query(PublicShell)
        .filter(
            PublicShell.name == shell_name,
            PublicShell.namespace == namespace,
            PublicShell.is_active == True,
        )
        .first()
    )

    if public_shell and isinstance(public_shell.json, dict):
        shell_crd = Shell.model_validate(public_shell.json)
        # For public shells, the shell name IS the shell type (e.g., 'ClaudeCode')
        result = {
            "shell_type": shell_crd.spec.shellType,
            "support_model": shell_crd.spec.supportModel or [],
            "execution_type": "local_engine",
            "base_image": shell_crd.spec.baseImage,
            "is_custom": False,
        }
        if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
            result["execution_type"] = shell_crd.metadata.labels["type"]
        logger.info(
            f"Found public shell '{shell_name}', "
            f"shell_type={result['shell_type']}, execution_type={result['execution_type']}, "
            f"base_image={result['base_image']}"
        )
        return result

    # Shell not found - raise error instead of using fallback
    raise ValueError(f"Shell '{shell_name}' not found in user shells or public shells")


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
) -> Dict[Tuple[str, str], Union[Kind, PublicShell]]:
    """
    Batch-fetch shells by (name, namespace) keys.

    First queries user's custom shells from kinds table, then queries public shells
    for any missing keys.

    Args:
        db: Database session
        shell_keys: Set of (name, namespace) tuples to query
        user_id: User ID

    Returns:
        Dict mapping (name, namespace) to Kind or PublicShell objects
    """
    if not shell_keys:
        return {}

    shell_map: Dict[Tuple[str, str], Union[Kind, PublicShell]] = {}

    # Build OR filter for user shells
    def build_user_shell_or_filters(keys: Set[Tuple[str, str]]):
        return (
            or_(*[and_(Kind.name == n, Kind.namespace == ns) for (n, ns) in keys])
            if keys
            else None
        )

    # Query user's custom shells first
    user_shell_filter = build_user_shell_or_filters(shell_keys)
    if user_shell_filter is not None:
        user_shells = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Shell",
                Kind.is_active == True,
            )
            .filter(user_shell_filter)
            .all()
        )

        for shell in user_shells:
            shell_map[(shell.name, shell.namespace)] = shell

    # Find missing keys and query public shells
    found_keys = set(shell_map.keys())
    missing_keys = shell_keys - found_keys

    if missing_keys:

        def build_public_shell_or_filters(keys: Set[Tuple[str, str]]):
            return (
                or_(
                    *[
                        and_(PublicShell.name == n, PublicShell.namespace == ns)
                        for (n, ns) in keys
                    ]
                )
                if keys
                else None
            )

        public_shell_filter = build_public_shell_or_filters(missing_keys)
        if public_shell_filter is not None:
            public_shells = (
                db.query(PublicShell)
                .filter(PublicShell.is_active == True)
                .filter(public_shell_filter)
                .all()
            )

            for shell in public_shells:
                shell_map[(shell.name, shell.namespace)] = shell

    logger.debug(
        f"Batch fetched {len(shell_map)} shells for {len(shell_keys)} keys "
        f"(user: {len(shell_map) - len(missing_keys) + len(found_keys)}, "
        f"public: {len(shell_map) - len(found_keys)})"
    )

    return shell_map
