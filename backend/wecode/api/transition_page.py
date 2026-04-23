"""
Transition Page API Routes
"""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User

from wecode.schemas.transition_page import (
    BlockCreateRequest,
    BlockGroupCreateRequest,
    BlockGroupUpdateRequest,
    BlockUpdateRequest,
    GroupCreateRequest,
    GroupMemberInfo,
    GroupUpdateRequest,
    RenderedPageResponse,
    TransitionPageCreate,
    TransitionPageDetail,
    TransitionPageListItem,
    TransitionPageItemResponse,
    TransitionPageUpdate,
    UserImportResponse,
)
from wecode.services.transition_page import TransitionPageService

router = APIRouter(prefix="/transition-pages", tags=["transition-pages"])


def get_service(db: Session = Depends(get_db)) -> TransitionPageService:
    return TransitionPageService(db)


@router.get("", response_model=list[TransitionPageListItem])
def list_pages(
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> list[TransitionPageListItem]:
    pages = service.list_pages()
    return [
        TransitionPageListItem(
            page_id=p.page_id,
            slug=p.data_json.get("slug", ""),
            title=p.data_json.get("title", ""),
            status=p.data_json.get("status", "draft"),
            created_at=p.created_at,
            updated_at=p.updated_at,
        )
        for p in pages
    ]


@router.post("", response_model=TransitionPageItemResponse)
def create_page(
    req: TransitionPageCreate,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        page = service.create_page(req.title, req.slug)
        return TransitionPageItemResponse.model_validate(page)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{page_id}", response_model=TransitionPageDetail)
def get_page(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageDetail:
    page = service.get_page_by_id(page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    groups = service.list_groups(page_id)
    block_groups = service.list_block_groups(page_id)
    blocks = service.list_blocks(page_id)
    members = service.list_group_members(page_id)

    return TransitionPageDetail(
        page_id=page.page_id,
        slug=page.data_json.get("slug", ""),
        title=page.data_json.get("title", ""),
        status=page.data_json.get("status", "draft"),
        title_font_size=page.data_json.get("title_font_size"),
        groups=[{"key": g.key, **g.data_json} for g in groups],
        block_groups=[{"key": bg.key, **bg.data_json} for bg in block_groups],
        blocks=[{"key": b.key, "sort_order": b.sort_order, **b.data_json} for b in blocks],
        members=[GroupMemberInfo(**m.data_json) for m in members],
        created_at=page.created_at,
        updated_at=page.updated_at,
    )


@router.put("/{page_id}", response_model=TransitionPageItemResponse)
def update_page(
    page_id: str,
    req: TransitionPageUpdate,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        page = service.update_page(page_id, title=req.title, status=req.status, title_font_size=req.title_font_size)
        return TransitionPageItemResponse.model_validate(page)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{page_id}")
def delete_page(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    service.delete_page(page_id)
    return {"message": "Page deleted"}


@router.post("/{page_id}/groups", response_model=TransitionPageItemResponse)
def create_group(
    page_id: str,
    req: GroupCreateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        group = service.create_group(page_id, req.key, req.data)
        return TransitionPageItemResponse.model_validate(group)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{page_id}/groups/{group_key}", response_model=TransitionPageItemResponse)
def update_group(
    page_id: str,
    group_key: str,
    req: GroupUpdateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        group = service.update_group(page_id, group_key, req.data)
        return TransitionPageItemResponse.model_validate(group)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{page_id}/groups/{group_key}")
def delete_group(
    page_id: str,
    group_key: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    service.delete_group(page_id, group_key)
    return {"message": "Group deleted"}


# Block Group routes (for mutex functionality)
@router.get("/{page_id}/block-groups")
def list_block_groups(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all block groups for this page"""
    block_groups = service.list_block_groups(page_id)
    return [{"key": bg.key, **bg.data_json} for bg in block_groups]


@router.post("/{page_id}/block-groups", response_model=TransitionPageItemResponse)
def create_block_group(
    page_id: str,
    req: BlockGroupCreateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        group = service.create_block_group(page_id, req.key, req.data)
        return TransitionPageItemResponse.model_validate(group)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{page_id}/block-groups/{block_group_key}", response_model=TransitionPageItemResponse)
def update_block_group(
    page_id: str,
    block_group_key: str,
    req: BlockGroupUpdateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        group = service.update_block_group(page_id, block_group_key, req.data)
        return TransitionPageItemResponse.model_validate(group)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{page_id}/block-groups/{block_group_key}")
def delete_block_group(
    page_id: str,
    block_group_key: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    service.delete_block_group(page_id, block_group_key)
    return {"message": "Block group deleted"}


@router.post("/{page_id}/blocks", response_model=TransitionPageItemResponse)
def create_block(
    page_id: str,
    req: BlockCreateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        block = service.create_block(page_id, req.key, req.data, req.sort_order or 0)
        return TransitionPageItemResponse.model_validate(block)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/{page_id}/blocks/{block_key}", response_model=TransitionPageItemResponse)
def update_block(
    page_id: str,
    block_key: str,
    req: BlockUpdateRequest,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    try:
        block = service.update_block(page_id, block_key, data=req.data, sort_order=req.sort_order)
        return TransitionPageItemResponse.model_validate(block)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{page_id}/blocks/{block_key}")
def delete_block(
    page_id: str,
    block_key: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    service.delete_block(page_id, block_key)
    return {"message": "Block deleted"}


@router.post("/{page_id}/groups/{group_key}/members", response_model=TransitionPageItemResponse)
def add_group_member(
    page_id: str,
    group_key: str,
    req: dict[str, Any],
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> TransitionPageItemResponse:
    """Add a member to a group"""
    try:
        email = req.get("email", "")
        if not email:
            raise HTTPException(status_code=400, detail="Email is required")
        member = service.add_group_member(page_id, email, group_key)
        return TransitionPageItemResponse.model_validate(member)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/{page_id}/members/{email}")
def delete_member(
    page_id: str,
    email: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    service.delete_group_member(page_id, email)
    return {"message": "Member deleted"}


@router.post("/{page_id}/import", response_model=UserImportResponse)
def import_users(
    page_id: str,
    file: UploadFile = File(...),
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> UserImportResponse:
    try:
        content = file.file.read().decode("utf-8")
        result = service.import_users_from_csv(page_id, content)
        return UserImportResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{page_id}/export")
def export_users(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    try:
        csv_content = service.export_users_to_csv(page_id)
        return {"content": csv_content, "filename": f"users_{page_id}.csv"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{page_id}/members/{email}/content")
def get_member_content(
    page_id: str,
    email: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    item = service.get_user_content(page_id, email)
    if not item:
        return {"content": {}}
    return {"content": item.data_json.get("content", {})}


@router.put("/{page_id}/members/{email}/content")
def update_member_content(
    page_id: str,
    email: str,
    req: dict[str, Any],
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    content = req.get("content", {})
    service.set_user_content(page_id, email, content)
    return {"message": "Content updated"}


@router.get("/by-slug/{slug}/render", response_model=RenderedPageResponse)
def render_page(
    slug: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> RenderedPageResponse:
    """Render page by slug for current user"""
    try:
        user_email = current_user.email
        if not user_email:
            raise HTTPException(status_code=400, detail="User email not found")
        return service.render_page(slug, user_email)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{page_id}/my-views")
def get_my_views(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Get current user's viewed blocks for this page"""
    user_email = current_user.email
    if not user_email:
        raise HTTPException(status_code=400, detail="User email not found")

    user_view = service.get_user_view(page_id, user_email)
    if not user_view or page_id not in user_view.data_json:
        return {"viewed_blocks": {}}

    return {"viewed_blocks": user_view.data_json[page_id].get("viewed_blocks", {})}


@router.get("/{page_id}/user-views")
def list_user_views(
    page_id: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List all user view records for this page (admin only)"""
    views = service.list_user_views(page_id)
    result = []
    for view in views:
        email = view.data_json.get("email", view.key.replace("user:", ""))
        viewed_blocks = view.data_json.get(page_id, {}).get("viewed_blocks", {})
        result.append({
            "email": email,
            "viewed_blocks": viewed_blocks,
            "updated_at": view.updated_at.isoformat() if view.updated_at else None,
        })
    return result


@router.delete("/{page_id}/user-views/{email}")
def delete_user_view(
    page_id: str,
    email: str,
    service: TransitionPageService = Depends(get_service),
    current_user: User = Depends(get_current_user),
) -> dict[str, str]:
    """Delete user's view record for this page (admin only)"""
    service.delete_user_view(page_id, email)
    return {"message": "User view record deleted"}
