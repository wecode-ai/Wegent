# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.group_entity_member import (
    BatchFailedItem,
    GroupEntityMemberBatchCreate,
    GroupEntityMemberBatchResponse,
    GroupEntityMemberCreate,
    GroupEntityMemberResponse,
    GroupEntityMemberUpdate,
)
from app.schemas.namespace import (
    GroupCreate,
    GroupListResponse,
    GroupResponse,
    GroupRole,
    GroupUpdate,
)
from app.schemas.namespace_member import (
    AddMemberResult,
    GroupMemberBatchUpdateRequest,
    GroupMemberBatchUpdateResponse,
    GroupMemberCreate,
    GroupMemberResponse,
    GroupMemberUpdate,
)
from app.services import group_service
from app.services.group_member_helper import (
    MAX_ENTITY_MEMBERS_PER_GROUP,
    create_group_entity_member,
    create_group_entity_members_batch,
    delete_group_entity_member,
    get_group_entity_members,
    update_group_entity_member_role,
)
from app.services.group_permission import get_view_role_in_group
from app.services.share.external_entity_resolver import (
    get_all_entity_types,
    get_entity_resolver,
)
from shared.telemetry.decorators import trace_sync

router = APIRouter()


@router.get("", response_model=GroupListResponse)
def list_groups(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(100, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all groups where the current user is a member (created or joined).
    Returns paginated results.
    """
    skip = (page - 1) * limit
    groups = group_service.list_user_groups(
        db=db,
        user_id=current_user.id,
        skip=skip,
        limit=limit,
        user_role=current_user.role,
    )

    # Calculate total count
    if page == 1 and len(groups) < limit:
        total = len(groups)
    else:
        # Get total count of user's groups
        all_groups = group_service.list_user_groups(
            db=db,
            user_id=current_user.id,
            skip=0,
            limit=1000,
            user_role=current_user.role,
        )
        total = len(all_groups)

    return GroupListResponse(total=total, items=groups)


@router.get("/search", response_model=GroupListResponse)
def search_groups_endpoint(
    q: str = Query(
        "",
        min_length=0,
        max_length=100,
        description="Search query for group name or display_name",
    ),
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Search groups by name or display_name.
    Only returns groups with level='group' (filters out organization-level groups).
    Results are limited to groups where the current user is a member.
    Returns paginated results.
    """
    skip = (page - 1) * limit
    groups, total = group_service.search_groups(
        db=db,
        q=q,
        skip=skip,
        limit=limit,
        user_id=current_user.id,
        user_role=current_user.role,
    )
    return GroupListResponse(total=total, items=groups)


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
def create_group_endpoint(
    group_create: GroupCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new group.
    The current user becomes the group owner.
    """
    try:
        return group_service.create_group(
            db=db,
            group_data=group_create,
            owner_user_id=current_user.id,
            user_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create group: {str(e)}",
        )


# ============================================================================
# Member management routes - MUST come before generic {group_name:path} routes
# ============================================================================


@router.get("/{group_name:path}/members", response_model=list[GroupMemberResponse])
def list_members(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get list of all members in the group.
    User must be a member of the group to view the member list.
    """
    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    user_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if user_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group",
        )

    # Get all approved USER members only (entity members have separate endpoint)
    members = (
        db.query(ResourceMember)
        .join(Namespace, Namespace.id == ResourceMember.resource_id)
        .filter(
            ResourceMember.resource_type == "Namespace",
            Namespace.name == group_name,
            ResourceMember.entity_type == "user",
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .order_by(ResourceMember.id.asc())
        .all()
    )

    # Enrich with user names
    result = []
    for m in members:
        member_dict = {
            "id": m.id,
            "group_name": group_name,
            "user_id": m.user_id,
            "role": m.role,
            "invited_by_user_id": m.invited_by_user_id,
            "is_active": True,  # ResourceMember uses status instead
            "created_at": m.created_at,
            "updated_at": m.updated_at,
        }

        # Get user name
        user = db.query(User).filter(User.id == m.user_id).first()
        if user:
            member_dict["user_name"] = user.user_name

        # Get invited_by user name
        if m.invited_by_user_id:
            invited_by_user = (
                db.query(User).filter(User.id == m.invited_by_user_id).first()
            )
            if invited_by_user:
                member_dict["invited_by_user_name"] = invited_by_user.user_name

        result.append(GroupMemberResponse(**member_dict))

    return result


@router.get(
    "/{group_name:path}/entity-members",
    response_model=list[GroupEntityMemberResponse],
)
@trace_sync("list_entity_members", "groups.api")
def list_entity_members(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[GroupEntityMemberResponse]:
    """Get list of entity-type members in the group.

    User must be a member of the group to view the member list.
    """
    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    user_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if user_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group",
        )

    members = get_group_entity_members(db, group_name)

    # Batch resolve inviter user names
    inviter_ids = {m.invited_by_user_id for m in members if m.invited_by_user_id}
    inviters = (
        db.query(User.id, User.user_name).filter(User.id.in_(inviter_ids)).all()
        if inviter_ids
        else []
    )
    inviter_map = {u.id: u.user_name for u in inviters}

    return [
        GroupEntityMemberResponse(
            entity_type=m.entity_type,
            entity_id=m.entity_id,
            entity_display_name=m.entity_display_name or None,
            role=m.role,
            invited_by_user_id=m.invited_by_user_id,
            invited_by_user_name=inviter_map.get(m.invited_by_user_id),
            created_at=m.created_at,
        )
        for m in members
    ]


@router.post(
    "/{group_name:path}/entity-members",
    response_model=GroupEntityMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync("add_entity_member", "groups.api")
def add_entity_member_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    member_create: GroupEntityMemberCreate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GroupEntityMemberResponse:
    """Add an entity-type member to the group.

    Only Owners can add entity members.
    """
    from app.schemas.namespace import GroupRole

    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    inviter_group_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if inviter_group_role != GroupRole.Owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owners can add entity members",
        )

    # Validate entity_type is registered
    if member_create.entity_type not in get_all_entity_types():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown or unsupported entity type: {member_create.entity_type}",
        )

    # Validate entity_id via resolver if implemented
    resolver = get_entity_resolver(member_create.entity_type)
    if resolver and not resolver.validate_entity_id(db, member_create.entity_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid entity_id: {member_create.entity_id}",
        )

    # Check for duplicate before creating
    existing = next(
        (
            m
            for m in get_group_entity_members(db, group_name)
            if m.entity_type == member_create.entity_type
            and m.entity_id == member_create.entity_id
        ),
        None,
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Entity member ({member_create.entity_type}, {member_create.entity_id}) "
                "already exists in this group"
            ),
        )

    # Check entity member limit
    existing_entity_count = len(get_group_entity_members(db, group_name))
    if existing_entity_count >= MAX_ENTITY_MEMBERS_PER_GROUP:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Group entity member limit reached: {MAX_ENTITY_MEMBERS_PER_GROUP}",
        )

    member = create_group_entity_member(
        db=db,
        group_name=group_name,
        entity_type=member_create.entity_type,
        entity_id=member_create.entity_id,
        role=member_create.role.value,
        entity_display_name=member_create.entity_display_name,
        invited_by_user_id=current_user.id,
    )
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Entity member ({member_create.entity_type}, {member_create.entity_id}) "
                "already exists in this group"
            ),
        ) from None
    db.refresh(member)

    logger.info(
        f"Entity member added: group={group_name}, "
        f"entity_type={member.entity_type}, entity_id={member.entity_id}, "
        f"role={member.role}, by_user={current_user.id}"
    )

    return GroupEntityMemberResponse(
        entity_type=member.entity_type,
        entity_id=member.entity_id,
        entity_display_name=member.entity_display_name or None,
        role=member.role,
        invited_by_user_id=member.invited_by_user_id,
        created_at=member.created_at,
    )


@router.delete(
    "/{group_name:path}/entity-members/{entity_type}/{entity_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
@trace_sync("remove_entity_member", "groups.api")
def remove_entity_member_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    entity_type: str = Path(..., description="Entity type"),
    entity_id: str = Path(..., description="Entity identifier"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Remove an entity-type member from the group.

    Only Owners can remove entity members.
    """
    from app.schemas.namespace import GroupRole

    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    if entity_type in ("user", "namespace"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove user or namespace members via entity-members endpoint",
        )

    remover_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if remover_role != GroupRole.Owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owners can remove entity members",
        )

    deleted = delete_group_entity_member(db, group_name, entity_type, entity_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Entity member not found",
        )
    db.commit()

    logger.info(
        f"Entity member removed: group={group_name}, "
        f"entity_type={entity_type}, entity_id={entity_id}, "
        f"by_user={current_user.id}"
    )
    return None


@router.put(
    "/{group_name:path}/entity-members/{entity_type}/{entity_id}",
    response_model=GroupEntityMemberResponse,
)
@trace_sync("update_entity_member_role", "groups.api")
def update_entity_member_role_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    entity_type: str = Path(..., description="Entity type"),
    entity_id: str = Path(..., description="Entity identifier"),
    member_update: GroupEntityMemberUpdate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GroupEntityMemberResponse:
    """Update the role of an entity-type member.

    Only Owners can update entity member roles.
    """
    from app.schemas.namespace import GroupRole

    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    updater_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if updater_role != GroupRole.Owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owners can update entity member roles",
        )

    member = update_group_entity_member_role(
        db, group_name, entity_type, entity_id, member_update.role.value
    )
    if not member:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Entity member not found",
        )
    db.commit()
    db.refresh(member)

    logger.info(
        f"Entity member role updated: group={group_name}, "
        f"entity_type={member.entity_type}, entity_id={member.entity_id}, "
        f"new_role={member.role}, by_user={current_user.id}"
    )

    return GroupEntityMemberResponse(
        entity_type=member.entity_type,
        entity_id=member.entity_id,
        entity_display_name=member.entity_display_name or None,
        role=member.role,
        invited_by_user_id=member.invited_by_user_id,
        invited_by_user_name=getattr(member, "invited_by_user_name", None),
        created_at=member.created_at,
    )


@router.post(
    "/{group_name:path}/entity-members/batch",
    response_model=GroupEntityMemberBatchResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync("add_entity_members_batch", "groups.api")
def add_entity_members_batch_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    batch_create: GroupEntityMemberBatchCreate = Body(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GroupEntityMemberBatchResponse:
    """Batch add entity-type members to a group.

    Returns both succeeded and failed items with error details.
    Only Owners can add entity members.
    """
    from app.schemas.namespace import GroupRole

    group = group_service.get_group(db=db, group_name=group_name)
    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    inviter_group_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if inviter_group_role != GroupRole.Owner:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owners can add entity members",
        )

    # Validate entity_type is registered and entity_id is valid
    registered_types = get_all_entity_types()
    for m in batch_create.members:
        if m.entity_type not in registered_types:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown entity type: {m.entity_type}",
            )

        # Validate entity_id via resolver if implemented
        resolver = get_entity_resolver(m.entity_type)
        if resolver and not resolver.validate_entity_id(db, m.entity_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid entity_id: {m.entity_id}",
            )

    # Call batch service
    try:
        succeeded_members, failed_items = create_group_entity_members_batch(
            db=db,
            group_name=group_name,
            members=batch_create.members,
            invited_by_user_id=current_user.id,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )

    return GroupEntityMemberBatchResponse(
        succeeded=[
            GroupEntityMemberResponse(
                entity_type=m.entity_type,
                entity_id=m.entity_id,
                entity_display_name=m.entity_display_name,
                role=m.role,
                invited_by_user_id=m.invited_by_user_id,
                created_at=m.created_at,
            )
            for m in succeeded_members
        ],
        failed=failed_items,
        total=len(batch_create.members),
        success_count=len(succeeded_members),
        failed_count=len(failed_items),
    )

    logger.info(
        f"Entity members batch added: group={group_name}, "
        f"succeeded={len(succeeded_members)}, failed={len(failed_items)}, "
        f"by_user={current_user.id}"
    )


@router.post(
    "/{group_name:path}/members",
    response_model=GroupMemberResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_member_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    member_create: GroupMemberCreate = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Add a member to the group.
    Only Owners and admins can add members.
    """
    try:
        return group_service.add_member(
            db=db,
            group_name=group_name,
            user_id=member_create.user_id,
            role=member_create.role,
            invited_by_user_id=current_user.id,
            inviter_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        import logging

        logging.getLogger(__name__).exception(f"Failed to add member: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to add member: {str(e)}",
        )


@router.post(
    "/{group_name:path}/members/by-username",
    response_model=AddMemberResult,
    status_code=status.HTTP_200_OK,
)
def add_member_by_username_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    username: str = Query(..., description="Username of the user to add"),
    role: GroupRole = Query(GroupRole.Reporter, description="Role to assign"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Add a member to the group by username.
    Only Maintainers and Owners can add members.
    Returns a result object with success status and message.
    """
    # Find user by username
    user = (
        db.query(User)
        .filter(User.user_name == username, User.is_active == True)
        .first()
    )

    if not user:
        return AddMemberResult(
            success=False, message=f"User '{username}' not found", data=None
        )

    try:
        member = group_service.add_member(
            db=db,
            group_name=group_name,
            user_id=user.id,
            role=role,
            invited_by_user_id=current_user.id,
            inviter_role=current_user.role,
        )
        return AddMemberResult(
            success=True, message="Member added successfully", data=member
        )
    except HTTPException as e:
        return AddMemberResult(success=False, message=e.detail, data=None)
    except Exception as e:
        return AddMemberResult(
            success=False, message=f"Failed to add member: {str(e)}", data=None
        )


@router.put("/{group_name:path}/members/{user_id}", response_model=GroupMemberResponse)
@trace_sync("update_group_member_role", "groups.api")
def update_member_role_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    user_id: int = Path(..., description="User ID"),
    member_update: GroupMemberUpdate = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update a member's role.
    Maintainers and Owners can update member roles.
    """
    try:
        return group_service.update_member_role(
            db=db,
            group_name=group_name,
            user_id=user_id,
            new_role=member_update.role,
            updated_by_user_id=current_user.id,
            updater_user_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update member role: {str(e)}",
        )


@router.put(
    "/{group_name:path}/members/batch/roles",
    response_model=GroupMemberBatchUpdateResponse,
)
@trace_sync("batch_update_group_member_roles", "groups.api")
def update_member_roles_batch_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    batch_update: GroupMemberBatchUpdateRequest = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch update multiple member roles with a single request.
    """
    try:
        return group_service.update_member_roles_batch(
            db=db,
            group_name=group_name,
            updates=batch_update.updates,
            updated_by_user_id=current_user.id,
            updater_user_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update member roles: {str(e)}",
        )


@router.delete(
    "/{group_name:path}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
def remove_member_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    user_id: int = Path(..., description="User ID"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Remove a member from the group.
    Owner can remove anyone, Maintainers can remove Developers and Reporters.
    Member's resources are transferred to the group owner.
    """
    try:
        group_service.remove_member(
            db=db,
            group_name=group_name,
            user_id=user_id,
            removed_by_user_id=current_user.id,
            remover_user_role=current_user.role,
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to remove member: {str(e)}",
        )


@router.post(
    "/{group_name:path}/members/invite-all",
    response_model=list[GroupMemberResponse],
    status_code=status.HTTP_201_CREATED,
)
def invite_all_users_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Invite all system users to the group as Reporters.
    Only Maintainers and Owners can invite users.
    """
    try:
        return group_service.invite_all_users(
            db=db,
            group_name=group_name,
            invited_by_user_id=current_user.id,
            inviter_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to invite users: {str(e)}",
        )


@router.post("/{group_name:path}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave_group_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Current user leaves the group.
    User's resources are transferred to the group owner.
    Cannot leave if you are the last owner.
    """
    try:
        group_service.remove_member(
            db=db,
            group_name=group_name,
            user_id=current_user.id,
            removed_by_user_id=current_user.id,  # Self-removal
            remover_user_role=current_user.role,
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to leave group: {str(e)}",
        )


@router.post("/{group_name:path}/transfer-ownership", response_model=GroupResponse)
def transfer_ownership_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    new_owner_user_id: int = Query(..., description="User ID of the new owner"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Transfer group ownership to another member.
    Only the current owner can transfer ownership.
    New owner must be at least a Maintainer.
    Current owner becomes a Maintainer after transfer.
    """
    try:
        return group_service.transfer_ownership(
            db=db,
            group_name=group_name,
            new_owner_user_id=new_owner_user_id,
            current_owner_user_id=current_user.id,
            current_user_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to transfer ownership: {str(e)}",
        )


# ============================================================================
# Generic group routes - MUST come after specific sub-routes
# ============================================================================


@router.get("/{group_name:path}", response_model=GroupResponse)
def get_group_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get group details by name.
    User must be a member of the group to view it.
    """
    group = group_service.get_group(db=db, group_name=group_name)

    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

    user_role = get_view_role_in_group(
        db,
        current_user.id,
        group_name,
        user_role=current_user.role,
        group_level=group.level,
    )
    if user_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group",
        )

    # Set the current user's role in the group
    group.my_role = user_role

    return group


@router.put("/{group_name:path}", response_model=GroupResponse)
def update_group_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    group_update: GroupUpdate = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update group information.
    Only Maintainers and Owners can update group info.
    """
    try:
        return group_service.update_group(
            db=db,
            group_name=group_name,
            update_data=group_update,
            user_id=current_user.id,
            user_role=current_user.role,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update group: {str(e)}",
        )


@router.delete("/{group_name:path}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group_endpoint(
    group_name: str = Path(
        ..., description="Group name (may contain slashes for subgroups)"
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete a group (hard delete).
    Only the group Owner can delete the group.
    Group must not have subgroups or resources.
    """
    try:
        group_service.delete_group(
            db=db,
            group_name=group_name,
            user_id=current_user.id,
            user_role=current_user.role,
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete group: {str(e)}",
        )
