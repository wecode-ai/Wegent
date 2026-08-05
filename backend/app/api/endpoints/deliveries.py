# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated project TODO and delivery endpoints."""

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.config import settings
from app.core.security import get_current_user
from app.models.delivery import Delivery
from app.models.user import User
from app.schemas.delivery import (
    CloudTaskContextResponse,
    DeliveryAssetAccessResponse,
    DeliveryAssetResponse,
    DeliveryCreate,
    DeliveryDetailResponse,
    DeliveryListResponse,
    DeliveryResponse,
    LoopItemAttachmentAccessResponse,
    LoopItemAttachmentResponse,
    LoopItemCollaboratorCreate,
    LoopItemCollaboratorResponse,
    LoopItemCommentCreate,
    LoopItemCommentResponse,
    LoopItemCreate,
    LoopItemListResponse,
    LoopItemReorder,
    LoopItemResponse,
    LoopItemTaskBind,
    LoopItemTaskBindingResponse,
    LoopItemUpdate,
    MyWorkItemResponse,
    MyWorkListResponse,
    RuntimeTaskTrack,
    RuntimeTaskTrackingStatusUpdate,
    RuntimeTaskTrackResponse,
)
from app.services.cloud_projects import cloud_project_service
from app.services.delivery import delivery_service
from app.services.loop_items import loop_item_service
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import (
    loop_item_attachment_provider_router,
    loop_item_provider_router,
)

router = APIRouter()


def _loop_item_response(
    db: Session, item: object, current_user: User
) -> LoopItemResponse:
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, current_user.id)
    )


def _delivery_response(db: Session, delivery: Delivery) -> DeliveryResponse:
    return DeliveryResponse.model_validate(
        {
            **delivery.__dict__,
            "assets": delivery_service.list_assets(db, delivery.id),
        }
    )


@router.get("/cloud-work-items/my-work", response_model=MyWorkListResponse)
def list_my_work(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> MyWorkListResponse:
    items = loop_item_service.list_my_work(db, current_user.id)
    return MyWorkListResponse(
        items=[MyWorkItemResponse.model_validate(item) for item in items]
    )


@router.get(
    "/loop-items/{item_id}/collaborators",
    response_model=list[LoopItemCollaboratorResponse],
)
def list_loop_item_collaborators(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[LoopItemCollaboratorResponse]:
    collaborators = loop_item_service.list_collaborators(db, item_id, current_user.id)
    return [
        LoopItemCollaboratorResponse.model_validate(collaborator)
        for collaborator in collaborators
    ]


@router.post(
    "/loop-items/{item_id}/collaborators",
    response_model=LoopItemCollaboratorResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_collaborator(
    item_id: str,
    values: LoopItemCollaboratorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemCollaboratorResponse:
    collaborator = loop_item_service.add_collaborator(
        db, item_id, values.user_id, current_user.id
    )
    return LoopItemCollaboratorResponse.model_validate(collaborator)


@router.delete(
    "/loop-items/{item_id}/collaborators/{collaborator_user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_loop_item_collaborator(
    item_id: str,
    collaborator_user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    loop_item_service.remove_collaborator(
        db, item_id, collaborator_user_id, current_user.id
    )


@router.get("/runtime-tasks/loop-item", response_model=LoopItemResponse)
def find_runtime_task_loop_item(
    device_id: str = Query(min_length=1),
    task_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    item = loop_item_service.find_for_runtime_task(
        db, current_user.id, device_id, task_id
    )
    return _loop_item_response(db, item, current_user)


@router.get("/runtime-tasks/cloud-context", response_model=CloudTaskContextResponse)
def find_runtime_task_cloud_context(
    device_id: str = Query(min_length=1),
    task_id: str = Query(min_length=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> CloudTaskContextResponse:
    binding, project, item = loop_item_service.find_cloud_context(
        db, current_user.id, device_id, task_id
    )
    return CloudTaskContextResponse.model_validate(
        {
            **binding.__dict__,
            "project": {
                **project.__dict__,
                "current_user_id": current_user.id,
                "current_user_name": current_user.user_name,
                "access_role": cloud_project_service.access(
                    db, project.id, current_user.id
                ).role,
            },
            "loop_item": (
                loop_item_service.response_values(db, item, current_user.id)
                if item is not None
                else None
            ),
        }
    )


@router.post(
    "/cloud-projects/{project_id}/tasks",
    response_model=LoopItemTaskBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
def bind_cloud_project_task(
    project_id: int,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemTaskBindingResponse:
    binding = loop_item_service.bind_project_task(
        db, project_id, values, current_user.id
    )
    return LoopItemTaskBindingResponse.model_validate(binding)


def _tracked_item_response(
    db: Session,
    item_id: str,
    current_user: User,
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        return LoopItemResponse.model_validate(
            external_loop_item_provider.get(db, item_id, current_user.id)
        )
    item = loop_item_service.get(db, item_id, current_user.id)
    return _loop_item_response(db, item, current_user)


@router.post(
    "/cloud-projects/{project_id}/tasks/track",
    response_model=RuntimeTaskTrackResponse,
    status_code=status.HTTP_201_CREATED,
)
def track_cloud_project_task(
    project_id: int,
    values: RuntimeTaskTrack,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> RuntimeTaskTrackResponse:
    existing = loop_item_service.find_active_task_binding(
        db, current_user.id, values.device_id, values.task_id
    )
    if existing is not None and existing.loop_item_id:
        if str(existing.cloud_project_id) != str(project_id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Runtime task is already tracked by another project",
            )
        return RuntimeTaskTrackResponse(
            item=_tracked_item_response(db, existing.loop_item_id, current_user),
            binding=LoopItemTaskBindingResponse.model_validate(existing),
        )

    project = cloud_project_service.get(db, project_id, current_user.id)
    created = loop_item_provider_router.create(
        db,
        project,
        current_user,
        LoopItemCreate(
            title=values.task_title,
            description=values.description,
            status="in_progress",
        ),
    )
    item_id = str(created.values["id"])
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    binding = loop_item_service.bind_task(
        db, item_id, values.binding(), current_user.id
    )
    return RuntimeTaskTrackResponse(
        item=LoopItemResponse.model_validate(created.values),
        binding=LoopItemTaskBindingResponse.model_validate(binding),
    )


@router.patch(
    "/runtime-tasks/cloud-context/tracking-status",
    response_model=LoopItemResponse | None,
)
def update_runtime_task_tracking_status(
    values: RuntimeTaskTrackingStatusUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse | None:
    binding = loop_item_service.find_active_task_binding(
        db, current_user.id, values.device_id, values.task_id
    )
    if binding is None or not binding.loop_item_id:
        return None
    item = _tracked_item_response(db, binding.loop_item_id, current_user)
    next_status: str | None = None
    if values.execution_status == "running" and item.status in {
        "inbox",
        "pending",
        "in_review",
    }:
        next_status = "in_progress"
    elif values.execution_status == "succeeded" and item.status == "in_progress":
        next_status = "in_review"
    if next_status is None:
        return item
    if external_loop_item_provider.is_external_item(db, item.id):
        updated = external_loop_item_provider.update(
            db,
            item.id,
            current_user.id,
            LoopItemUpdate(version=item.version, status=next_status),
        )
        return LoopItemResponse.model_validate(updated)
    stored = loop_item_service.update(
        db,
        item.id,
        current_user.id,
        LoopItemUpdate(version=item.version, status=next_status),
    )
    return _loop_item_response(db, stored, current_user)


@router.delete("/runtime-tasks/cloud-context", status_code=status.HTTP_204_NO_CONTENT)
def unbind_runtime_task_cloud_context(
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    loop_item_service.unbind_cloud_context(db, values, current_user.id)


@router.get(
    "/cloud-projects/{project_id}/loop-items",
    response_model=LoopItemListResponse,
)
def list_loop_items(
    project_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemListResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    if project.task_provider in {"github", "gitlab"}:
        return LoopItemListResponse(
            items=[
                LoopItemResponse.model_validate(item)
                for item in external_loop_item_provider.list(
                    db, project_id, current_user.id
                )
            ]
        )
    items = loop_item_service.list(db, project_id, current_user.id)
    access = cloud_project_service.access(db, project_id, current_user.id)
    return LoopItemListResponse(
        items=[
            LoopItemResponse.model_validate(
                loop_item_service.response_values(
                    db, item, current_user.id, access=access
                )
            )
            for item in items
        ]
    )


@router.post(
    "/cloud-projects/{project_id}/loop-items",
    response_model=LoopItemResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_loop_item(
    project_id: int,
    values: LoopItemCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    created = loop_item_provider_router.create(db, project, current_user, values)
    return LoopItemResponse.model_validate(created.values)


@router.post(
    "/cloud-projects/{project_id}/loop-items/reorder",
    response_model=LoopItemListResponse,
)
def reorder_loop_items(
    project_id: int,
    values: LoopItemReorder,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemListResponse:
    project = cloud_project_service.get(db, project_id, current_user.id)
    if project.task_provider in {"github", "gitlab"}:
        return LoopItemListResponse(
            items=[
                LoopItemResponse.model_validate(item)
                for item in external_loop_item_provider.list(
                    db, project_id, current_user.id
                )
            ]
        )
    items = loop_item_service.reorder(db, project_id, current_user.id, values)
    return LoopItemListResponse(
        items=[_loop_item_response(db, item, current_user) for item in items]
    )


@router.get("/loop-items/{item_id}", response_model=LoopItemResponse)
def get_loop_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        return LoopItemResponse.model_validate(
            external_loop_item_provider.get(db, item_id, current_user.id)
        )
    item = loop_item_service.get(db, item_id, current_user.id)
    return _loop_item_response(db, item, current_user)


@router.patch("/loop-items/{item_id}", response_model=LoopItemResponse)
def update_loop_item(
    item_id: str,
    values: LoopItemUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemResponse:
    if external_loop_item_provider.is_external_item(db, item_id):
        return LoopItemResponse.model_validate(
            external_loop_item_provider.update(db, item_id, current_user.id, values)
        )
    item = loop_item_service.update(db, item_id, current_user.id, values)
    return _loop_item_response(db, item, current_user)


@router.delete("/loop-items/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_loop_item(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    if external_loop_item_provider.is_external_item(db, item_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "External provider tasks cannot be archived from Wegent",
        )
    loop_item_service.delete(db, item_id, current_user.id)


@router.post(
    "/loop-items/{item_id}/comments",
    response_model=LoopItemCommentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_comment(
    item_id: str,
    values: LoopItemCommentCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemCommentResponse:
    return LoopItemCommentResponse.model_validate(
        external_loop_item_provider.add_comment(
            db, item_id, current_user.id, values.body
        )
    )


@router.get(
    "/loop-items/{item_id}/attachments",
    response_model=list[LoopItemAttachmentResponse],
)
def list_loop_item_attachments(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[LoopItemAttachmentResponse]:
    attachments = loop_item_attachment_provider_router.list(
        db, item_id, current_user.id
    )
    return [LoopItemAttachmentResponse.model_validate(item) for item in attachments]


@router.post(
    "/loop-items/{item_id}/attachments",
    response_model=LoopItemAttachmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_loop_item_attachment(
    item_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemAttachmentResponse:
    attachment = loop_item_attachment_provider_router.add(
        db,
        item_id,
        current_user.id,
        file.filename or "attachment",
        file.content_type or "application/octet-stream",
        file.file,
        settings.DELIVERY_MAX_ASSET_SIZE_MB * 1024 * 1024,
    )
    return LoopItemAttachmentResponse.model_validate(attachment)


@router.get(
    "/loop-item-attachments/{attachment_id}/access",
    response_model=LoopItemAttachmentAccessResponse,
)
def access_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemAttachmentAccessResponse:
    loop_item_attachment_provider_router.require_access(
        db, attachment_id, current_user.id
    )
    return LoopItemAttachmentAccessResponse(
        url=f"wegent://attachments/{attachment_id}",
        expires_in_seconds=0,
    )


@router.get("/loop-item-attachments/{attachment_id}/content")
def read_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Response:
    content, content_type, filename = loop_item_attachment_provider_router.content(
        db, attachment_id, current_user.id
    )
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@router.delete(
    "/loop-item-attachments/{attachment_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_loop_item_attachment(
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    loop_item_attachment_provider_router.delete(db, attachment_id, current_user.id)


@router.get(
    "/loop-items/{item_id}/tasks",
    response_model=list[LoopItemTaskBindingResponse],
)
def list_loop_item_tasks(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[LoopItemTaskBindingResponse]:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    bindings = loop_item_service.list_task_bindings(db, item_id, current_user.id)
    return [LoopItemTaskBindingResponse.model_validate(binding) for binding in bindings]


@router.delete(
    "/loop-items/{item_id}/tasks",
    status_code=status.HTTP_204_NO_CONTENT,
)
def unbind_loop_item_task(
    item_id: str,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    loop_item_service.unbind_task(db, item_id, values, current_user.id)


@router.post(
    "/loop-items/{item_id}/tasks",
    response_model=LoopItemTaskBindingResponse,
    status_code=status.HTTP_201_CREATED,
)
def bind_loop_item_task(
    item_id: str,
    values: LoopItemTaskBind,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> LoopItemTaskBindingResponse:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    binding = loop_item_service.bind_task(db, item_id, values, current_user.id)
    return LoopItemTaskBindingResponse.model_validate(binding)


@router.post(
    "/loop-items/{item_id}/deliveries",
    response_model=DeliveryResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_delivery(
    item_id: str,
    values: DeliveryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryResponse:
    external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)
    delivery = delivery_service.create_delivery(db, item_id, current_user.id, values)
    return _delivery_response(db, delivery)


@router.post(
    "/deliveries/{delivery_id}/assets",
    response_model=DeliveryAssetResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_delivery_asset(
    delivery_id: str,
    file: UploadFile = File(...),
    relative_path: str = Form(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryAssetResponse:
    asset = delivery_service.add_asset(
        db,
        delivery_id,
        current_user.id,
        relative_path,
        file.filename or relative_path,
        file.content_type or "application/octet-stream",
        file.file,
    )
    return DeliveryAssetResponse.model_validate(asset)


@router.get(
    "/delivery-assets/{asset_id}/access",
    response_model=DeliveryAssetAccessResponse,
)
def access_delivery_asset(
    asset_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryAssetAccessResponse:
    return DeliveryAssetAccessResponse(
        url=delivery_service.access_asset_url(db, asset_id, current_user.id)
    )


@router.delete("/deliveries/{delivery_id}", status_code=status.HTTP_204_NO_CONTENT)
def discard_delivery_draft(
    delivery_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    delivery_service.discard_draft(db, delivery_id, current_user.id)


@router.post("/deliveries/{delivery_id}/finalize", response_model=DeliveryResponse)
def finalize_delivery(
    delivery_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryResponse:
    delivery = delivery_service.finalize(db, delivery_id, current_user.id)
    return _delivery_response(db, delivery)


@router.get("/loop-items/{item_id}/deliveries", response_model=DeliveryListResponse)
def list_deliveries(
    item_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryListResponse:
    deliveries = delivery_service.list_deliveries(db, item_id, current_user.id)
    return DeliveryListResponse(
        items=[_delivery_response(db, item) for item in deliveries]
    )


@router.get("/deliveries/{delivery_id}", response_model=DeliveryDetailResponse)
def get_delivery(
    delivery_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> DeliveryDetailResponse:
    delivery = delivery_service.get_delivery(db, delivery_id, current_user.id)
    response = _delivery_response(db, delivery)
    return DeliveryDetailResponse(
        **response.model_dump(),
        markdown=delivery_service.read_markdown(delivery),
        chat=delivery_service.read_chat(delivery),
    )
