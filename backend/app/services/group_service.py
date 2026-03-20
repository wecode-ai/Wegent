# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.core.exceptions import CustomHTTPException
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.schemas.base_role import has_permission
from app.schemas.namespace import (
    GroupCreate,
    GroupLevel,
    GroupResponse,
    GroupRole,
    GroupUpdate,
    GroupVisibility,
)
from app.schemas.namespace_member import (
    GroupMemberBatchUpdateFailedItem,
    GroupMemberBatchUpdateItem,
    GroupMemberBatchUpdateResponse,
    GroupMemberCreate,
    GroupMemberResponse,
)
from app.services.group_member_helper import (
    NAMESPACE_RESOURCE_TYPE,
    count_group_members_by_role,
    create_group_member,
    delete_group_member,
    get_group_member,
    get_group_member_count,
    get_group_members,
    get_namespace_id_by_name,
    get_user_groups_with_roles,
)
from app.services.group_permission import (
    check_group_permission,
    get_effective_role_in_group,
    get_user_role_in_group,
)

# Maximum nesting depth for groups
MAX_GROUP_DEPTH = 5
CURRENT_GROUP_OWNER_ROLE_CHANGE_ERROR_CODE = "GROUP_OWNER_ROLE_CHANGE_REQUIRES_TRANSFER"
CURRENT_GROUP_OWNER_ROLE_CHANGE_ERROR = (
    "Cannot change role of the current group owner. Transfer ownership first."
)


def create_group(
    db: Session,
    group_data: GroupCreate,
    owner_user_id: int,
    user_role: str | None = None,
) -> GroupResponse:
    """
    Create a new group and add the creator as Owner.

    Args:
        db: Database session
        group_data: Group creation data
        owner_user_id: User ID of the group creator (becomes owner)
        user_role: User's system role ('admin' or 'user') for organization-level check

    Returns:
        Created group response

    Raises:
        HTTPException: If group name already exists or validation fails
    """
    # Check permission for organization-level group (admin only)
    group_level = group_data.level.value if group_data.level else GroupLevel.group.value
    if group_level == GroupLevel.organization.value and user_role != "admin":
        raise HTTPException(
            status_code=403,
            detail="Only admin users can create organization-level groups",
        )

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
        user_group_role = get_effective_role_in_group(db, owner_user_id, parent_name)

        if user_group_role is None or not has_permission(
            user_group_role, GroupRole.Maintainer
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
        level=group_level,
        is_active=True,
    )

    db.add(new_group)
    db.flush()  # Flush to get the group ID

    # Add creator as Owner member using ResourceMember
    owner_member = ResourceMember(
        resource_type=NAMESPACE_RESOURCE_TYPE,
        resource_id=new_group.id,
        user_id=owner_user_id,
        role=GroupRole.Owner.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=owner_user_id,  # Self-invited
        share_link_id=0,
        reviewed_by_user_id=0,
        copied_resource_id=0,
        requested_at=datetime.now(),
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
    db: Session,
    user_id: int,
    skip: int = 0,
    limit: int = 100,
    include_organization: bool = False,
) -> list[GroupResponse]:
    """
    List groups where user is a member (created or joined).
    Includes my_role and member_count for each group.

    Args:
        db: Database session
        user_id: User ID
        skip: Number of records to skip
        limit: Maximum number of records to return
        include_organization: Whether to include organization-level groups (admin only)

    Returns:
        List of GroupResponse objects with additional fields
    """
    # Get all groups where user is an active member with their role
    member_data = get_user_groups_with_roles(db, user_id)

    if not member_data:
        return []

    # Create a mapping of group_name -> role
    group_roles = {name: role for name, role in member_data}
    group_names = list(group_roles.keys())

    # Build query for groups
    query = db.query(Namespace).filter(
        Namespace.name.in_(group_names),
        Namespace.is_active == True,
    )

    # Filter out organization-level groups for non-admin users
    if not include_organization:
        query = query.filter(
            (Namespace.level != GroupLevel.organization.value)
            | (Namespace.level.is_(None))
        )

    groups = query.order_by(Namespace.created_at.desc()).offset(skip).limit(limit).all()

    # Get member counts for all groups
    member_counts = {}
    for group_name in group_names:
        member_counts[group_name] = get_group_member_count(db, group_name)

    # Build response with additional fields
    result = []
    for group in groups:
        group_response = GroupResponse.model_validate(group)
        group_response.my_role = group_roles.get(group.name)
        group_response.member_count = member_counts.get(group.name, 0)
        result.append(group_response)

    return result


def update_group(
    db: Session,
    group_name: str,
    update_data: GroupUpdate,
    user_id: int,
    user_role: str | None = None,
) -> GroupResponse:
    """
    Update group information.

    Args:
        db: Database session
        group_name: Group name
        update_data: Update data
        user_id: User ID performing the update
        user_role: User's system role ('admin' or 'user') for organization-level check

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

    # Check permission for organization-level changes (admin only)
    if update_data.level is not None:
        new_level = update_data.level.value
        current_level = group.level

        # Check if changing to or from organization level
        if (
            new_level == GroupLevel.organization.value
            or current_level == GroupLevel.organization.value
        ):
            if user_role != "admin":
                raise HTTPException(
                    status_code=403,
                    detail="Only admin users can change group level to/from organization",
                )

    # Update fields
    update_dict = update_data.model_dump(exclude_unset=True)

    for field, value in update_dict.items():
        if hasattr(group, field):
            # Handle enum conversion
            if field == "visibility" and isinstance(value, GroupVisibility):
                setattr(group, field, value.value)
            elif field == "level" and isinstance(value, GroupLevel):
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

    # Hard delete all members from resource_members
    namespace_id = get_namespace_id_by_name(db, group_name)
    if namespace_id:
        db.query(ResourceMember).filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
        ).delete()

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
        HTTPException: If group not found, user not found, user already member, or insufficient permissions
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

    # Check target user exists
    target_user = (
        db.query(User).filter(User.id == user_id, User.is_active == True).first()
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    # Check inviter has permission (must be at least Maintainer)
    if not check_group_permission(
        db, invited_by_user_id, group_name, GroupRole.Maintainer
    ):
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can add members",
        )

    # Check if user is already a member
    existing = get_group_member(db, group_name, user_id)
    if existing:
        raise HTTPException(
            status_code=400,
            detail="User is already a member of this group",
        )

    # Create member using ResourceMember
    new_member = create_group_member(
        db=db,
        group_name=group_name,
        user_id=user_id,
        role=role.value,
        invited_by_user_id=invited_by_user_id,
    )

    if not new_member:
        raise HTTPException(status_code=404, detail="Group not found")

    db.commit()
    db.refresh(new_member)

    return _build_group_member_response(new_member, group_name)


def _build_group_member_response(
    member: ResourceMember, group_name: str
) -> GroupMemberResponse:
    """Build API response for a group member."""
    response_data = {
        "id": member.id,
        "group_name": group_name,
        "user_id": member.user_id,
        "role": member.role,
        "invited_by_user_id": member.invited_by_user_id,
        "is_active": member.status == MemberStatus.APPROVED.value,
        "created_at": member.created_at,
        "updated_at": member.updated_at,
    }
    return GroupMemberResponse(**response_data)


def _get_group_or_404(db: Session, group_name: str) -> Namespace:
    """Get an active group or raise 404."""
    group = (
        db.query(Namespace)
        .filter(
            Namespace.name == group_name,
            Namespace.is_active.is_(True),
        )
        .first()
    )

    if not group:
        raise HTTPException(status_code=404, detail="Group not found")

    return group


def _get_role_updater_role(
    db: Session, group_name: str, updated_by_user_id: int
) -> GroupRole:
    """Validate and return the updater's effective role for role changes."""
    updater_role = get_user_role_in_group(db, updated_by_user_id, group_name)
    if updater_role not in [GroupRole.Owner, GroupRole.Maintainer]:
        raise HTTPException(
            status_code=403,
            detail="Only Maintainers and Owners can update member roles",
        )
    return updater_role


def _validate_member_role_change(
    member: ResourceMember,
    new_role: GroupRole,
    updater_role: GroupRole,
) -> None:
    """Validate a single member role change without mutating database state."""
    current_role = GroupRole(member.role)

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


def _validate_current_group_owner_role_change(
    group: Namespace, member: ResourceMember, new_role: GroupRole
) -> None:
    """Reject role changes that would desynchronize the primary group owner."""
    if (
        member.user_id == group.owner_user_id
        and GroupRole(member.role) == GroupRole.Owner
        and new_role != GroupRole.Owner
    ):
        raise CustomHTTPException(
            status_code=400,
            detail=CURRENT_GROUP_OWNER_ROLE_CHANGE_ERROR,
            error_code=CURRENT_GROUP_OWNER_ROLE_CHANGE_ERROR_CODE,
        )


def _get_batch_role_update_priority(
    member: ResourceMember | None, new_role: GroupRole
) -> int:
    """Order batch updates so Owner promotions are applied before Owner demotions."""
    if member is None:
        return 1

    current_role = GroupRole(member.role)
    if current_role != GroupRole.Owner and new_role == GroupRole.Owner:
        return 0
    if current_role == GroupRole.Owner and new_role != GroupRole.Owner:
        return 2
    return 1


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
    member = get_group_member(db, group_name, user_id)

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

    # Allow self-removal
    if removed_by_user_id != user_id:
        # Check if remover has sufficient permissions
        if remover_role is None:
            raise HTTPException(
                status_code=403,
                detail="You are not a member of this group",
            )

        # Remover must have higher permission than target (not equal or lower)
        if not has_permission(remover_role, target_role) or remover_role == target_role:
            raise HTTPException(
                status_code=403,
                detail="Insufficient permissions to remove this member",
            )

    # Prevent removing the last owner
    if target_role == GroupRole.Owner:
        owner_count = count_group_members_by_role(db, group_name, GroupRole.Owner.value)

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
    group = _get_group_or_404(db, group_name)

    member = get_group_member(db, group_name, user_id)

    if not member:
        raise HTTPException(status_code=404, detail="Member not found")

    updater_role = _get_role_updater_role(db, group_name, updated_by_user_id)
    _validate_member_role_change(member, new_role, updater_role)
    _validate_current_group_owner_role_change(group, member, new_role)
    current_role = GroupRole(member.role)

    # Prevent downgrading the last owner
    if current_role == GroupRole.Owner and new_role != GroupRole.Owner:
        owner_count = count_group_members_by_role(db, group_name, GroupRole.Owner.value)

        if owner_count <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot change role of the last owner. Add another owner first.",
            )

    # Update role
    member.role = new_role.value

    db.commit()
    db.refresh(member)

    return _build_group_member_response(member, group_name)


def update_member_roles_batch(
    db: Session,
    group_name: str,
    updates: list[GroupMemberBatchUpdateItem],
    updated_by_user_id: int,
) -> GroupMemberBatchUpdateResponse:
    """
    Batch update member roles with a single commit.

    Owner promotions are applied before Owner demotions so a single batch can
    safely process mixed owner updates without transient last-owner failures.
    """
    group = _get_group_or_404(db, group_name)
    updater_role = _get_role_updater_role(db, group_name, updated_by_user_id)

    namespace_id = get_namespace_id_by_name(db, group_name)
    user_ids = [update.user_id for update in updates]
    members = (
        db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
            ResourceMember.resource_id == namespace_id,
            ResourceMember.user_id.in_(user_ids),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .all()
    )
    members_by_user_id = {member.user_id: member for member in members}

    owner_count = count_group_members_by_role(db, group_name, GroupRole.Owner.value)
    failed_updates: dict[int, GroupMemberBatchUpdateFailedItem] = {}
    successful_user_ids: set[int] = set()
    processed_updates = sorted(
        enumerate(updates),
        key=lambda item: (
            _get_batch_role_update_priority(
                members_by_user_id.get(item[1].user_id), item[1].role
            ),
            item[0],
        ),
    )

    for _, update in processed_updates:
        member = members_by_user_id.get(update.user_id)
        if not member:
            failed_updates[update.user_id] = GroupMemberBatchUpdateFailedItem(
                user_id=update.user_id,
                role=update.role,
                error="Member not found",
                error_code=None,
            )
            continue

        try:
            _validate_member_role_change(member, update.role, updater_role)
            _validate_current_group_owner_role_change(group, member, update.role)

            current_role = GroupRole(member.role)
            if current_role == GroupRole.Owner and update.role != GroupRole.Owner:
                if owner_count <= 1:
                    raise HTTPException(
                        status_code=400,
                        detail="Cannot change role of the last owner. Add another owner first.",
                    )
                owner_count -= 1
            elif current_role != GroupRole.Owner and update.role == GroupRole.Owner:
                owner_count += 1

            member.role = update.role.value
            successful_user_ids.add(update.user_id)
        except HTTPException as exc:
            failed_updates[update.user_id] = GroupMemberBatchUpdateFailedItem(
                user_id=update.user_id,
                role=update.role,
                error=str(exc.detail),
                error_code=getattr(exc, "error_code", None),
            )

    if successful_user_ids:
        db.commit()
        for user_id in successful_user_ids:
            db.refresh(members_by_user_id[user_id])

    updated_members = [
        _build_group_member_response(members_by_user_id[update.user_id], group_name)
        for update in updates
        if update.user_id in successful_user_ids
    ]
    failed_items = [
        failed_updates[update.user_id]
        for update in updates
        if update.user_id in failed_updates
    ]

    return GroupMemberBatchUpdateResponse(
        updated_members=updated_members,
        failed_updates=failed_items,
        total_updated=len(updated_members),
        total_failed=len(failed_items),
    )


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
    current_owner_member = get_group_member(db, group_name, current_owner_user_id)
    new_owner_member = get_group_member(db, group_name, new_owner_user_id)

    # Update group owner
    group.owner_user_id = new_owner_user_id

    # Update member roles
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
    existing_members = get_group_members(db, group_name)
    existing_member_ids = {m.user_id for m in existing_members}

    # Create new members
    new_members = []
    for user in all_users:
        if user.id not in existing_member_ids:
            new_member = ResourceMember(
                resource_type=NAMESPACE_RESOURCE_TYPE,
                resource_id=group.id,
                user_id=user.id,
                role=GroupRole.Reporter.value,
                status=MemberStatus.APPROVED.value,
                invited_by_user_id=invited_by_user_id,
                share_link_id=0,
                reviewed_by_user_id=0,
                copied_resource_id=0,
                requested_at=datetime.now(),
            )
            db.add(new_member)
            new_members.append(new_member)

    if new_members:
        db.commit()
        for member in new_members:
            db.refresh(member)

    # Build responses
    result = []
    for member in new_members:
        response_data = {
            "id": member.id,
            "group_name": group_name,
            "user_id": member.user_id,
            "role": member.role,
            "invited_by_user_id": member.invited_by_user_id,
            "is_active": member.status == MemberStatus.APPROVED.value,
            "created_at": member.created_at,
            "updated_at": member.updated_at,
        }
        result.append(GroupMemberResponse(**response_data))

    return result


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
