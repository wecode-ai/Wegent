# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Code Tool service for executing code tasks in isolated Docker containers."""

import json
import logging
import time
from collections.abc import AsyncGenerator
from datetime import datetime
from typing import Any, Optional

import httpx

from app.core.config import settings
from app.schemas.code_tool import (
    CodeToolExecuteRequest,
    FileAttachment,
    OutputFile,
    StreamEvent,
    StreamEventType,
)

from .file_storage import file_storage_service

logger = logging.getLogger(__name__)


class CodeToolService:
    """
    Code Tool Service - Coordinates Backend with Executor Manager.

    This service handles:
    - File preparation for container input
    - Communication with Executor Manager
    - Streaming execution results
    - Output file processing
    """

    def __init__(self):
        """Initialize Code Tool service."""
        self.file_storage = file_storage_service
        self.executor_manager_url = getattr(
            settings, "EXECUTOR_MANAGER_URL", "http://localhost:8001"
        ).rstrip("/")
        self.default_timeout = getattr(settings, "CODE_TOOL_DEFAULT_TIMEOUT", 300)
        self.max_timeout = getattr(settings, "CODE_TOOL_MAX_TIMEOUT", 1800)

    async def execute_stream(
        self,
        request: CodeToolExecuteRequest,
        user_id: int,
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        Execute Code Tool and stream results.

        Args:
            request: Execution request
            user_id: User ID for authorization

        Yields:
            StreamEvent objects
        """
        start_time = time.time()

        try:
            # 1. Prepare input files
            input_file_paths = []
            if request.files:
                input_file_paths = await self._prepare_input_files(
                    request.session_id, request.files
                )

            # 2. Build full prompt with conversation history
            full_prompt = self._build_full_prompt(request)

            # 3. Emit starting event
            yield StreamEvent(
                event_type=StreamEventType.PROGRESS,
                data={
                    "message": "Starting code execution",
                    "progress": 0,
                },
            )

            # 4. Call Executor Manager (streaming)
            async for event in self._call_executor_manager(
                session_id=request.session_id,
                prompt=full_prompt,
                system_prompt=request.system_prompt,
                input_files=input_file_paths,
                timeout=min(request.timeout, self.max_timeout),
                user_id=user_id,
            ):
                # Process file events to add download URLs
                if event.event_type == StreamEventType.FILE_CREATED:
                    event = await self._process_file_event(event, request.session_id)

                yield event

            # 5. Final done event with timing
            execution_time = time.time() - start_time
            yield StreamEvent(
                event_type=StreamEventType.DONE,
                data={
                    "execution_time": execution_time,
                    "session_id": request.session_id,
                },
            )

        except httpx.TimeoutException:
            logger.error(f"Timeout executing code tool for session {request.session_id}")
            yield StreamEvent(
                event_type=StreamEventType.ERROR,
                data={
                    "message": "Execution timed out",
                    "code": "TIMEOUT",
                },
            )
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error from executor manager: {e.response.status_code}")
            yield StreamEvent(
                event_type=StreamEventType.ERROR,
                data={
                    "message": f"Executor error: {e.response.status_code}",
                    "code": "EXECUTOR_ERROR",
                },
            )
        except Exception as e:
            logger.exception(f"Error executing code tool: {e}")
            yield StreamEvent(
                event_type=StreamEventType.ERROR,
                data={
                    "message": str(e),
                    "code": "INTERNAL_ERROR",
                },
            )

    async def _prepare_input_files(
        self,
        session_id: str,
        files: list[FileAttachment],
    ) -> list[str]:
        """
        Prepare input files for container.

        Args:
            session_id: Session identifier
            files: List of file attachments

        Returns:
            List of local file paths
        """
        file_paths = []

        for file in files:
            file_info = await self.file_storage.get_file(session_id, file.file_id)
            if file_info:
                file_paths.append(file_info["path"])
            else:
                logger.warning(
                    f"File {file.file_id} not found for session {session_id}"
                )

        return file_paths

    def _build_full_prompt(self, request: CodeToolExecuteRequest) -> str:
        """
        Build full prompt including conversation history and file info.

        Args:
            request: Execution request

        Returns:
            Full prompt string
        """
        parts = []

        # Add conversation history
        if request.conversation_history:
            parts.append("## Previous Conversation Context\n")
            for msg in request.conversation_history:
                role_label = "User" if msg.role == "user" else "Assistant"
                parts.append(f"**{role_label}**: {msg.content}\n")
            parts.append("\n---\n")

        # Add current task
        parts.append("## Current Task\n")
        parts.append(request.prompt)

        # Add file information
        if request.files:
            parts.append("\n\n## Available Input Files\n")
            for f in request.files:
                target = f.target_path or f"/workspace/input/{f.filename}"
                parts.append(f"- `{target}` ({f.filename}, {f.size} bytes)\n")

        # Add output instructions
        parts.append("\n\n## Output Instructions\n")
        parts.append("Save any output files to `/workspace/output/` directory.\n")

        return "".join(parts)

    async def _call_executor_manager(
        self,
        session_id: str,
        prompt: str,
        system_prompt: Optional[str],
        input_files: list[str],
        timeout: int,
        user_id: int,
    ) -> AsyncGenerator[StreamEvent, None]:
        """
        Call Executor Manager with streaming response.

        Args:
            session_id: Session identifier
            prompt: Full prompt
            system_prompt: Optional system prompt
            input_files: List of input file paths
            timeout: Execution timeout
            user_id: User ID

        Yields:
            StreamEvent objects
        """
        url = f"{self.executor_manager_url}/executor-manager/code-tool/execute"

        request_data = {
            "session_id": session_id,
            "prompt": prompt,
            "system_prompt": system_prompt,
            "input_files": input_files,
            "timeout": timeout,
            "user_id": user_id,
        }

        logger.info(
            f"Calling executor manager for session {session_id}, "
            f"prompt length: {len(prompt)}"
        )

        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                url,
                json=request_data,
                timeout=httpx.Timeout(timeout + 60, connect=30),
            ) as response:
                response.raise_for_status()

                async for line in response.aiter_lines():
                    if not line:
                        continue

                    if line.startswith("data: "):
                        try:
                            data = json.loads(line[6:])
                            event = StreamEvent(
                                event_type=StreamEventType(data.get("event_type", "text")),
                                data=data.get("data", {}),
                                timestamp=datetime.fromisoformat(data["timestamp"])
                                if "timestamp" in data
                                else datetime.now(),
                            )
                            yield event
                        except json.JSONDecodeError as e:
                            logger.warning(f"Failed to parse SSE data: {e}")
                        except ValueError as e:
                            logger.warning(f"Invalid event type: {e}")

    async def _process_file_event(
        self,
        event: StreamEvent,
        session_id: str,
    ) -> StreamEvent:
        """
        Process file_created event to add download URL.

        Args:
            event: Original file event
            session_id: Session identifier

        Returns:
            Updated event with download URL
        """
        file_path = event.data.get("path", "")
        filename = event.data.get("filename", "")

        # Generate download URL
        # Note: In production, this would be a signed URL or token-based
        download_url = (
            f"/api/code-tool/download/{session_id}/{event.data.get('file_id', '')}"
        )

        event.data["download_url"] = download_url

        return event

    async def get_session_status(self, session_id: str) -> dict[str, Any]:
        """
        Get session status from Executor Manager.

        Args:
            session_id: Session identifier

        Returns:
            Session status dict
        """
        url = f"{self.executor_manager_url}/executor-manager/code-tool/session/{session_id}"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=10)
                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 404:
                    return {
                        "session_id": session_id,
                        "status": "not_found",
                    }
                else:
                    return {
                        "session_id": session_id,
                        "status": "error",
                        "error": f"HTTP {response.status_code}",
                    }
        except Exception as e:
            logger.error(f"Error getting session status: {e}")
            return {
                "session_id": session_id,
                "status": "error",
                "error": str(e),
            }

    async def cleanup_session(self, session_id: str) -> bool:
        """
        Clean up session resources.

        Args:
            session_id: Session identifier

        Returns:
            True if cleanup was successful
        """
        success = True

        # 1. Clean up local files
        file_cleanup = await self.file_storage.cleanup_session(session_id)
        if not file_cleanup:
            success = False

        # 2. Destroy session in Executor Manager
        url = f"{self.executor_manager_url}/executor-manager/code-tool/session/{session_id}"

        try:
            async with httpx.AsyncClient() as client:
                response = await client.delete(url, timeout=30)
                if response.status_code not in (200, 204, 404):
                    logger.warning(
                        f"Failed to cleanup session in executor manager: "
                        f"{response.status_code}"
                    )
                    success = False
        except Exception as e:
            logger.error(f"Error cleaning up session in executor manager: {e}")
            success = False

        return success

    async def upload_file(
        self,
        session_id: str,
        filename: str,
        content: bytes,
    ) -> dict[str, Any]:
        """
        Upload a file for a session.

        Args:
            session_id: Session identifier
            filename: Original filename
            content: File content

        Returns:
            File info dict
        """
        return await self.file_storage.store_file(
            session_id=session_id,
            filename=filename,
            content=content,
            subdir="input",
        )

    async def download_file(
        self,
        session_id: str,
        file_id: str,
    ) -> Optional[tuple[bytes, str]]:
        """
        Download a file by ID.

        Args:
            session_id: Session identifier
            file_id: File identifier

        Returns:
            Tuple of (content, filename) or None if not found
        """
        file_info = await self.file_storage.get_file(session_id, file_id)
        if not file_info:
            return None

        content = await self.file_storage.read_file(session_id, file_id)
        if content is None:
            return None

        return content, file_info["filename"]


# Singleton instance
code_tool_service = CodeToolService()
