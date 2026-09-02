# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime-native local work endpoints for Wework."""

from dataclasses import dataclass

from fastapi import APIRouter, Body, Depends, Query, Request
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.runtime_work import (
    ArchivedConversationsListRequest,
    ArchivedConversationsListResponse,
    BindRuntimeTaskIMSessionsRequest,
    BindRuntimeTaskIMSessionsResponse,
    DeviceWorkspacePrepareRequest,
    DeviceWorkspacePrepareResponse,
    DeviceWorkspaceResponse,
    DeviceWorkspaceUpsert,
    RuntimeArchivedConversationBulkRequest,
    RuntimeArchivedConversationBulkResponse,
    RuntimeArchiveProjectConversationsRequest,
    RuntimeFileChangesRevertRequest,
    RuntimeFileChangesRevertResponse,
    RuntimeGlobalIMNotificationUpdateRequest,
    RuntimeGuidanceRequest,
    RuntimeGuidanceResponse,
    RuntimeIMNotificationPresenceResponse,
    RuntimeIMNotificationPresenceUpdateRequest,
    RuntimeIMNotificationSettingsResponse,
    RuntimeSendRequest,
    RuntimeSendResponse,
    RuntimeTaskAddress,
    RuntimeTaskArchiveResponse,
    RuntimeTaskCancelResponse,
    RuntimeTaskCreateRequest,
    RuntimeTaskCreateResponse,
    RuntimeTaskForkRequest,
    RuntimeTaskForkResponse,
    RuntimeTaskIMNotificationSubscriptionRequest,
    RuntimeTaskIMNotificationSubscriptionResponse,
    RuntimeTaskQueueReorderRequest,
    RuntimeTaskQueueReorderResponse,
    RuntimeTaskRenameRequest,
    RuntimeTranscriptRequest,
    RuntimeTranscriptResponse,
    RuntimeWorkListResponse,
    RuntimeWorkSearchRequest,
    RuntimeWorkSearchResponse,
    RuntimeWorkspaceOpenRequest,
    RuntimeWorkspaceOpenResponse,
    RuntimeWorkspaceRemoveRequest,
    RuntimeWorkspaceRenameRequest,
    RuntimeWorkspaceSearchRequest,
    RuntimeWorkspaceSearchResponse,
    RuntimeWorktreeDeviceRequest,
    RuntimeWorktreePathRequest,
    RuntimeWorktreePreflightRequest,
    RuntimeWorktreePrepareRequest,
    RuntimeWorktreeSettingsPatch,
)
from app.services import runtime_work_service
from shared.telemetry.decorators import (
    add_span_event,
    set_span_attribute,
    trace_async,
)

router = APIRouter()


@dataclass(frozen=True)
class _RuntimeUser:
    id: int
    user_name: str | None


def _get_runtime_user(
    current_user: User = Depends(get_current_user),
) -> _RuntimeUser:
    """Detach the authenticated identity before an async route starts."""

    return _RuntimeUser(id=current_user.id, user_name=current_user.user_name)


def _runtime_worktree_payload(request: RuntimeWorktreeDeviceRequest) -> dict:
    return request.model_dump(by_alias=True, exclude_none=True)


async def _runtime_worktree_rpc(
    *,
    current_user: _RuntimeUser,
    request: RuntimeWorktreeDeviceRequest,
    method: str,
):
    return await runtime_work_service.call_runtime_worktree_rpc(
        user_id=current_user.id,
        device_id=request.device_id,
        method=method,
        payload=_runtime_worktree_payload(request),
    )


@router.get("", response_model=RuntimeWorkListResponse, response_model_by_alias=True)
async def list_runtime_work_endpoint(
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """List executor-local work grouped as projects and conversations."""

    return await runtime_work_service.list_runtime_work(
        user_id=current_user.id,
    )


@router.post("/worktrees/capabilities")
async def get_runtime_worktree_capabilities_endpoint(
    request: RuntimeWorktreeDeviceRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Read managed Worktree capability from the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.capabilities",
    )


@router.post("/worktrees/preflight")
async def preflight_runtime_worktree_endpoint(
    request: RuntimeWorktreePreflightRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Validate the addressed Runtime source workspace for Worktree use."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.preflight",
    )


@router.post("/worktrees/settings")
async def get_runtime_worktree_settings_endpoint(
    request: RuntimeWorktreeDeviceRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Read managed Worktree settings from the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.settings.get",
    )


@router.put("/worktrees/settings")
async def update_runtime_worktree_settings_endpoint(
    request: RuntimeWorktreeSettingsPatch,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Update managed Worktree settings on the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.settings.update",
    )


@router.post("/worktrees/list")
async def list_runtime_worktrees_endpoint(
    request: RuntimeWorktreeDeviceRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """List managed Worktrees from the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.list",
    )


@router.post("/worktrees/prepare")
async def prepare_runtime_worktree_endpoint(
    request: RuntimeWorktreePrepareRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Prepare one managed Worktree on the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.prepare",
    )


@router.post("/worktrees/delete")
async def delete_runtime_worktree_endpoint(
    request: RuntimeWorktreePathRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Delete one managed Worktree on the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.delete",
    )


@router.post("/worktrees/restore")
async def restore_runtime_worktree_endpoint(
    request: RuntimeWorktreePathRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Restore one managed Worktree snapshot on the addressed Runtime."""

    return await _runtime_worktree_rpc(
        current_user=current_user,
        request=request,
        method="runtime.worktrees.restore",
    )


@router.get(
    "/device-workspaces",
    response_model=list[DeviceWorkspaceResponse],
    response_model_by_alias=True,
)
def list_device_workspaces_endpoint(
    project_id: int | None = Query(default=None, alias="project_id"),
    db: Session = Depends(get_db),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """List central Device Workspace mappings for the current user."""

    return runtime_work_service.list_device_workspaces(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
    )


@router.post(
    "/device-workspaces",
    response_model=DeviceWorkspaceResponse,
    response_model_by_alias=True,
)
def upsert_device_workspace_endpoint(
    payload: DeviceWorkspaceUpsert = Body(...),
    db: Session = Depends(get_db),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Create or update a central Project-to-device-directory mapping."""

    return runtime_work_service.upsert_device_workspace(
        db=db,
        user_id=current_user.id,
        payload=payload,
    )


@router.post(
    "/device-workspaces/prepare",
    response_model=DeviceWorkspacePrepareResponse,
    response_model_by_alias=True,
)
async def prepare_device_workspace_endpoint(
    payload: DeviceWorkspacePrepareRequest = Body(...),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Prepare a device folder for one Project and store its mapping."""

    return await runtime_work_service.prepare_device_workspace(
        user_id=current_user.id,
        payload=payload,
    )


@router.delete("/device-workspaces")
def delete_device_workspace_endpoint(
    project_id: int = Query(..., ge=1),
    device_id: str = Query(..., min_length=1),
    workspace_path: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Deactivate one Project-to-device-directory mapping."""

    deleted = runtime_work_service.delete_device_workspace(
        db=db,
        user_id=current_user.id,
        project_id=project_id,
        device_id=device_id,
        workspace_path=workspace_path,
    )
    return {"deleted": deleted}


@router.post(
    "/search",
    response_model=RuntimeWorkSearchResponse,
    response_model_by_alias=True,
)
async def search_runtime_work_endpoint(
    request: RuntimeWorkSearchRequest = Body(...),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Search online runtime transcripts owned by the current user."""

    return await runtime_work_service.search_runtime_work(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/workspace/search",
    response_model=RuntimeWorkspaceSearchResponse,
    response_model_by_alias=True,
)
async def search_runtime_workspace_endpoint(
    request: RuntimeWorkspaceSearchRequest = Body(...),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Search workspace paths through the owning online local executor."""

    return await runtime_work_service.search_runtime_workspace(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/transcript",
    response_model=RuntimeTranscriptResponse,
    response_model_by_alias=True,
)
async def get_runtime_transcript_endpoint(
    address: RuntimeTranscriptRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Read a native runtime transcript from the owning online local executor."""

    return await runtime_work_service.get_runtime_transcript(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/file-changes/revert",
    response_model=RuntimeFileChangesRevertResponse,
    response_model_by_alias=True,
)
async def revert_runtime_file_changes_endpoint(
    request: RuntimeFileChangesRevertRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Revert a native runtime file-change artifact on the owning device."""

    return await runtime_work_service.revert_runtime_file_changes(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/send",
    response_model=RuntimeSendResponse,
    response_model_by_alias=True,
)
async def send_runtime_message_endpoint(
    request: RuntimeSendRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Continue a native runtime LocalTask through the owning local executor."""

    return await runtime_work_service.send_runtime_message_nonblocking(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/interrupt-and-send",
    response_model=RuntimeSendResponse,
    response_model_by_alias=True,
)
async def interrupt_and_send_runtime_message_endpoint(
    request: RuntimeSendRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Interrupt the active native runtime turn and immediately continue it."""

    return await runtime_work_service.interrupt_and_send_runtime_message_nonblocking(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/guidance",
    response_model=RuntimeGuidanceResponse,
    response_model_by_alias=True,
)
async def send_runtime_guidance_endpoint(
    request: RuntimeGuidanceRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Steer an active native runtime turn through the owning local executor."""

    return await runtime_work_service.send_runtime_guidance(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/im-sessions",
    response_model=BindRuntimeTaskIMSessionsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.bind_im_sessions", "runtime_work.api")
async def bind_runtime_task_im_sessions_endpoint(
    request: BindRuntimeTaskIMSessionsRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Bind private IM sessions to a native runtime LocalTask address."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", request.address.device_id)
    set_span_attribute("runtime.local_task_id", request.address.local_task_id)
    set_span_attribute("runtime.im_session_count", len(request.session_keys))
    add_span_event(
        "runtime_work.im_sessions.bind",
        {
            "user.id": current_user.id,
            "runtime.device_id": request.address.device_id,
            "runtime.local_task_id": request.address.local_task_id,
            "runtime.im_session_count": len(request.session_keys),
        },
    )
    return await runtime_work_service.bind_runtime_task_to_im_sessions(
        user_id=current_user.id,
        request=request,
    )


@router.get(
    "/im-notifications",
    response_model=RuntimeIMNotificationSettingsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.get", "runtime_work.api")
async def get_im_notification_settings_endpoint(
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Read global and task-level IM notification settings."""

    set_span_attribute("user.id", current_user.id)
    return await runtime_work_service.get_im_notification_settings(
        user_id=current_user.id,
    )


@router.put(
    "/im-notifications/global",
    response_model=RuntimeIMNotificationSettingsResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.global.update", "runtime_work.api")
async def update_global_im_notification_endpoint(
    request: RuntimeGlobalIMNotificationUpdateRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Update the user-level IM notification quick switch."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.im_notifications.global.enabled", request.enabled)
    return await runtime_work_service.update_global_im_notification(
        user_id=current_user.id,
        request=request,
    )


@router.put(
    "/im-notifications/presence",
    response_model=RuntimeIMNotificationPresenceResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.presence.update", "runtime_work.api")
async def update_im_notification_presence_endpoint(
    request: RuntimeIMNotificationPresenceUpdateRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Refresh one Wework client's foreground or away presence."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.im_notifications.presence.away", request.away)
    return await runtime_work_service.update_im_notification_presence(
        user_id=current_user.id,
        request=request,
    )


@router.put(
    "/im-notifications/runtime-task",
    response_model=RuntimeTaskIMNotificationSubscriptionResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.im_notifications.runtime_task.subscribe", "runtime_work.api")
async def subscribe_runtime_task_im_notification_endpoint(
    request: RuntimeTaskIMNotificationSubscriptionRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Subscribe a runtime LocalTask to private IM notifications."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", request.address.device_id)
    set_span_attribute("runtime.local_task_id", request.address.local_task_id)
    set_span_attribute("runtime.im_session_count", len(request.session_keys))
    return await runtime_work_service.subscribe_runtime_task_im_notification(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/im-notifications/runtime-task/unsubscribe",
    response_model=RuntimeTaskIMNotificationSubscriptionResponse,
    response_model_by_alias=True,
)
@trace_async(
    "runtime_work.im_notifications.runtime_task.unsubscribe", "runtime_work.api"
)
async def unsubscribe_runtime_task_im_notification_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Remove runtime LocalTask private IM notification subscriptions."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", address.device_id)
    set_span_attribute("runtime.local_task_id", address.local_task_id)
    return await runtime_work_service.unsubscribe_runtime_task_im_notification(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/archive",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
@trace_async("runtime_work.archive_task", "runtime_work.api")
async def archive_runtime_task_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Archive a native runtime LocalTask through the owning local executor."""

    set_span_attribute("user.id", current_user.id)
    set_span_attribute("runtime.device_id", address.device_id)
    set_span_attribute("runtime.local_task_id", address.local_task_id)
    add_span_event(
        "runtime_work.task.archive",
        {
            "user.id": current_user.id,
            "runtime.device_id": address.device_id,
            "runtime.local_task_id": address.local_task_id,
        },
    )
    return await runtime_work_service.archive_runtime_task(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/cancel",
    response_model=RuntimeTaskCancelResponse,
    response_model_by_alias=True,
)
async def cancel_runtime_task_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Cancel a native runtime LocalTask through the owning local executor."""

    return await runtime_work_service.cancel_runtime_task(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/force-start",
    response_model=RuntimeTaskCancelResponse,
    response_model_by_alias=True,
)
async def force_start_runtime_task_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Force one queued runtime task to start through its owning executor."""

    return await runtime_work_service.force_start_runtime_task(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/queue/reorder",
    response_model=RuntimeTaskQueueReorderResponse,
    response_model_by_alias=True,
)
async def reorder_runtime_task_queue_endpoint(
    request: RuntimeTaskQueueReorderRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Move one queued runtime task to a new execution position."""

    return await runtime_work_service.reorder_runtime_task_queue(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/rename",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
async def rename_runtime_task_endpoint(
    request: RuntimeTaskRenameRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Rename one device-local runtime conversation."""

    return await runtime_work_service.rename_runtime_task(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/archived-conversations/list",
    response_model=ArchivedConversationsListResponse,
    response_model_by_alias=True,
)
async def list_archived_conversations_endpoint(
    request: ArchivedConversationsListRequest | None = Body(default=None),
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """List archived device-local conversations."""

    return await runtime_work_service.list_archived_conversations(
        user_id=current_user.id,
        request=request or ArchivedConversationsListRequest(),
    )


@router.post(
    "/archived-conversations/archive",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
async def archive_conversation_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Archive one device-local conversation."""

    return await runtime_work_service.archive_runtime_task(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/archived-conversations/archive-project",
    response_model=RuntimeArchivedConversationBulkResponse,
    response_model_by_alias=True,
)
async def archive_project_conversations_endpoint(
    request: RuntimeArchiveProjectConversationsRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Archive active conversations under one runtime project."""

    return await runtime_work_service.archive_project_conversations(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/archived-conversations/archive-all",
    response_model=RuntimeArchivedConversationBulkResponse,
    response_model_by_alias=True,
)
async def archive_all_conversations_endpoint(
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Archive all active device-local conversations."""

    return await runtime_work_service.archive_all_conversations(
        user_id=current_user.id,
    )


@router.post(
    "/archived-conversations/unarchive",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
async def unarchive_conversation_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Unarchive one device-local conversation."""

    return await runtime_work_service.unarchive_conversation(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/archived-conversations/delete",
    response_model=RuntimeTaskArchiveResponse,
    response_model_by_alias=True,
)
async def delete_archived_conversation_endpoint(
    address: RuntimeTaskAddress,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Delete one archived device-local conversation."""

    return await runtime_work_service.delete_archived_conversation(
        user_id=current_user.id,
        address=address,
    )


@router.post(
    "/archived-conversations/delete-bulk",
    response_model=RuntimeArchivedConversationBulkResponse,
    response_model_by_alias=True,
)
async def delete_archived_conversations_bulk_endpoint(
    request: RuntimeArchivedConversationBulkRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Delete multiple archived device-local conversations."""

    return await runtime_work_service.delete_archived_conversations_bulk(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/create",
    response_model=RuntimeTaskCreateResponse,
    response_model_by_alias=True,
)
async def create_runtime_task_endpoint(
    request: RuntimeTaskCreateRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Create a native runtime LocalTask through the owning local executor."""

    return await runtime_work_service.create_runtime_task(
        user_id=current_user.id,
        request=request,
    )


@router.post("/llm-responses-proxy/responses")
async def llm_responses_proxy_endpoint(
    fastapi_request: Request,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Proxy an LLM responses request to the real provider without exposing api_key.

    The Wework local executor authenticates with the user's backend token. The
    backend resolves the selected Model CRD, attaches its provider credentials,
    and forwards the request without exposing those credentials to Wework.
    """
    from app.services.llm_proxy_service import proxy_llm_responses

    user_id = current_user.id
    user_name = current_user.user_name or ""
    del current_user
    return await proxy_llm_responses(fastapi_request, user_id, user_name)


@router.post(
    "/workspaces/open",
    response_model=RuntimeWorkspaceOpenResponse,
    response_model_by_alias=True,
)
async def open_runtime_workspace_endpoint(
    request: RuntimeWorkspaceOpenRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Open a native runtime workspace without starting a turn."""

    return await runtime_work_service.open_runtime_workspace(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/workspaces/rename",
    response_model=RuntimeWorkspaceOpenResponse,
    response_model_by_alias=True,
)
async def rename_runtime_workspace_endpoint(
    request: RuntimeWorkspaceRenameRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Rename a native runtime workspace project without touching conversations."""

    return await runtime_work_service.rename_runtime_workspace(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/workspaces/remove",
    response_model=RuntimeWorkspaceOpenResponse,
    response_model_by_alias=True,
)
async def remove_runtime_workspace_endpoint(
    request: RuntimeWorkspaceRemoveRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Remove a native runtime workspace project without deleting conversations."""

    return await runtime_work_service.remove_runtime_workspace(
        user_id=current_user.id,
        request=request,
    )


@router.post(
    "/fork",
    response_model=RuntimeTaskForkResponse,
    response_model_by_alias=True,
)
async def fork_runtime_task_endpoint(
    request: RuntimeTaskForkRequest,
    current_user: _RuntimeUser = Depends(_get_runtime_user),
):
    """Fork a native runtime LocalTask to another device workspace."""

    return await runtime_work_service.fork_runtime_task(
        user_id=current_user.id,
        request=request,
    )
