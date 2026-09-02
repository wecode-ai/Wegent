# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned implementations for Web-facing SSE endpoints."""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any, NoReturn

from fastapi import HTTPException

from app.core.bounded_executor import BoundedExecutorOverloaded
from app.core.payload_codec import run_payload_codec
from app.services import prompt_draft_service
from app.services.chat.storage import session_manager
from app.services.chat.storage.db import get_db_session, run_sync_in_executor
from app.services.model_runtime import stateless_runtime_service
from app.services.remote_workspace_service import (
    RemoteWorkspaceFileRequest,
    remote_workspace_service,
)
from app.services.simple_chat import simple_chat_service
from shared.clients.gemini_interaction import (
    GeminiInteractionClient,
    GeminiInteractionError,
)
from shared.models import ExecutionRequest

from .web_stream_protocol import (
    DEEP_RESEARCH_CREATE_EXECUTE,
    DEEP_RESEARCH_STATUS_EXECUTE,
    DEEP_RESEARCH_STREAM,
    EXECUTION_CANCEL_EXECUTE,
    MODEL_RUNTIME_EXECUTE,
    MODEL_RUNTIME_STREAM,
    PROMPT_DRAFT_EXECUTE,
    PROMPT_DRAFT_STREAM,
    REMOTE_WORKSPACE_FILE_STREAM,
    REMOTE_WORKSPACE_STATUS_EXECUTE,
    REMOTE_WORKSPACE_TREE_EXECUTE,
    SUBTASK_RECOVERY_EXECUTE,
    SUBTASK_SUBSCRIPTION_STREAM,
    TASK_RUNTIME_ACTIVE_STREAM_EXECUTE,
    WEB_EXECUTE_OPERATIONS,
    WEB_RAW_STREAM_OPERATIONS,
    WEB_STREAM_OPERATIONS,
    WIZARD_PROMPT_EXECUTE,
    WIZARD_PROMPT_STREAM,
)

logger = logging.getLogger(__name__)


def _remote_workspace_status(task_id: int, user_id: int) -> dict[str, Any]:
    with get_db_session() as db:
        return remote_workspace_service.get_status(
            db=db,
            task_id=task_id,
            user_id=user_id,
        ).model_dump(mode="json")


def _remote_workspace_tree(
    task_id: int,
    user_id: int,
    path: str,
) -> dict[str, Any]:
    with get_db_session() as db:
        return remote_workspace_service.list_tree(
            db=db,
            task_id=task_id,
            user_id=user_id,
            path=path,
        ).model_dump(mode="json")


def _prepare_remote_workspace_file(
    task_id: int,
    user_id: int,
    path: str,
    disposition: str,
) -> RemoteWorkspaceFileRequest:
    with get_db_session() as db:
        return remote_workspace_service.prepare_file_stream(
            db=db,
            task_id=task_id,
            user_id=user_id,
            path=path,
            disposition=disposition,
        )


class WebStreamRequestError(ValueError):
    """Raised when a local Web-stream request violates its wire contract."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str = "web_operation_invalid",
        status_code: int = 400,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.status_code = status_code


def _require_dict(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WebStreamRequestError(f"{field} must be an object")
    return value


def _require_string(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        raise WebStreamRequestError(f"{field} must be a string")
    return value


def _optional_string(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _require_string(value, field, allow_empty=True)


def _require_positive_int(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise WebStreamRequestError(f"{field} must be positive")
    return value


def _raise_remote_workspace_error(error: HTTPException) -> NoReturn:
    detail = (
        error.detail if isinstance(error.detail, str) else "Remote workspace failed"
    )
    raise WebStreamRequestError(
        detail,
        error_code="remote_workspace_failed",
        status_code=error.status_code,
    ) from error


async def _run_remote_workspace_sync(function: Any, *args: Any) -> Any:
    try:
        return await run_sync_in_executor(function, *args)
    except HTTPException as error:
        _raise_remote_workspace_error(error)
    except BoundedExecutorOverloaded as error:
        raise WebStreamRequestError(
            "Remote workspace worker is at capacity",
            error_code="remote_workspace_overloaded",
            status_code=503,
        ) from error


def _encode_sse_data(data: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


def _encode_named_sse(event: str, data: dict[str, Any]) -> bytes:
    return (f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n").encode(
        "utf-8"
    )


def _coerce_stream_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8")
    raise WebStreamRequestError("Worker stream produced a non-byte payload")


def _prompt_context_from_payload(
    value: Any,
) -> prompt_draft_service.PromptDraftContext:
    raw = _require_dict(value, "context")
    task_id = raw.get("task_id")
    user_id = raw.get("user_id")
    selected_model = raw.get("selected_model")
    model_config = raw.get("model_config")
    blocks = raw.get("conversation_blocks")
    if not isinstance(task_id, int) or task_id <= 0:
        raise WebStreamRequestError("context.task_id must be positive")
    if not isinstance(user_id, int) or user_id <= 0:
        raise WebStreamRequestError("context.user_id must be positive")
    if not isinstance(selected_model, str) or not selected_model:
        raise WebStreamRequestError("context.selected_model must be non-empty")
    if not isinstance(model_config, dict):
        raise WebStreamRequestError("context.model_config must be an object")
    if not isinstance(blocks, list):
        raise WebStreamRequestError("context.conversation_blocks must be a list")
    normalized_blocks: list[tuple[str, str]] = []
    for block in blocks:
        if (
            not isinstance(block, (list, tuple))
            or len(block) != 2
            or not all(isinstance(item, str) for item in block)
        ):
            raise WebStreamRequestError(
                "context.conversation_blocks contains an invalid item"
            )
        normalized_blocks.append((block[0], block[1]))
    return prompt_draft_service.PromptDraftContext(
        task_id=task_id,
        user_id=user_id,
        selected_model=selected_model,
        model_config=model_config,
        conversation_blocks=tuple(normalized_blocks),
    )


def _map_gemini_event_type(event_type: str) -> str:
    return {
        "interaction.start": "response.start",
        "interaction.status_update": "response.status_update",
        "content.start": "content.start",
        "content.delta": "content.delta",
        "content.stop": "content.stop",
        "interaction.complete": "response.done",
        "done": "done",
    }.get(event_type, event_type)


def _project_gemini_event(event_type: str, event_data: str) -> bytes:
    try:
        data = json.loads(event_data)
    except json.JSONDecodeError:
        data = {"raw": event_data}
    if not isinstance(data, dict):
        data = {"value": data}
    return _encode_named_sse(_map_gemini_event_type(event_type), data)


def _project_subtask_message(
    chunk_data: Any,
    subtask_id: int,
) -> tuple[bytes | None, bool]:
    if isinstance(chunk_data, bytes):
        chunk_data = chunk_data.decode("utf-8")
    if not isinstance(chunk_data, str):
        raise WebStreamRequestError("Redis stream message must be text or bytes")
    try:
        parsed = json.loads(chunk_data)
    except json.JSONDecodeError:
        return (
            _encode_named_sse(
                "message",
                {
                    "content": chunk_data,
                    "done": False,
                    "subtask_id": subtask_id,
                },
            ),
            False,
        )
    if not isinstance(parsed, dict) or parsed.get("__type__") != "STREAM_DONE":
        return None, False
    return (
        _encode_named_sse(
            "message",
            {
                "content": "",
                "done": True,
                "result": parsed.get("result"),
                "subtask_id": subtask_id,
            },
        ),
        True,
    )


def _resume_subtask_frame(
    current_content: str,
    offset: int,
    subtask_id: int,
) -> bytes | None:
    remaining = current_content[offset:]
    if not remaining:
        return None
    return _encode_named_sse(
        "message",
        {
            "content": remaining,
            "done": False,
            "subtask_id": subtask_id,
        },
    )


def _gemini_client(model_config: dict[str, Any]) -> GeminiInteractionClient:
    base_url = _require_string(model_config.get("base_url"), "base_url")
    api_key = _require_string(model_config.get("api_key"), "api_key")
    default_headers = model_config.get("default_headers", {})
    if not isinstance(default_headers, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in default_headers.items()
    ):
        raise WebStreamRequestError("default_headers must contain strings")
    return GeminiInteractionClient(
        base_url=base_url,
        api_key=api_key,
        default_headers=default_headers,
    )


class WebStreamExecutionService:
    """Dispatch one validated operation entirely inside the Stream process."""

    async def execute(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if operation not in WEB_EXECUTE_OPERATIONS:
            raise WebStreamRequestError(f"Unknown Web execute operation: {operation}")
        if operation == MODEL_RUNTIME_EXECUTE:
            return await self._execute_model_runtime(payload)
        if operation == PROMPT_DRAFT_EXECUTE:
            return await self._execute_prompt_draft(payload)
        if operation == WIZARD_PROMPT_EXECUTE:
            return await self._execute_wizard_prompt(payload)
        if operation == DEEP_RESEARCH_CREATE_EXECUTE:
            return await self._execute_deep_research_create(payload)
        if operation == DEEP_RESEARCH_STATUS_EXECUTE:
            return await self._execute_deep_research_status(payload)
        if operation == SUBTASK_RECOVERY_EXECUTE:
            return await self._execute_subtask_recovery(payload)
        if operation == REMOTE_WORKSPACE_STATUS_EXECUTE:
            return await self._execute_remote_workspace_status(payload)
        if operation == REMOTE_WORKSPACE_TREE_EXECUTE:
            return await self._execute_remote_workspace_tree(payload)
        if operation == EXECUTION_CANCEL_EXECUTE:
            return await self._execute_execution_cancel(payload)
        if operation == TASK_RUNTIME_ACTIVE_STREAM_EXECUTE:
            return await self._execute_task_runtime_active_stream(payload)
        raise WebStreamRequestError(f"Unknown Web execute operation: {operation}")

    async def stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        if operation not in WEB_STREAM_OPERATIONS:
            raise WebStreamRequestError(f"Unknown Web stream operation: {operation}")
        if operation == MODEL_RUNTIME_STREAM:
            source = self._stream_model_runtime(payload)
        elif operation == PROMPT_DRAFT_STREAM:
            source = self._stream_prompt_draft(payload)
        elif operation == WIZARD_PROMPT_STREAM:
            source = self._stream_wizard_prompt(payload)
        elif operation == DEEP_RESEARCH_STREAM:
            source = self._stream_deep_research(payload)
        elif operation == SUBTASK_SUBSCRIPTION_STREAM:
            source = self._stream_subtask_subscription(payload)
        else:
            raise WebStreamRequestError(f"Unknown Web stream operation: {operation}")
        async for frame in source:
            yield frame

    async def open_raw_stream(
        self,
        operation: str,
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], AsyncIterator[bytes]]:
        if operation not in WEB_RAW_STREAM_OPERATIONS:
            raise WebStreamRequestError(
                f"Unknown Web raw stream operation: {operation}"
            )
        if operation == REMOTE_WORKSPACE_FILE_STREAM:
            return await self._open_remote_workspace_file(payload)
        raise WebStreamRequestError(f"Unknown Web raw stream operation: {operation}")

    @staticmethod
    async def _execute_model_runtime(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        model = _require_string(payload.get("model"), "model")
        input_data = payload.get("input")
        if not isinstance(input_data, (str, list)):
            raise WebStreamRequestError("input must be text or a message list")
        model_config = payload.get("model_config")
        metadata = payload.get("metadata")
        tools = payload.get("tools")
        if model_config is not None and not isinstance(model_config, dict):
            raise WebStreamRequestError("model_config must be an object")
        if metadata is not None and not isinstance(metadata, dict):
            raise WebStreamRequestError("metadata must be an object")
        if tools is not None and not isinstance(tools, list):
            raise WebStreamRequestError("tools must be a list")
        try:
            output_text = await stateless_runtime_service.complete_text(
                model=model,
                input_data=input_data,
                instructions=_optional_string(
                    payload.get("instructions"),
                    "instructions",
                ),
                model_config=model_config,
                metadata=metadata,
                tools=tools,
            )
        except Exception as error:
            raise WebStreamRequestError(
                "Model runtime execution failed",
                error_code="model_runtime_failed",
                status_code=502,
            ) from error
        return {"output_text": output_text}

    @staticmethod
    async def _execute_prompt_draft(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        context = await run_payload_codec(
            _prompt_context_from_payload,
            payload.get("context"),
            payload_hint=payload.get("context"),
            force_offload=True,
        )
        regenerate = payload.get("regenerate")
        if not isinstance(regenerate, bool):
            raise WebStreamRequestError("regenerate must be boolean")
        try:
            result = await prompt_draft_service.generate_prompt_draft_result(
                context,
                source=_optional_string(payload.get("source"), "source"),
                current_prompt=_optional_string(
                    payload.get("current_prompt"),
                    "current_prompt",
                ),
                regenerate=regenerate,
            )
        except prompt_draft_service.PromptDraftGenerationFailedError as error:
            raise WebStreamRequestError(
                "Prompt draft generation failed",
                error_code="prompt_draft_generation_failed",
                status_code=502,
            ) from error
        return result

    @staticmethod
    async def _execute_wizard_prompt(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        model_config = _require_dict(payload.get("model_config"), "model_config")
        message = payload.get("message")
        if not isinstance(message, (str, dict)):
            raise WebStreamRequestError("message must be text or an object")
        system_prompt = _require_string(
            payload.get("system_prompt"),
            "system_prompt",
            allow_empty=True,
        )
        try:
            response = await simple_chat_service.chat_completion(
                message=message,
                model_config=model_config,
                system_prompt=system_prompt,
            )
        except Exception as error:
            raise WebStreamRequestError(
                "Wizard model execution failed",
                error_code="wizard_model_failed",
                status_code=502,
            ) from error
        return {"response": response}

    @staticmethod
    async def _execute_deep_research_create(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        model_config = _require_dict(payload.get("model_config"), "model_config")
        input_text = _require_string(payload.get("input"), "input")
        agent = _require_string(payload.get("agent"), "agent")
        client = _gemini_client(model_config)
        try:
            return await client.create_interaction(
                input_text=input_text,
                agent=agent,
            )
        except GeminiInteractionError as error:
            raise WebStreamRequestError(
                str(error),
                error_code="deep_research_create_failed",
                status_code=error.status_code or 502,
            ) from error

    @staticmethod
    async def _execute_deep_research_status(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        model_config = _require_dict(payload.get("model_config"), "model_config")
        interaction_id = _require_string(
            payload.get("interaction_id"),
            "interaction_id",
        )
        client = _gemini_client(model_config)
        try:
            return await client.get_interaction_status(interaction_id)
        except GeminiInteractionError as error:
            raise WebStreamRequestError(
                str(error),
                error_code="deep_research_status_failed",
                status_code=error.status_code or 502,
            ) from error

    @staticmethod
    async def _execute_subtask_recovery(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        subtask_id = payload.get("subtask_id")
        offset = payload.get("offset")
        include_blocks = payload.get("include_blocks")
        include_context_metrics = payload.get("include_context_metrics")
        if not isinstance(subtask_id, int) or subtask_id <= 0:
            raise WebStreamRequestError("subtask_id must be positive")
        if not isinstance(offset, int) or offset < 0:
            raise WebStreamRequestError("offset must be non-negative")
        if not isinstance(include_blocks, bool):
            raise WebStreamRequestError("include_blocks must be boolean")
        if not isinstance(include_context_metrics, bool):
            raise WebStreamRequestError("include_context_metrics must be boolean")

        content = await session_manager.get_streaming_content(subtask_id) or ""
        result: dict[str, Any] = {
            "content": content[offset:],
            "cursor": len(content),
        }
        if include_blocks:
            result["blocks"] = await session_manager.get_blocks(subtask_id)
        if include_context_metrics:
            result["context_metrics"] = await session_manager.get_context_metrics(
                subtask_id
            )
        return result

    @staticmethod
    async def _execute_task_runtime_active_stream(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _require_positive_int(payload.get("task_id"), "task_id")
        streaming_status = await session_manager.get_task_streaming_status(task_id)
        if not streaming_status:
            return {"active_stream": None}
        try:
            subtask_id = int(streaming_status.get("subtask_id"))
        except (TypeError, ValueError) as error:
            raise WebStreamRequestError(
                "Streaming status contains an invalid subtask_id"
            ) from error
        if subtask_id <= 0:
            raise WebStreamRequestError(
                "Streaming status contains an invalid subtask_id"
            )
        return {
            "active_stream": {
                "subtask_id": subtask_id,
                "cursor": await session_manager.get_streaming_content_length(
                    subtask_id
                ),
                "last_activity_at": streaming_status.get("last_activity_at"),
            }
        }

    @staticmethod
    async def _execute_remote_workspace_status(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _require_positive_int(payload.get("task_id"), "task_id")
        user_id = _require_positive_int(payload.get("user_id"), "user_id")
        return await _run_remote_workspace_sync(
            _remote_workspace_status,
            task_id,
            user_id,
        )

    @staticmethod
    async def _execute_remote_workspace_tree(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _require_positive_int(payload.get("task_id"), "task_id")
        user_id = _require_positive_int(payload.get("user_id"), "user_id")
        path = _require_string(payload.get("path"), "path", allow_empty=True)
        return await _run_remote_workspace_sync(
            _remote_workspace_tree,
            task_id,
            user_id,
            path,
        )

    @staticmethod
    async def _execute_execution_cancel(
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        raw_request = _require_dict(payload.get("request"), "request")
        request = await run_payload_codec(
            ExecutionRequest.from_dict,
            raw_request,
            payload_hint=raw_request,
            force_offload=True,
        )
        from app.services.execution.dispatcher import execution_dispatcher

        success = await execution_dispatcher.cancel_worker_owned(request)
        return {"success": success}

    @staticmethod
    async def _open_remote_workspace_file(
        payload: dict[str, Any],
    ) -> tuple[dict[str, Any], AsyncIterator[bytes]]:
        task_id = _require_positive_int(payload.get("task_id"), "task_id")
        user_id = _require_positive_int(payload.get("user_id"), "user_id")
        path = _require_string(payload.get("path"), "path", allow_empty=True)
        disposition = _require_string(payload.get("disposition"), "disposition")
        if disposition not in {"inline", "attachment"}:
            raise WebStreamRequestError("Invalid disposition")

        request = await _run_remote_workspace_sync(
            _prepare_remote_workspace_file,
            task_id,
            user_id,
            path,
            disposition,
        )
        try:
            file_stream = await remote_workspace_service.open_file_stream(request)
        except HTTPException as error:
            _raise_remote_workspace_error(error)

        async def body() -> AsyncIterator[bytes]:
            try:
                async for chunk in file_stream.chunks():
                    yield chunk
            finally:
                await file_stream.aclose()

        return (
            {
                "content_type": file_stream.content_type,
                "content_disposition": file_stream.content_disposition,
            },
            body(),
        )

    @staticmethod
    async def _stream_model_runtime(
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        model = _require_string(payload.get("model"), "model")
        input_data = payload.get("input")
        if not isinstance(input_data, (str, list)):
            raise WebStreamRequestError("input must be text or a message list")
        model_config = payload.get("model_config")
        metadata = payload.get("metadata")
        tools = payload.get("tools")
        if model_config is not None and not isinstance(model_config, dict):
            raise WebStreamRequestError("model_config must be an object")
        if metadata is not None and not isinstance(metadata, dict):
            raise WebStreamRequestError("metadata must be an object")
        if tools is not None and not isinstance(tools, list):
            raise WebStreamRequestError("tools must be a list")
        async for frame in stateless_runtime_service.stream_response(
            model=model,
            input_data=input_data,
            instructions=_optional_string(payload.get("instructions"), "instructions"),
            model_config=model_config,
            metadata=metadata,
            tools=tools,
        ):
            yield _coerce_stream_bytes(frame)

    @staticmethod
    async def _stream_prompt_draft(
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        context = await run_payload_codec(
            _prompt_context_from_payload,
            payload.get("context"),
            payload_hint=payload.get("context"),
            force_offload=True,
        )
        source = _optional_string(payload.get("source"), "source")
        current_prompt = _optional_string(
            payload.get("current_prompt"),
            "current_prompt",
        )
        regenerate = payload.get("regenerate")
        if not isinstance(regenerate, bool):
            raise WebStreamRequestError("regenerate must be boolean")
        async for event in prompt_draft_service.generate_prompt_draft_stream(
            context=context,
            source=source,
            current_prompt=current_prompt,
            regenerate=regenerate,
        ):
            yield await run_payload_codec(
                _encode_sse_data,
                event,
                payload_hint=event,
                force_offload=True,
            )

    @staticmethod
    async def _stream_wizard_prompt(
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        model_config = _require_dict(payload.get("model_config"), "model_config")
        message = payload.get("message")
        if not isinstance(message, (str, dict)):
            raise WebStreamRequestError("message must be text or an object")
        system_prompt = _require_string(
            payload.get("system_prompt"),
            "system_prompt",
            allow_empty=True,
        )
        response = await simple_chat_service.chat_stream(
            message=message,
            model_config=model_config,
            system_prompt=system_prompt,
        )
        iterator = response.body_iterator
        try:
            async for frame in iterator:
                yield _coerce_stream_bytes(frame)
        finally:
            close = getattr(iterator, "aclose", None)
            if close is not None:
                await close()

    @staticmethod
    async def _stream_deep_research(
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        interaction_id = _require_string(
            payload.get("interaction_id"),
            "interaction_id",
        )
        model_config = _require_dict(payload.get("model_config"), "model_config")
        base_url = _require_string(model_config.get("base_url"), "base_url")
        api_key = _require_string(model_config.get("api_key"), "api_key")
        default_headers = model_config.get("default_headers", {})
        if not isinstance(default_headers, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in default_headers.items()
        ):
            raise WebStreamRequestError("default_headers must contain strings")
        client = GeminiInteractionClient(
            base_url=base_url,
            api_key=api_key,
            default_headers=default_headers,
        )
        try:
            async for event_type, event_data in client.stream_interaction_result(
                interaction_id
            ):
                yield await run_payload_codec(
                    _project_gemini_event,
                    event_type,
                    event_data,
                    payload_hint=event_data,
                    force_offload=True,
                )
        except GeminiInteractionError as error:
            logger.error("Deep research stream failed: %s", error)
            yield await run_payload_codec(
                _encode_named_sse,
                "response.error",
                {
                    "code": "stream_error",
                    "message": str(error),
                    "status_code": error.status_code,
                },
                payload_hint=error,
                force_offload=True,
            )
        except Exception as error:
            logger.exception("Unexpected deep research stream failure")
            yield await run_payload_codec(
                _encode_named_sse,
                "response.error",
                {"code": "internal_error", "message": str(error)},
                payload_hint=error,
                force_offload=True,
            )

    @staticmethod
    async def _stream_subtask_subscription(
        payload: dict[str, Any],
    ) -> AsyncIterator[bytes]:
        subtask_id = payload.get("subtask_id")
        offset = payload.get("offset")
        if not isinstance(subtask_id, int) or subtask_id <= 0:
            raise WebStreamRequestError("subtask_id must be positive")
        if not isinstance(offset, int) or offset < 0:
            raise WebStreamRequestError("offset must be non-negative")

        current_content = await session_manager.get_streaming_content(subtask_id)
        if offset > 0 and current_content:
            frame = await run_payload_codec(
                _resume_subtask_frame,
                current_content,
                offset,
                subtask_id,
                payload_hint=current_content,
                force_offload=True,
            )
            if frame is not None:
                yield frame

        redis_client, pubsub = await session_manager.subscribe_streaming_channel(
            subtask_id
        )
        if redis_client is None or pubsub is None:
            yield await run_payload_codec(
                _encode_named_sse,
                "error",
                {"error": "Failed to subscribe to stream"},
                force_offload=True,
            )
            return

        try:
            while True:
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=30.0,
                )
                if not message or message.get("type") != "message":
                    continue
                frame, done = await run_payload_codec(
                    _project_subtask_message,
                    message.get("data"),
                    subtask_id,
                    payload_hint=message.get("data"),
                    force_offload=True,
                )
                if frame is not None:
                    yield frame
                if done:
                    return
        finally:
            await pubsub.unsubscribe()
            await redis_client.aclose()


web_stream_execution_service = WebStreamExecutionService()
