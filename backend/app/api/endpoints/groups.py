# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.namespace_member import NamespaceMember
from app.models.user import User
from app.schemas.namespace import (
    GroupCreate,
    GroupListResponse,
    GroupResponse,
    GroupRole,
    GroupUpdate,
)
from app.schemas.namespace_member import (
    AddMemberResult,
    GroupMemberCreate,
    GroupMemberResponse,
    GroupMemberUpdate,
)
from app.services import group_service
from app.services.group_permission import get_effective_role_in_group

router = APIRouter()


@router.get("", response_model=GroupListResponse)
def list_groups(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(10, ge=1, le=100, description="Items per page"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    List all groups where the current user is a member (created or joined).
    Returns paginated results.
    """
    skip = (page - 1) * limit
    groups = group_service.list_user_groups(
        db=db, user_id=current_user.id, skip=skip, limit=limit
    )

    # Calculate total count
    if page == 1 and len(groups) < limit:
        total = len(groups)
    else:
        # Get total count of user's groups
        all_groups = group_service.list_user_groups(
            db=db, user_id=current_user.id, skip=0, limit=1000
        )
        total = len(all_groups)

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
            db=db, group_data=group_create, owner_user_id=current_user.id
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
    # Check if user has access (direct or inherited)
    user_role = get_effective_role_in_group(db, current_user.id, group_name)

    if user_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group",
        )

    # Get all active members with user information
    members = (
        db.query(NamespaceMember)
        .filter(
            NamespaceMember.group_name == group_name,
            NamespaceMember.is_active == True,
        )
        .all()
    )

    # Enrich with user names
    result = []
    for m in members:
        member_dict = {
            "id": m.id,
            "group_name": m.group_name,
            "user_id": m.user_id,
            "role": m.role,
            "invited_by_user_id": m.invited_by_user_id,
            "is_active": m.is_active,
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
    Only Maintainers and Owners can add members.
    """
    try:
        return group_service.add_member(
            db=db,
            group_name=group_name,
            user_id=member_create.user_id,
            role=member_create.role,
            invited_by_user_id=current_user.id,
        )
    except HTTPException:
        raise
    except Exception as e:
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
    Only the group Owner can update member roles.
    """
    try:
        return group_service.update_member_role(
            db=db,
            group_name=group_name,
            user_id=user_id,
            new_role=member_update.role,
            updated_by_user_id=current_user.id,
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to update member role: {str(e)}",
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
            db=db, group_name=group_name, invited_by_user_id=current_user.id
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
    # Check if user has access (direct or inherited)
    user_role = get_effective_role_in_group(db, current_user.id, group_name)

    if user_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this group",
        )

    group = group_service.get_group(db=db, group_name=group_name)

    if not group:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Group not found",
        )

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
            db=db, group_name=group_name, user_id=current_user.id
        )
        return None
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to delete group: {str(e)}",
        )
