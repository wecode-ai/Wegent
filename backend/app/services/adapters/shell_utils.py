# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Utility functions for Shell type detection and classification
"""

from typing import Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Shell


def get_shell_type(
    db: Session, shell_name: str, shell_namespace: str, user_id: int
) -> Optional[str]:
    """
    Get the shell type (local_engine or external_api) for a given shell

    Shell type is stored in metadata.labels.type

    Args:
        db: Database session
        shell_name: Name of the shell
        shell_namespace: Namespace of the shell
        user_id: User ID

    Returns:
        "local_engine", "external_api", or None if shell not found
    """
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == shell_name,
            Kind.namespace == shell_namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not shell:
        return None

    shell_crd = Shell.model_validate(shell.json)

    # Get type from metadata.labels, default to local_engine
    if shell_crd.metadata.labels and "type" in shell_crd.metadata.labels:
        return shell_crd.metadata.labels["type"]

    return "local_engine"


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
