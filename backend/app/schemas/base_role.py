# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base role definition for unified role-based access control.

This module defines the BaseRole enum that serves as the single source of truth
for all role types in the system. Other role types (GroupRole, MemberRole,
ResourceRole, etc.) are aliases to this base definition for backward compatibility.

Role Hierarchy (highest to lowest):
    - Owner: Full control, can delete resource
    - Maintainer: Can manage members and settings
    - Developer: Can modify content
    - Reporter: Read-only access
    - RestrictedAnalyst: Limited read access (restricted to specific data)
"""

from enum import Enum


class BaseRole(str, Enum):
    """
    Base role enum for unified role-based access control.

    This is the single source of truth for all role definitions in the system.
    All other role types (GroupRole, MemberRole, ResourceRole) should be aliases
    to this enum to ensure consistency across the codebase.

    Attributes:
        Owner: Full control over the resource, including deletion
        Maintainer: Can manage members and modify settings
        Developer: Can modify content but not manage members
        Reporter: Read-only access to the resource
        RestrictedAnalyst: Limited read access with restrictions
    """

    Owner = "Owner"
    Maintainer = "Maintainer"
    Developer = "Developer"
    Reporter = "Reporter"
    RestrictedAnalyst = "RestrictedAnalyst"


# Role hierarchy mapping for permission checks
# Lower number = higher privilege
ROLE_HIERARCHY: dict[str, int] = {
    BaseRole.Owner.value: 0,
    BaseRole.Maintainer.value: 1,
    BaseRole.Developer.value: 2,
    BaseRole.Reporter.value: 3,
    BaseRole.RestrictedAnalyst.value: 4,
}


def has_permission(user_role: str | BaseRole, required_role: str | BaseRole) -> bool:
    """
    Check if a user role has sufficient permission for a required role.

    Args:
        user_role: The user's current role value (string or BaseRole enum)
        required_role: The minimum required role value (string or BaseRole enum)

    Returns:
        True if user_role has equal or higher privilege than required_role
    """
    # Convert enum to string value if needed
    user_role_str = user_role.value if isinstance(user_role, BaseRole) else user_role
    required_role_str = (
        required_role.value if isinstance(required_role, BaseRole) else required_role
    )

    user_level = ROLE_HIERARCHY.get(user_role_str, 999)
    required_level = ROLE_HIERARCHY.get(required_role_str, 999)
    return user_level <= required_level


# Backward compatibility aliases
# These allow existing code to continue using their preferred names
GroupRole = BaseRole
MemberRole = BaseRole
ResourceRole = BaseRole
