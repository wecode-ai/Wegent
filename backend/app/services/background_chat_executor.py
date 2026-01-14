# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
BackgroundChatExecutor - Generic background Chat Shell task executor.

Used for executing background Chat Shell tasks that don't require real-time WebSocket streaming:
- Document summary generation
- Knowledge base summary generation
- Auto-tagging (future)
- Content moderation (future)

Features:
- Creates Task/Subtask records for tracking
- Reuses Chat Shell HTTP Adapter
- Synchronously waits for complete response (accumulates all CHUNKs)
- Supports JSON output parsing
"""

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.chat.adapters.http import HTTPAdapter
from app.services.chat.adapters.interface import ChatEventType, ChatRequest

logger = logging.getLogger(__name__)


@dataclass
class BackgroundTaskConfig:
    """Background task configuration."""

    task_type: str  # "summary", "tagging", "review", etc.
    summary_type: Optional[str] = None  # "document" | "knowledge_base"
    document_id: Optional[int] = None
    knowledge_base_id: Optional[int] = None
    # Model configuration (optional, defaults to environment variable config)
    model_config: Optional[Dict[str, Any]] = None


@dataclass
class BackgroundTaskResult:
    """Background task result."""

    success: bool
    task_id: int
    subtask_id: int
    raw_content: str  # LLM raw output
    parsed_content: Optional[Dict[str, Any]] = None  # Parsed JSON content
    error: Optional[str] = None


class BackgroundChatExecutor:
    """Background Chat Shell task executor."""

    def __init__(self, db: Session, user_id: int):
        self.db = db
        self.user_id = user_id
        self._adapter = HTTPAdapter(
            base_url=settings.CHAT_SHELL_URL,
            token=settings.CHAT_SHELL_TOKEN,
            timeout=300.0,
        )

    async def execute(
        self,
        system_prompt: str,
        user_message: str,
        config: BackgroundTaskConfig,
        parse_json: bool = True,
    ) -> BackgroundTaskResult:
        """
        Execute background Chat Shell task.

        Args:
            system_prompt: System prompt
            user_message: User message (task input)
            config: Task configuration
            parse_json: Whether to attempt JSON output parsing

        Returns:
            BackgroundTaskResult containing task result
        """
        logger.info(
            f"[BackgroundChatExecutor] Starting background task: "
            f"type={config.task_type}, summary_type={config.summary_type}, "
            f"document_id={config.document_id}, kb_id={config.knowledge_base_id}"
        )

        # 1. Create Task and Subtask records
        task, _user_subtask, assistant_subtask = self._create_task_records(
            config, user_message
        )

        logger.info(
            f"[BackgroundChatExecutor] Task records created: "
            f"task_id={task.id}, subtask_id={assistant_subtask.id}"
        )

        try:
            # 2. Update status to RUNNING
            assistant_subtask.status = SubtaskStatus.RUNNING
            self.db.commit()

            logger.info(
                f"[BackgroundChatExecutor] Task started: task_id={task.id}, "
                f"subtask_id={assistant_subtask.id}"
            )

            # 3. Build ChatRequest
            model_config = config.model_config or self._get_default_model_config()
            chat_request = ChatRequest(
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                message=user_message,
                user_id=self.user_id,
                user_name="system",
                team_id=0,  # System task
                team_name="system-background",
                model_config=model_config,
                system_prompt=system_prompt,
                enable_tools=False,  # Summary tasks don't need tools
                enable_web_search=False,
                enable_deep_thinking=False,
            )

            # 4. Call Chat Shell, accumulate complete response
            logger.info(
                f"[BackgroundChatExecutor] Sending request to Chat Shell: "
                f"task_id={task.id}"
            )

            accumulated_content = ""
            chunk_count = 0
            async for event in self._adapter.chat(chat_request):
                if event.type == ChatEventType.CHUNK:
                    content = event.data.get("content", "")
                    if content:
                        accumulated_content += content
                        chunk_count += 1
                elif event.type == ChatEventType.ERROR:
                    error_msg = event.data.get("error", "Unknown error")
                    logger.error(
                        f"[BackgroundChatExecutor] Chat Shell error: "
                        f"task_id={task.id}, error={error_msg}"
                    )
                    raise Exception(error_msg)
                elif event.type == ChatEventType.DONE:
                    logger.info(
                        f"[BackgroundChatExecutor] Chat Shell response completed: "
                        f"task_id={task.id}, chunks_received={chunk_count}, "
                        f"content_length={len(accumulated_content)}"
                    )

            # 5. Parse JSON (if needed)
            parsed_content = None
            if parse_json and accumulated_content:
                parsed_content = self._parse_json_response(accumulated_content)
                if parsed_content:
                    logger.info(
                        f"[BackgroundChatExecutor] JSON parsed successfully: "
                        f"task_id={task.id}, keys={list(parsed_content.keys())}"
                    )
                else:
                    logger.warning(
                        f"[BackgroundChatExecutor] Failed to parse JSON response: "
                        f"task_id={task.id}"
                    )

            # 6. Update Subtask status to COMPLETED
            result = {"value": accumulated_content}
            if parsed_content:
                result["parsed"] = parsed_content

            assistant_subtask.status = SubtaskStatus.COMPLETED
            assistant_subtask.result = result
            assistant_subtask.completed_at = datetime.now()

            # 7. Update Task status to COMPLETED
            task_json = task.json
            if task_json and "status" in task_json:
                task_json["status"]["status"] = "COMPLETED"
                task_json["status"]["progress"] = 100
                task_json["status"]["updatedAt"] = datetime.now().isoformat()
                task_json["status"]["completedAt"] = datetime.now().isoformat()
                task.json = task_json
                from sqlalchemy.orm.attributes import flag_modified

                flag_modified(task, "json")

            self.db.commit()

            logger.info(
                f"[BackgroundChatExecutor] Task completed successfully: "
                f"task_id={task.id}, subtask_id={assistant_subtask.id}, "
                f"has_parsed_content={parsed_content is not None}"
            )

            return BackgroundTaskResult(
                success=True,
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                raw_content=accumulated_content,
                parsed_content=parsed_content,
            )

        except Exception as e:
            logger.exception(
                f"[BackgroundChatExecutor] Task failed: "
                f"task_id={task.id}, subtask_id={assistant_subtask.id}"
            )

            # Update Subtask status to FAILED
            assistant_subtask.status = SubtaskStatus.FAILED
            assistant_subtask.error_message = str(e)
            assistant_subtask.completed_at = datetime.now()

            # Update Task status to FAILED
            task_json = task.json
            if task_json and "status" in task_json:
                task_json["status"]["status"] = "FAILED"
                task_json["status"]["progress"] = 0
                task_json["status"]["errorMessage"] = str(e)
                task_json["status"]["updatedAt"] = datetime.now().isoformat()
                task_json["status"]["completedAt"] = datetime.now().isoformat()
                task.json = task_json
                from sqlalchemy.orm.attributes import flag_modified

                flag_modified(task, "json")

            self.db.commit()

            return BackgroundTaskResult(
                success=False,
                task_id=task.id,
                subtask_id=assistant_subtask.id,
                raw_content="",
                error=str(e),
            )

    def _create_task_records(
        self, config: BackgroundTaskConfig, user_message: str
    ) -> tuple:
        """Create Task and Subtask records."""
        # Build task title
        if config.task_type == "summary":
            if config.summary_type == "document":
                title = f"Document Summary - {config.document_id}"
            else:
                title = f"Knowledge Base Summary - {config.knowledge_base_id}"
        else:
            title = f"Background Task - {config.task_type}"

        # Create Task JSON (task_id will be set after flush)
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": (
                    user_message[:100] + "..."
                    if len(user_message) > 100
                    else user_message
                ),
                "teamRef": {"name": "system-background", "namespace": "system"},
                "workspaceRef": {"name": "", "namespace": ""},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "RUNNING",
                "progress": 0,
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
            },
            "metadata": {
                "name": "task-pending",  # Will be updated after flush
                "namespace": "system",
                "labels": {
                    "type": "background",
                    "taskType": config.task_type,  # "summary"
                    "summaryType": config.summary_type or "",
                    "documentId": str(config.document_id or ""),
                    "knowledgeBaseId": str(config.knowledge_base_id or ""),
                    "source": "background_executor",
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        # Create TaskResource using ORM, let DB generate ID
        task = TaskResource(
            user_id=self.user_id,
            kind="Task",
            name="task-pending",  # Will be updated after flush
            namespace="system",
            json=task_json,
            is_active=True,
        )
        self.db.add(task)
        self.db.flush()  # Flush to get the auto-generated ID

        # Update task name and metadata with the actual ID
        task.name = f"task-{task.id}"
        task_json["metadata"]["name"] = f"task-{task.id}"
        task.json = task_json
        self.db.flush()

        # Create User Subtask (record input)
        user_subtask = Subtask(
            user_id=self.user_id,
            task_id=task.id,
            team_id=0,
            title="Background task input",
            bot_ids=[],
            role=SubtaskRole.USER,
            prompt=user_message,
            status=SubtaskStatus.COMPLETED,
            progress=100,
            message_id=1,
            parent_id=0,
            executor_namespace="",
            executor_name="",
            error_message="",
            completed_at=datetime.now(),
        )
        self.db.add(user_subtask)

        # Create Assistant Subtask (record output)
        assistant_subtask = Subtask(
            user_id=self.user_id,
            task_id=task.id,
            team_id=0,
            title="Background task output",
            bot_ids=[],
            role=SubtaskRole.ASSISTANT,
            prompt="",
            status=SubtaskStatus.PENDING,
            progress=0,
            message_id=2,
            parent_id=1,
            executor_namespace="",
            executor_name="",
            error_message="",
            # completed_at will be set when task completes
        )
        self.db.add(assistant_subtask)
        self.db.commit()

        return task, user_subtask, assistant_subtask

    def _get_default_model_config(self) -> Dict[str, Any]:
        """Get default model configuration.

        This method is called when no model_config is provided in BackgroundTaskConfig.
        Since we now require model_config to be explicitly provided (from knowledge base settings),
        this method raises an error to indicate that a model must be configured.

        Raises:
            ValueError: Always raises to indicate model_config must be provided
        """
        raise ValueError(
            "No model configuration provided. "
            "Summary generation requires a model to be configured in the knowledge base settings. "
            "Please select a model for summary generation in the knowledge base configuration."
        )

    def _parse_json_response(self, content: str) -> Optional[Dict[str, Any]]:
        """
        Parse LLM's JSON response.

        Handles possible formats:
        1. Pure JSON: {"key": "value"}
        2. Markdown code block: ```json\n{"key": "value"}\n```
        3. JSON with surrounding text
        """
        content = content.strip()

        # Try direct parsing
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # Try extracting JSON from markdown code block
        json_block_pattern = r"```(?:json)?\s*\n?([\s\S]*?)\n?```"
        matches = re.findall(json_block_pattern, content)
        for match in matches:
            try:
                return json.loads(match.strip())
            except json.JSONDecodeError:
                continue

        # Try extracting JSON objects using balanced brace scanner
        for candidate in self._extract_json_candidates(content):
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue

        logger.warning(
            f"[BackgroundChatExecutor] Failed to parse JSON from response: {content[:200]}..."
        )
        return None

    def _extract_json_candidates(self, content: str) -> list:
        """
        Extract potential JSON objects from content using balanced brace matching.

        This handles nested braces correctly, unlike simple regex patterns.
        """
        candidates = []
        i = 0
        while i < len(content):
            if content[i] == "{":
                # Found opening brace, track nesting to find matching close
                start = i
                depth = 0
                in_string = False
                escape_next = False

                for j in range(i, len(content)):
                    char = content[j]

                    if escape_next:
                        escape_next = False
                        continue

                    if char == "\\":
                        escape_next = True
                        continue

                    if char == '"' and not escape_next:
                        in_string = not in_string
                        continue

                    if in_string:
                        continue

                    if char == "{":
                        depth += 1
                    elif char == "}":
                        depth -= 1
                        if depth == 0:
                            # Found complete JSON object
                            candidates.append(content[start : j + 1])
                            i = j
                            break
                else:
                    # No matching close brace found
                    break
            i += 1
        return candidates
