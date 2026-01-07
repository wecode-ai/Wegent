# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.schemas.namespace import (
    GroupCreate,
    GroupResponse,
    GroupRole,
    GroupUpdate,
    GroupVisibility,
)
from app.schemas.namespace_member import (
    GroupMemberCreate,
    GroupMemberResponse,
    GroupMemberUpdate,
)
from app.services.group_permission import (
    check_group_permission,
    get_effective_role_in_group,
    get_user_role_in_group,
)

# Maximum nesting depth for groups
MAX_GROUP_DEPTH = 5


def create_group(
    db: Session, group_data: GroupCreate, owner_user_id: int
) -> GroupResponse:
    """
    Create a new group and add the creator as Owner.

    Args:
        db: Database session
        group_data: Group creation data
        owner_user_id: User ID of the group creator (becomes owner)

    Returns:
        Created group response

    Raises:
        HTTPException: If group name already exists or validation fails
    """
    # Check if group name already exists
    existing = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_data.name,
            Namespace.is_active == True,
        )
        .first()
    )

    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Group '{group_data.name}' already exists",
        )

    # Validate parent group exists if this is a subgroup
    if "/" in group_data.name:
        parent_name = group_data.name.rsplit("/", 1)[0]
        parent_group = (
            db.query(Namespace)
            .filter(
                Namespace.name == parent_name,
                Namespace.is_active == True,
            )
            .first()
        )

        if not parent_group:
            raise HTTPException(
                status_code=400,
                detail=f"Parent group '{parent_name}' does not exist",
            )

        # Check if user has permission to create subgroups (must be at least Maintainer)
        # Use effective role to support inheritance
        user_role = get_effective_role_in_group(db, owner_user_id, parent_name)
        role_hierarchy = {
            GroupRole.Owner: 0,
            GroupRole.Maintainer: 1,
            GroupRole.Developer: 2,
            GroupRole.Reporter: 3,
        }

        if (
            user_role is None
            or role_hierarchy.get(user_role, 999) > role_hierarchy[GroupRole.Maintainer]
        ):
            raise HTTPException(
                status_code=403,
                detail=f"Insufficient permissions to create subgroup under '{parent_name}'",
            )

    # Create group
    new_group = Namespace(
        name=group_data.name,
        display_name=group_data.display_name,
        owner_user_id=owner_user_id,
        visibility=group_data.visibility.value,
        description=group_data.description,
        is_active=True,
    )

    db.add(new_group)
    db.flush()  # Flush to get the group ID

    # Add creator as Owner member
    owner_member = NamespaceMember(
        group_name=group_data.name,
        user_id=owner_user_id,
        role=GroupRole.Owner.value,
        invited_by_user_id=owner_user_id,  # Self-invited
        is_active=True,
    )

    db.add(owner_member)
    db.commit()
    db.refresh(new_group)

    return GroupResponse.model_validate(new_group)


def get_group(db: Session, group_name: str) -> Optional[GroupResponse]:
    """
    Get group by name.

    Args:
        db: Database session
        group_name: Group name

    Returns:
        Group response or None if not found
    """
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        return None

    return GroupResponse.model_validate(group)


def list_user_groups(
    db: Session, user_id: int, skip: int = 0, limit: int = 100
) -> list[GroupResponse]:
    """
    List groups where user is a member (created or joined).
    Includes my_role and member_count for each group.

    Args:
        db: Database session
        user_id: User ID
        skip: Number of records to skip
        limit: Maximum number of records to return

    Returns:
        List of GroupResponse objects with additional fields
    """
    # Get all groups where user is an active member with their role
    member_data = (
        db.query(NamespaceMember.group_name, NamespaceMember.role)
        .filter(
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .all()
    )

    if not member_data:
        return []

    # Create a mapping of group_name -> role
    group_roles = {name: role for name, role in member_data}
    group_names = list(group_roles.keys())

    groups = (
        db.query(Namespace)
        .filter(
            Namespace.name.in_(group_names),
            Namespace.is_active == True,
        )
        .order_by(Namespace.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    # Get member counts for all groups
    member_counts = {}
    for group_name in group_names:
        count = (
            db.query(NamespaceMember)
            .filter(
                NamespaceMember.group_name == group_name,
                NamespaceMember.is_active == True,
            )
            .count()
        )
        member_counts[group_name] = count

    # Build response with additional fields
    result = []
    for group in groups:
        group_response = GroupResponse.model_validate(group)
        group_response.my_role = group_roles.get(group.name)
        group_response.member_count = member_counts.get(group.name, 0)
        result.append(group_response)

    return result


def update_group(
    db: Session, group_name: str, update_data: GroupUpdate, user_id: int
) -> GroupResponse:
    """
    Update group information.

    Args:
        db: Database session
        group_name: Group name
        update_data: Update data
        user_id: User ID performing the update

    Returns:
        Updated group response

    Raises:
        HTTPException: If group not found or user lacks permission
    """
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Check permission (must be at least Maintainer)
    if not check_group_permission(db, user_id, group_name, GroupRole.Maintainer):
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can update group information",
        )

    # Update fields
    update_dict = update_data.model_dump(exclude_unset=True)

    for field, value in update_dict.items():
        if hasattr(group, field):
            # Handle enum conversion
            if field == "visibility" and isinstance(value, GroupVisibility):
                setattr(group, field, value.value)
            else:
                setattr(group, field, value)

    db.commit()
    db.refresh(group)

    return GroupResponse.model_validate(group)


def delete_group(db: Session, group_name: str, user_id: int) -> None:
    """
    Delete a group (hard delete).

    Validates:
    - No subgroups exist
    - No resources (Bots, Teams, Tasks, etc.) exist in this namespace
    - User is the Owner

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID performing the deletion

    Raises:
        HTTPException: If validation fails or user lacks permission
    """
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Check permission (must be Owner)
    user_role = get_user_role_in_group(db, user_id, group_name)
    if user_role != GroupRole.Owner:
        raise HTTPException(
            status_code=403,
            detail="Only group Owner can delete the group",
        )

    # Check for subgroups
    subgroups = (
        db.query(Namespace)
        .filter(
            Namespace.name.like(f"{group_name}/%"),
            Namespace.is_active == True,
        )
        .first()
    )

    if subgroups:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete group with subgroups. Delete subgroups first.",
        )

    # Check for resources in this namespace (excluding Task resources)
    resources = (
        db.query(Kind)
        .filter(
            Kind.namespace == group_name,
            Kind.is_active == True,
            Kind.kind != "Task",  # Task resources are allowed when deleting group
        )
        .first()
    )

    if resources:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete group with existing resources. Move or delete resources first.",
        )

    # Hard delete all members
    db.query(NamespaceMember).filter(NamespaceMember.group_name == group_name).delete()

    # Hard delete group
    db.delete(group)

    db.commit()


def add_member(
    db: Session,
    group_name: str,
    user_id: int,
    role: GroupRole,
    invited_by_user_id: int,
) -> GroupMemberResponse:
    """
    Add a member to a group.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID to add
        role: Role to assign
        invited_by_user_id: User ID of the inviter

    Returns:
        Created member response

    Raises:
        HTTPException: If group not found, user already member, or insufficient permissions
    """
    # Check group exists
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Check inviter has permission (must be at least Maintainer)
    if not check_group_permission(
        db, invited_by_user_id, group_name, GroupRole.Maintainer
    ):
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can add members",
        )

    # Check if user is already a member
    existing = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    if existing:
        raise HTTPException(
            status_code=400,
            detail="User is already a member of this group",
        )

    # Create member
    new_member = NamespaceMember(
        group_name=group_name,
        user_id=user_id,
        role=role.value,
        invited_by_user_id=invited_by_user_id,
        is_active=True,
    )

    db.add(new_member)
    db.commit()
    db.refresh(new_member)

    return GroupMemberResponse.model_validate(new_member)


def remove_member(
    db: Session, group_name: str, user_id: int, removed_by_user_id: int
) -> None:
    """
    Remove a member from a group.

    When a member is removed, their resources in this namespace are transferred to the group owner.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID to remove
        removed_by_user_id: User ID performing the removal

    Raises:
        HTTPException: If member not found or insufficient permissions
    """
    # Check member exists
    member = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    if not member:
        raise HTTPException(status_code=404, detail="Member not found")

    # Get group
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Check permission
    # Owner can remove anyone, Maintainers can remove Developers and Reporters, users can remove themselves
    remover_role = get_user_role_in_group(db, removed_by_user_id, group_name)
    target_role = GroupRole(member.role)

    role_hierarchy = {
        GroupRole.Owner: 0,
        GroupRole.Maintainer: 1,
        GroupRole.Developer: 2,
        GroupRole.Reporter: 3,
    }

    # Allow self-removal
    if removed_by_user_id != user_id:
        # Check if remover has sufficient permissions
        if remover_role is None:
            raise HTTPException(
                status_code=403,
                detail="You are not a member of this group",
            )

        if role_hierarchy[remover_role] >= role_hierarchy[target_role]:
            raise HTTPException(
                status_code=403,
                detail="Insufficient permissions to remove this member",
            )

    # Prevent removing the last owner
    if target_role == GroupRole.Owner:
        owner_count = (
            db.query(NamespaceMember)
            .filter(
                NamespaceMember.group_name == group_name,
                NamespaceMember.role == GroupRole.Owner.value,
                NamespaceMember.is_active == True,
            )
            .count()
        )

        if owner_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot remove the last owner. Transfer ownership first.",
            )

    # Transfer resources to owner
    _transfer_resources_to_owner(db, group_name, user_id, group.owner_user_id)

    # Remove member (hard delete)
    db.delete(member)
    db.commit()


def update_member_role(
    db: Session,
    group_name: str,
    user_id: int,
    new_role: GroupRole,
    updated_by_user_id: int,
) -> GroupMemberResponse:
    """
    Update a member's role.

    Args:
        db: Database session
        group_name: Group name
        user_id: User ID to update
        new_role: New role to assign
        updated_by_user_id: User ID performing the update

    Returns:
        Updated member response

    Raises:
        HTTPException: If member not found or insufficient permissions
    """
    # Check member exists
    member = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    if not member:
        raise HTTPException(status_code=404, detail="Member not found")

    # Check permission (must be at least Maintainer to change roles)
    updater_role = get_user_role_in_group(db, updated_by_user_id, group_name)
    if updater_role not in [GroupRole.Owner, GroupRole.Maintainer]:
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can update member roles",
        )

    current_role = GroupRole(member.role)

    # Maintainers cannot modify Owner roles or promote to Owner
    if updater_role == GroupRole.Maintainer:
        if current_role == GroupRole.Owner:
            raise HTTPException(
                status_code=403,
                detail="Maintainers cannot modify Owner roles",
            )
        if new_role == GroupRole.Owner:
            raise HTTPException(
                status_code=403,
                detail="Only Owners can promote members to Owner role",
            )

    # Prevent downgrading the last owner
    if current_role == GroupRole.Owner and new_role != GroupRole.Owner:
        owner_count = (
            db.query(NamespaceMember)
            .filter(
                NamespaceMember.group_name == group_name,
                NamespaceMember.role == GroupRole.Owner.value,
                NamespaceMember.is_active == True,
            )
            .count()
        )

        if owner_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot change role of the last owner. Add another owner first.",
            )

    # Update role
    member.role = new_role.value
    db.commit()
    db.refresh(member)

    return GroupMemberResponse.model_validate(member)


def transfer_ownership(
    db: Session, group_name: str, new_owner_user_id: int, current_owner_user_id: int
) -> GroupResponse:
    """
    Transfer group ownership to another member.

    The new owner must be at least a Maintainer.
    The current owner becomes a Maintainer after transfer.

    Args:
        db: Database session
        group_name: Group name
        new_owner_user_id: User ID of the new owner
        current_owner_user_id: User ID of the current owner

    Returns:
        Updated group response

    Raises:
        HTTPException: If group not found, user is not owner, or target is not maintainer
    """
    # Check group exists
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Verify current user is the owner
    if group.owner_user_id != current_owner_user_id:
        raise HTTPException(
            status_code=403,
            detail="Only the current owner can transfer ownership",
        )

    # Check new owner is at least a Maintainer
    new_owner_role = get_user_role_in_group(db, new_owner_user_id, group_name)
    if new_owner_role not in [GroupRole.Owner, GroupRole.Maintainer]:
        raise HTTPException(
            status_code=400,
            detail="New owner must be at least a Maintainer",
        )

    # Get member records
    current_owner_member = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == current_owner_user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    new_owner_member = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.user_id == new_owner_user_id,
            NamespaceMember.is_active == True,
        )
        .first()
    )

    # Update group owner
    group.owner_user_id = new_owner_user_id

    # Update member roles
    if current_owner_member:
        current_owner_member.role = GroupRole.Maintainer.value

    if new_owner_member:
        new_owner_member.role = GroupRole.Owner.value

    db.commit()
    db.refresh(group)

    return GroupResponse.model_validate(group)


def invite_all_users(
    db: Session, group_name: str, invited_by_user_id: int
) -> list[GroupMemberResponse]:
    """
    Invite all existing users to the group as Reporters.

    Args:
        db: Database session
        group_name: Group name
        invited_by_user_id: User ID performing the invitation

    Returns:
        List of newly created member responses

    Raises:
        HTTPException: If group not found or insufficient permissions
    """
    from app.models.user import User

    # Check group exists
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active == True,
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    # Check permission (must be at least Maintainer)
    if not check_group_permission(
        db, invited_by_user_id, group_name, GroupRole.Maintainer
    ):
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can invite users",
        )

    # Get all active users
    all_users = db.query(User).filter(User.is_active == True).all()

    # Get existing members
    existing_member_ids = {
        m.user_id
        for m in db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.is_active == True,
        )
        .all()
    }

    # Create new members
    new_members = []
    for user in all_users:
        if user.id not in existing_member_ids:
            new_member = NamespaceMember(
                group_name=group_name,
                user_id=user.id,
                role=GroupRole.Reporter.value,
                invited_by_user_id=invited_by_user_id,
                is_active=True,
            )
            db.add(new_member)
            new_members.append(new_member)

    if new_members:
        db.commit()
        for member in new_members:
            db.refresh(member)

    return [GroupMemberResponse.model_validate(m) for m in new_members]


def _transfer_resources_to_owner(
    db: Session, group_name: str, from_user_id: int, to_user_id: int
) -> None:
    """
    Transfer all resources in a namespace from one user to another.

    This is used when a member leaves a group - their resources are transferred to the group owner.

    Args:
        db: Database session
        group_name: Group/namespace name
        from_user_id: Source user ID
        to_user_id: Target user ID (group owner)
    """
    # Transfer all Kind resources in this namespace
    db.query(Kind).filter(
        Kind.namespace == group_name,
        Kind.user_id == from_user_id,
        Kind.is_active == True,
    ).update({"user_id": to_user_id})

    db.commit()
