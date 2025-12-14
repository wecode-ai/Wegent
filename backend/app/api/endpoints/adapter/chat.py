# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Chat Shell API endpoints.

Provides streaming chat API for Chat Shell type, bypassing Docker Executor.
"""

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.user import User
from app.schemas.kind import Bot, Shell, Task, Team
from app.services.chat.base import ChatServiceBase
from app.services.chat.chat_service import chat_service
from app.services.chat.model_resolver import (
    build_default_headers_with_placeholders,
    get_bot_system_prompt,
    get_model_config_for_bot,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class StreamChatRequest(BaseModel):
    """Request body for streaming chat."""

    message: str
    team_id: int
    task_id: Optional[int] = None  # Optional for multi-turn conversations
    model_id: Optional[str] = None  # Optional model override
    force_override_bot_model: bool = False
    attachment_id: Optional[int] = None  # Optional attachment ID for file upload
    # Web search toggle
    enable_web_search: bool = False  # Enable web search for this message
    search_engine: Optional[str] = None  # Search engine to use
    # Clarification mode toggle
    enable_clarification: bool = False  # Enable clarification mode for this message
    # Git info (optional, for record keeping)
    git_url: Optional[str] = None
    git_repo: Optional[str] = None
    git_repo_id: Optional[int] = None
    git_domain: Optional[str] = None
    branch_name: Optional[str] = None
    # Resume/reconnect parameters for offset-based streaming
    subtask_id: Optional[int] = None  # For resuming an existing stream
    offset: Optional[int] = None  # Character offset for resuming (0 = new stream)


def _get_shell_type(db: Session, bot: Kind, user_id: int) -> str:
    """Get shell type for a bot."""
    bot_crd = Bot.model_validate(bot.json)

    # First check user's custom shells
    shell = (
        db.query(Kind)
        .filter(
            Kind.user_id == user_id,
            Kind.kind == "Shell",
            Kind.name == bot_crd.spec.shellRef.name,
            Kind.namespace == bot_crd.spec.shellRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    # If not found, check public shells
    if not shell:
        public_shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if public_shell and public_shell.json:
            shell_crd = Shell.model_validate(public_shell.json)
            return shell_crd.spec.shellType
        return ""

    if shell and shell.json:
        shell_crd = Shell.model_validate(shell.json)
        return shell_crd.spec.shellType

    return ""


def _should_use_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team should use direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.
    """
    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        shell_type = _get_shell_type(db, bot, team.user_id)
        is_direct_chat = ChatServiceBase.is_direct_chat_shell(shell_type)

        if not is_direct_chat:
            return False

    return True


async def _create_task_and_subtasks(
    db: Session,
    user: User,
    team: Kind,
    message: str,
    request: StreamChatRequest,
    task_id: Optional[int] = None,
) -> tuple[Kind, Subtask]:
    """
    Create or get task and create subtasks for chat.

    Returns:
        Tuple of (task, assistant_subtask)
    """
    team_crd = Team.model_validate(team.json)

    # Get bot IDs from team members
    bot_ids = []
    for member in team_crd.spec.members:
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if bot:
            bot_ids.append(bot.id)

    if not bot_ids:
        raise HTTPException(status_code=400, detail="No valid bots found in team")

    task = None

    if task_id:
        # Get existing task
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user.id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )

        if not task:
            raise HTTPException(status_code=404, detail="Task not found")

        # Check task status
        task_crd = Task.model_validate(task.json)
        if task_crd.status and task_crd.status.status == "RUNNING":
            raise HTTPException(status_code=400, detail="Task is still running")

    if not task:
        # Create new task
        from app.services.adapters.task_kinds import task_kinds_service

        # Create task ID first
        new_task_id = task_kinds_service.create_task_id(db, user.id)

        # Validate task ID
        if not task_kinds_service.validate_task_id(db, new_task_id):
            raise HTTPException(status_code=500, detail="Failed to create task ID")

        # Create workspace
        workspace_name = f"workspace-{new_task_id}"
        workspace_json = {
            "kind": "Workspace",
            "spec": {
                "repository": {
                    "gitUrl": request.git_url or "",
                    "gitRepo": request.git_repo or "",
                    "gitRepoId": request.git_repo_id or 0,
                    "gitDomain": request.git_domain or "",
                    "branchName": request.branch_name or "",
                }
            },
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        workspace = Kind(
            user_id=user.id,
            kind="Workspace",
            name=workspace_name,
            namespace="default",
            json=workspace_json,
            is_active=True,
        )
        db.add(workspace)

        # Create task
        title = message[:50] + "..." if len(message) > 50 else message

        # Auto-detect task type based on git_url presence
        task_type = "code" if request.git_url else "chat"

        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": message,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": None,
            },
            "metadata": {
                "name": f"task-{new_task_id}",
                "namespace": "default",
                "labels": {
                    "type": "online",
                    "taskType": task_type,
                    "autoDeleteExecutor": "false",
                    "source": "chat_shell",
                    **({"modelId": request.model_id} if request.model_id else {}),
                    **(
                        {"forceOverrideBotModel": "true"}
                        if request.force_override_bot_model
                        else {}
                    ),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = Kind(
            id=new_task_id,
            user_id=user.id,
            kind="Task",
            name=f"task-{new_task_id}",
            namespace="default",
            json=task_json,
            is_active=True,
        )
        db.add(task)
        task_id = new_task_id

    # Get existing subtasks to determine message_id
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == user.id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    # Create USER subtask
    user_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title=f"User message",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=message,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
    )
    db.add(user_subtask)

    # Create ASSISTANT subtask
    # Note: completed_at is set to a placeholder value because the DB column doesn't allow NULL
    # It will be updated when the stream completes
    assistant_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title=f"Assistant response",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id + 1,
        parent_id=next_message_id,
        error_message="",
        result=None,
        completed_at=datetime.now(),  # Placeholder, will be updated when stream completes
    )
    db.add(assistant_subtask)

    db.commit()
    db.refresh(task)
    db.refresh(assistant_subtask)

    # Initialize Redis chat history from existing subtasks if needed
    # This is crucial for shared tasks that were copied with historical messages
    if existing_subtasks:
        from app.services.chat.session_manager import session_manager

        # Check if history exists in Redis
        redis_history = await session_manager.get_chat_history(task_id)

        # If Redis history is empty but we have subtasks, rebuild history from DB
        if not redis_history:
            logger.info(
                f"Initializing chat history from DB for task {task_id} with {len(existing_subtasks)} existing subtasks"
            )
            history_messages = []

            # Sort subtasks by message_id to ensure correct order
            sorted_subtasks = sorted(existing_subtasks, key=lambda s: s.message_id)

            for subtask in sorted_subtasks:
                # Only include completed subtasks with results
                if subtask.status == SubtaskStatus.COMPLETED:
                    if subtask.role == SubtaskRole.USER:
                        # User message - use prompt field
                        if subtask.prompt:
                            history_messages.append(
                                {"role": "user", "content": subtask.prompt}
                            )
                    elif subtask.role == SubtaskRole.ASSISTANT:
                        # Assistant message - use result.value field
                        if subtask.result and isinstance(subtask.result, dict):
                            content = subtask.result.get("value", "")
                            if content:
                                history_messages.append(
                                    {"role": "assistant", "content": content}
                                )

            # Save to Redis if we found any history
            if history_messages:
                await session_manager.save_chat_history(task_id, history_messages)
                logger.info(
                    f"Initialized {len(history_messages)} messages in Redis for task {task_id}"
                )
    return task, assistant_subtask


@router.post("/stream")
async def stream_chat(
    request: StreamChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Stream chat response for Chat Shell type.

    This endpoint directly calls LLM APIs without going through Docker Executor.
    Only works for teams where all bots use Chat Shell type.

    Supports file attachments via attachment_id parameter. When provided,
    the attachment's extracted text will be prepended to the user message.

    **Offset-based Resume Mode:**
    When `subtask_id` and `offset` are provided, the endpoint enters resume mode:
    - Fetches cached content from Redis/DB
    - Sends content from `offset` position onwards
    - Subscribes to Pub/Sub for real-time updates
    - Each chunk includes `offset` for client-side tracking

    Returns SSE stream with the following events:
    - {"task_id": int, "subtask_id": int, "offset": 0, "content": "", "done": false} - First message with IDs
    - {"offset": int, "content": "...", "done": false} - Content chunks with offset
    - {"offset": int, "content": "", "done": true, "result": {...}} - Completion
    - {"error": "..."} - Error message
    """
    import json

    from fastapi.responses import StreamingResponse

    # Check if this is a resume request
    if request.subtask_id is not None and request.offset is not None:
        return await _handle_resume_stream(
            request.subtask_id,
            request.offset,
            db,
            current_user,
        )

    # Validate team exists
    team = (
        db.query(Kind)
        .filter(
            Kind.id == request.team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    # Check if team supports direct chat
    if not _should_use_direct_chat(db, team, current_user.id):
        raise HTTPException(
            status_code=400,
            detail="This team does not support direct chat. Please use the task API instead.",
        )

    # Handle attachment if provided
    attachment = None
    final_message = request.message
    if request.attachment_id:
        from app.models.subtask_attachment import AttachmentStatus
        from app.services.attachment import attachment_service

        attachment = attachment_service.get_attachment(
            db=db,
            attachment_id=request.attachment_id,
            user_id=current_user.id,
        )

        if attachment is None:
            raise HTTPException(status_code=404, detail="Attachment not found")

        if attachment.status != AttachmentStatus.READY:
            raise HTTPException(
                status_code=400,
                detail=f"Attachment is not ready: {attachment.status.value}",
            )

        # Build message with attachment content
        final_message = attachment_service.build_message_with_attachment(
            request.message, attachment
        )

    # Prepare web search tool definition if enabled
    tools = None
    if request.enable_web_search:
        from app.core.config import settings
        from app.services.chat.tools import get_web_search_mcp

        # Check if web search is enabled globally
        if settings.WEB_SEARCH_ENABLED:
            # Pass the FastMCP tool object directly
            web_search_mcp = get_web_search_mcp(engine_name=request.search_engine)
            if web_search_mcp:
                tools = [web_search_mcp]
        else:
            logger.warning("Web search requested but disabled in configuration")

    # Create task and subtasks (use original message for storage, final_message for LLM)
    task, assistant_subtask = await _create_task_and_subtasks(
        db, current_user, team, request.message, request, request.task_id
    )

    # Link attachment to the user subtask if provided
    if attachment:
        # Find the user subtask (the one before assistant_subtask)
        user_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task.id,
                Subtask.message_id == assistant_subtask.message_id - 1,
                Subtask.role == SubtaskRole.USER,
            )
            .first()
        )
        if user_subtask:
            attachment_service.link_attachment_to_subtask(
                db=db,
                attachment_id=attachment.id,
                subtask_id=user_subtask.id,
                user_id=current_user.id,
            )

    # Get first bot for model config and system prompt
    team_crd = Team.model_validate(team.json)
    first_member = team_crd.spec.members[0]

    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.name == first_member.botRef.name,
            Kind.namespace == first_member.botRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not bot:
        raise HTTPException(status_code=400, detail="Bot not found")

    # Get model config
    try:
        model_config = get_model_config_for_bot(
            db,
            bot,
            team.user_id,
            override_model_name=request.model_id,
            force_override=request.force_override_bot_model,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Get system prompt
    system_prompt = get_bot_system_prompt(db, bot, team.user_id, first_member.prompt)

    # Append clarification mode instructions if enabled
    if request.enable_clarification:
        clarification_prompt = """

## Smart Follow-up Mode (智能追问模式)

When you receive a user request that is ambiguous or lacks important details, ask targeted clarification questions through MULTIPLE ROUNDS before proceeding with the task.

### Output Format

When asking clarification questions, output them in the following Markdown format:

```markdown
## 💬 智能追问 (Smart Follow-up Questions)

### Q1: [Question text]
**Type**: single_choice
**Options**:
- [✓] `value` - Label text (recommended)
- [ ] `value` - Label text

### Q2: [Question text]
**Type**: multiple_choice
**Options**:
- [✓] `value` - Label text (recommended)
- [ ] `value` - Label text
- [ ] `value` - Label text

### Q3: [Question text]
**Type**: text_input
```

### Question Design Guidelines

- Ask 3-5 focused questions per round
- Use `single_choice` for yes/no or mutually exclusive options
- Use `multiple_choice` for features that can be combined
- Use `text_input` for open-ended requirements (e.g., specific details, numbers, names)
- Mark recommended options with `[✓]` and `(recommended)`
- Wrap the entire question section in a markdown code block (```markdown ... ```)

### Question Types

- `single_choice`: User selects ONE option
- `multiple_choice`: User can select MULTIPLE options
- `text_input`: Free text input (no options needed)

### Multi-Round Clarification Strategy (重要！)

**You MUST conduct multiple rounds of clarification (typically 2-4 rounds) to gather sufficient information.**

**Round 1 - Basic Context (基础背景):**
Focus on understanding the overall context:
- What is the general goal/purpose?
- Who is the target audience?
- What format/type is expected?
- What is the general domain/field?

**Round 2 - Specific Details (具体细节):**
Based on Round 1 answers, dig deeper:
- What are the specific requirements within the chosen context?
- What constraints or limitations exist?
- What specific content/data should be included?
- What is the scope or scale?

**Round 3 - Personalization (个性化定制):**
Gather user-specific information:
- What are the user's specific achievements/data/examples?
- What style/tone preferences?
- Any special requirements or exceptions?
- Timeline or deadline considerations?

**Round 4 (if needed) - Final Confirmation (最终确认):**
Clarify any remaining ambiguities before proceeding.

### Exit Criteria - When to STOP Asking and START Executing (退出标准)

**ONLY proceed to execute the task when ALL of the following conditions are met:**

1. **Sufficient Specificity (足够具体):** You have enough specific details to produce a personalized, actionable result rather than a generic template.

2. **Actionable Information (可执行信息):** You have concrete data, examples, or specifics that can be directly incorporated into the output.

3. **Clear Scope (明确范围):** The boundaries and scope of the task are well-defined.

4. **No Critical Gaps (无关键缺失):** There are no critical pieces of information missing that would significantly impact the quality of the output.

**Examples of when to CONTINUE asking:**

- User says "互联网行业" but hasn't specified their role (产品/研发/运营/设计/etc.)
- User wants a "年终汇报" but hasn't mentioned any specific achievements or projects
- User requests a "PPT" but hasn't provided any data or metrics to include
- User mentions a goal but hasn't specified constraints (time, budget, resources)

**Examples of when to STOP asking and proceed:**

- User has provided their specific role, key projects, measurable achievements, and target audience
- User has given concrete numbers, dates, or examples that can be directly used
- User explicitly indicates they want to proceed with current information
- You have asked 4+ rounds and have gathered substantial information

### Information Completeness Checklist (信息完整度检查)

Before deciding to proceed, mentally check:

- [ ] WHO: Target audience clearly identified
- [ ] WHAT: Specific deliverable type and format defined
- [ ] WHY: Purpose and goals understood
- [ ] HOW: Style, tone, and approach determined
- [ ] DETAILS: Specific content, data, or examples provided
- [ ] CONSTRAINTS: Limitations, requirements, or preferences known

**If fewer than 4 items are checked, you likely need another round of questions.**

### Response After Receiving Answers

After each round of user answers:

1. **Acknowledge** the answers briefly (1-2 sentences)
2. **Assess** whether you have sufficient information (use the checklist above)
3. **Either:**
   - Ask follow-up questions (next round) if information is still insufficient
   - OR proceed with the task if exit criteria are met

**Important:** Do NOT rush to provide a solution after just one round of questions. Take time to gather comprehensive information for a truly personalized and high-quality output.
"""
        system_prompt = system_prompt + clarification_prompt

    # Build data_sources for placeholder replacement in DEFAULT_HEADERS
    # This mirrors the executor's member_builder.py logic
    bot_crd = Bot.model_validate(bot.json)
    bot_json = bot.json or {}
    bot_spec = bot_json.get("spec", {})
    agent_config = bot_spec.get("agent_config", {})

    # Get user info for data sources
    user_info = {
        "id": current_user.id,
        "name": current_user.user_name,
    }

    # Build task_data similar to executor format
    task_data = {
        "task_id": task.id,
        "team_id": team.id,
        "user": user_info,
        "git_url": request.git_url or "",
        "git_repo": request.git_repo or "",
        "git_domain": request.git_domain or "",
        "branch_name": request.branch_name or "",
        "prompt": request.message,
    }

    # Build data_sources for placeholder replacement
    data_sources = {
        "agent_config": agent_config,
        "model_config": model_config,  # Contains api_key, base_url, model_id, etc.
        "task_data": task_data,
        "user": user_info,
        "env": model_config.get("default_headers", {}),  # For backward compatibility
    }

    # Process DEFAULT_HEADERS with placeholder replacement
    raw_default_headers = model_config.get("default_headers", {})

    logger.info(f"Raw default headers before processing: {raw_default_headers}")
    logger.info(f"Data sources for header processing: {data_sources}")

    if raw_default_headers:
        processed_headers = build_default_headers_with_placeholders(
            raw_default_headers, data_sources
        )
        model_config["default_headers"] = processed_headers

    logger.info(f"Streaming chat for model_config={model_config}")

    # Create streaming response with task_id and subtask_id in first message
    import json

    from fastapi.responses import StreamingResponse

    async def generate_with_ids():
        # Send first message with IDs
        first_msg = {
            "task_id": task.id,
            "subtask_id": assistant_subtask.id,
            "content": "",
            "done": False,
        }
        yield f"data: {json.dumps(first_msg)}\n\n"

        # Get the actual stream from chat service (use final_message with attachment content)
        stream_response = await chat_service.chat_stream(
            subtask_id=assistant_subtask.id,
            task_id=task.id,
            message=final_message,
            model_config=model_config,
            system_prompt=system_prompt,
            tools=tools,
        )

        # Forward the stream
        async for chunk in stream_response.body_iterator:
            yield chunk

    return StreamingResponse(
        generate_with_ids(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            # Return task_id and subtask_id in headers for immediate access
            "X-Task-Id": str(task.id),
            "X-Subtask-Id": str(assistant_subtask.id),
        },
    )


async def _handle_resume_stream(
    subtask_id: int,
    offset: int,
    db: Session,
    current_user: User,
):
    """
    Handle resume/reconnect stream request with offset-based continuation.

    This function implements the offset-based streaming protocol:
    1. Verify subtask ownership and status
    2. Get cached content from Redis/DB
    3. Send content from offset position onwards
    4. Subscribe to Pub/Sub for real-time updates
    5. Each chunk includes offset for client-side tracking

    Args:
        subtask_id: The subtask ID to resume
        offset: Character offset to resume from (0 = send all cached content)
        db: Database session
        current_user: Current authenticated user

    Returns:
        StreamingResponse with offset-based SSE events
    """
    import json

    from fastapi.responses import StreamingResponse

    from app.services.chat.session_manager import session_manager

    # Verify subtask ownership
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check subtask status
    if subtask.status == SubtaskStatus.COMPLETED:
        # Already completed - send final content
        content = ""
        if subtask.result:
            content = subtask.result.get("value", "")

        async def generate_completed():
            # Send content from offset
            if offset < len(content):
                remaining = content[offset:]
                yield f"data: {json.dumps({'offset': offset, 'content': remaining, 'done': False})}\n\n"

            # Send completion
            yield f"data: {json.dumps({'offset': len(content), 'content': '', 'done': True, 'result': subtask.result})}\n\n"

        return StreamingResponse(
            generate_completed(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-Task-Id": str(subtask.task_id),
                "X-Subtask-Id": str(subtask_id),
            },
        )

    if subtask.status == SubtaskStatus.FAILED:
        raise HTTPException(
            status_code=400, detail=f"Subtask failed: {subtask.error_message}"
        )

    if subtask.status not in [SubtaskStatus.RUNNING, SubtaskStatus.PENDING]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot resume stream for subtask in {subtask.status.value} state",
        )

    async def generate_resume():
        import asyncio

        current_offset = offset

        try:
            # 1. Get cached content from Redis first
            cached_content = await session_manager.get_streaming_content(subtask_id)

            # If no Redis content, try database
            if not cached_content and subtask.result:
                cached_content = subtask.result.get("value", "")

            # 2. Send cached content from offset position
            if cached_content and current_offset < len(cached_content):
                remaining = cached_content[current_offset:]
                yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False, 'cached': True})}\n\n"
                current_offset = len(cached_content)

            # Check if subtask already completed before subscribing
            db.refresh(subtask)
            if subtask.status == SubtaskStatus.COMPLETED:
                final_content = ""
                if subtask.result:
                    final_content = subtask.result.get("value", "")

                # Send any remaining content
                if current_offset < len(final_content):
                    remaining = final_content[current_offset:]
                    yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                    current_offset = len(final_content)

                yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                return

            if subtask.status == SubtaskStatus.FAILED:
                yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                return

            # 3. Subscribe to Redis Pub/Sub for real-time updates
            redis_client, pubsub = await session_manager.subscribe_streaming_channel(
                subtask_id
            )
            if not pubsub:
                # No pub/sub available - check if stream is still active
                # If not, the stream might have completed while we were connecting
                logger.warning(
                    f"Could not subscribe to streaming channel for subtask {subtask_id}"
                )

                # Re-check subtask status
                db.refresh(subtask)
                if subtask.status == SubtaskStatus.COMPLETED:
                    final_content = ""
                    if subtask.result:
                        final_content = subtask.result.get("value", "")

                    # Send any remaining content
                    if current_offset < len(final_content):
                        remaining = final_content[current_offset:]
                        yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                        current_offset = len(final_content)

                    yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                else:
                    yield f"data: {json.dumps({'error': 'Stream not available'})}\n\n"
                return

            try:
                # 4. Listen for new chunks with timeout and status check
                last_status_check = asyncio.get_event_loop().time()
                status_check_interval = 2.0  # Check status every 2 seconds

                while True:
                    try:
                        # Use get_message with timeout instead of listen()
                        message = await asyncio.wait_for(
                            pubsub.get_message(
                                ignore_subscribe_messages=True, timeout=1.0
                            ),
                            timeout=2.0,
                        )

                        if message and message["type"] == "message":
                            chunk = message["data"]
                            if isinstance(chunk, bytes):
                                chunk = chunk.decode("utf-8")
                            # Check for stream done signal (now JSON format with result)
                            # Try to parse as JSON first
                            try:
                                done_data = json.loads(chunk)
                                # Ensure it's a dict before checking __type__
                                if (
                                    isinstance(done_data, dict)
                                    and done_data.get("__type__") == "STREAM_DONE"
                                ):
                                    # Extract result directly from Pub/Sub message
                                    final_result = done_data.get("result")
                                    yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': final_result})}\n\n"
                                    break
                            except json.JSONDecodeError:
                                pass  # Not JSON, treat as regular chunk
                                pass  # Not JSON, treat as regular chunk

                            # Legacy support: check for old format
                            if chunk == "__STREAM_DONE__":
                                # Fallback to database for old format
                                db.refresh(subtask)
                                yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': subtask.result})}\n\n"
                                break

                            # Send new chunk with offset
                            yield f"data: {json.dumps({'offset': current_offset, 'content': chunk, 'done': False})}\n\n"
                            current_offset += len(chunk)

                    except asyncio.TimeoutError:
                        pass  # Timeout is expected, continue to status check

                    # Periodically check subtask status in case we missed the done signal
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_status_check >= status_check_interval:
                        last_status_check = current_time
                        db.refresh(subtask)

                        if subtask.status == SubtaskStatus.COMPLETED:
                            # Status check detected completion - get result from database
                            # This is a fallback path when Pub/Sub message was missed
                            final_result = subtask.result

                            final_content = ""
                            if final_result:
                                final_content = final_result.get("value", "")

                            # Send any remaining content
                            if current_offset < len(final_content):
                                remaining = final_content[current_offset:]
                                yield f"data: {json.dumps({'offset': current_offset, 'content': remaining, 'done': False})}\n\n"
                                current_offset = len(final_content)

                            yield f"data: {json.dumps({'offset': current_offset, 'content': '', 'done': True, 'result': final_result})}\n\n"
                            break

                        if subtask.status == SubtaskStatus.FAILED:
                            yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                            break

                        if subtask.status not in [
                            SubtaskStatus.RUNNING,
                            SubtaskStatus.PENDING,
                        ]:
                            yield f"data: {json.dumps({'error': f'Unexpected subtask status: {subtask.status.value}'})}\n\n"
                            break
            finally:
                # Cleanup: unsubscribe and close client
                await pubsub.unsubscribe()
                await pubsub.close()
                if redis_client:
                    await redis_client.aclose()

        except Exception as e:
            logger.error(
                f"Error in resume stream for subtask {subtask_id}: {e}", exc_info=True
            )
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate_resume(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Task-Id": str(subtask.task_id),
            "X-Subtask-Id": str(subtask_id),
        },
    )


@router.get("/check-direct-chat/{team_id}")
async def check_direct_chat(
    team_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Check if a team supports direct chat mode.

    Returns:
        {"supports_direct_chat": bool, "shell_type": str}
    """
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )

    if not team:
        raise HTTPException(status_code=404, detail="Team not found")

    supports_direct_chat = _should_use_direct_chat(db, team, current_user.id)

    # Get shell type of first bot
    shell_type = ""
    team_crd = Team.model_validate(team.json)
    if team_crd.spec.members:
        first_member = team_crd.spec.members[0]
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == first_member.botRef.name,
                Kind.namespace == first_member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if bot:
            shell_type = _get_shell_type(db, bot, team.user_id)

    return {
        "supports_direct_chat": supports_direct_chat,
        "shell_type": shell_type,
    }


class CancelChatRequest(BaseModel):
    """Request body for cancelling a chat stream."""

    subtask_id: int
    partial_content: str | None = None  # Partial content received before cancellation


@router.post("/cancel")
async def cancel_chat(
    request: CancelChatRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Cancel an ongoing chat stream.

    For Chat Shell type, this endpoint:
    - Signals the streaming loop to stop via cancellation event
    - Updates the subtask status to COMPLETED (not CANCELLED) to show the truncated message
    - Saves the partial content received before cancellation
    - Updates the task status to COMPLETED so the conversation can continue

    This allows users to see the partial response and continue the conversation.

    Returns:
        {"success": bool, "message": str}
    """
    # Find the subtask
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == request.subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Check if subtask is in a cancellable state
    if subtask.status not in [SubtaskStatus.PENDING, SubtaskStatus.RUNNING]:
        return {
            "success": False,
            "message": f"Subtask is already in {subtask.status.value} state",
        }

    # Signal the streaming loop to stop via Redis (cross-worker)
    # This will cause the LLM API call to be interrupted
    from app.services.chat.session_manager import session_manager

    await session_manager.cancel_stream(request.subtask_id)

    # For Chat Shell, we mark as COMPLETED instead of CANCELLED
    # This allows the truncated message to be displayed normally
    # and the user can continue the conversation
    subtask.status = SubtaskStatus.COMPLETED
    subtask.progress = 100
    subtask.completed_at = datetime.now()
    subtask.updated_at = datetime.now()
    # Don't set error_message for stopped chat - it's not an error
    subtask.error_message = ""

    # Save partial content if provided
    if request.partial_content:
        subtask.result = {"value": request.partial_content}
    else:
        # If no partial content, set empty result
        subtask.result = {"value": ""}

    # Also update the task status to COMPLETED so conversation can continue
    task = (
        db.query(Kind)
        .filter(
            Kind.id == subtask.task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
        )
        .first()
    )

    if task:
        from sqlalchemy.orm.attributes import flag_modified

        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            # Set to COMPLETED instead of CANCELLED
            # This allows the user to continue the conversation
            task_crd.status.status = "COMPLETED"
            task_crd.status.errorMessage = ""  # No error message for stopped chat
            task_crd.status.updatedAt = datetime.now()
            task_crd.status.completedAt = datetime.now()

        task.json = task_crd.model_dump(mode="json")
        task.updated_at = datetime.now()
        flag_modified(task, "json")

    db.commit()

    return {"success": True, "message": "Chat stopped successfully"}


@router.get("/streaming-content/{subtask_id}")
async def get_streaming_content(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Get streaming content for a subtask (from Redis or DB).

    Used for recovery when user refreshes during streaming.
    This endpoint tries to get the most recent content from:
    1. Redis streaming cache (most recent, updated every 1 second)
    2. Database result field (fallback, updated every 5 seconds)

    Returns:
        {
            "content": str,           # The accumulated content
            "source": str,            # "redis" or "database"
            "streaming": bool,        # Whether still streaming
            "status": str,            # Subtask status
            "incomplete": bool        # Whether content is incomplete (client disconnected)
        }
    """
    # Verify subtask ownership
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # 1. Try to get from Redis first (most recent)
    from app.services.chat.session_manager import session_manager

    redis_content = await session_manager.get_streaming_content(subtask_id)

    if redis_content:
        return {
            "content": redis_content,
            "source": "redis",
            "streaming": True,
            "status": subtask.status.value,
            "incomplete": False,
        }

    # 2. Fallback to database
    db_content = ""
    is_streaming = False
    is_incomplete = False

    if subtask.result:
        db_content = subtask.result.get("value", "")
        is_streaming = subtask.result.get("streaming", False)
        is_incomplete = subtask.result.get("incomplete", False)

    return {
        "content": db_content,
        "source": "database",
        "streaming": is_streaming,
        "status": subtask.status.value,
        "incomplete": is_incomplete,
    }


@router.get("/resume-stream/{subtask_id}")
async def resume_stream(
    subtask_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """
    Resume streaming for a running subtask after page refresh.

    This endpoint allows users to refresh the page and continue receiving
    streaming content from an ongoing Chat Shell task, similar to OpenAI's implementation.

    Flow:
    1. Verify subtask ownership and status (must be RUNNING)
    2. Send cached content from Redis immediately
    3. Subscribe to Redis Pub/Sub channel for real-time updates
    4. Continue streaming new content as it arrives
    5. End stream when "__STREAM_DONE__" signal is received

    Returns SSE stream with:
    - {"content": "...", "done": false, "cached": true} - Cached content (first message)
    - {"content": "...", "done": false} - New streaming content
    - {"content": "", "done": true} - Stream completion
    """
    import json

    from fastapi.responses import StreamingResponse

    # Verify subtask ownership
    subtask = (
        db.query(Subtask)
        .filter(
            Subtask.id == subtask_id,
            Subtask.user_id == current_user.id,
        )
        .first()
    )

    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")

    # Only allow resuming RUNNING subtasks
    if subtask.status != SubtaskStatus.RUNNING:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot resume stream for subtask in {subtask.status.value} state",
        )

    async def generate_resume():
        import asyncio

        from app.services.chat.session_manager import session_manager

        try:
            # 1. Send cached content first (from Redis)
            cached_content = await session_manager.get_streaming_content(subtask_id)
            if cached_content:
                yield f"data: {json.dumps({'content': cached_content, 'done': False, 'cached': True})}\n\n"

            # Check if subtask already completed before subscribing
            db.refresh(subtask)
            if subtask.status == SubtaskStatus.COMPLETED:
                yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                return

            if subtask.status == SubtaskStatus.FAILED:
                yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                return

            # 2. Subscribe to Redis Pub/Sub for real-time updates
            redis_client, pubsub = await session_manager.subscribe_streaming_channel(
                subtask_id
            )
            if not pubsub:
                # No pub/sub available - check if stream completed
                logger.warning(
                    f"Could not subscribe to streaming channel for subtask {subtask_id}"
                )
                db.refresh(subtask)
                if subtask.status == SubtaskStatus.COMPLETED:
                    yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                else:
                    yield f"data: {json.dumps({'content': '', 'done': True, 'error': 'Stream not available'})}\n\n"
                return

            try:
                # 3. Listen for new chunks with timeout and status check
                last_status_check = asyncio.get_event_loop().time()
                status_check_interval = 2.0  # Check status every 2 seconds

                while True:
                    try:
                        # Use get_message with timeout instead of listen()
                        message = await asyncio.wait_for(
                            pubsub.get_message(
                                ignore_subscribe_messages=True, timeout=1.0
                            ),
                            timeout=2.0,
                        )

                        if message and message["type"] == "message":
                            chunk = message["data"]
                            if isinstance(chunk, bytes):
                                chunk = chunk.decode("utf-8")

                            # Check for stream done signal (now JSON format with result)
                            try:
                                done_data = json.loads(chunk)
                                # Ensure it's a dict before checking __type__
                                if (
                                    isinstance(done_data, dict)
                                    and done_data.get("__type__") == "STREAM_DONE"
                                ):
                                    # Extract result directly from Pub/Sub message
                                    final_result = done_data.get("result")
                                    yield f"data: {json.dumps({'content': '', 'done': True, 'result': final_result})}\n\n"
                                    break
                            except json.JSONDecodeError:
                                pass  # Not JSON, treat as regular chunk

                            # Legacy support: check for old format
                            if chunk == "__STREAM_DONE__":
                                yield f"data: {json.dumps({'content': '', 'done': True})}\n\n"
                                break

                            # Send new chunk
                            yield f"data: {json.dumps({'content': chunk, 'done': False})}\n\n"

                    except asyncio.TimeoutError:
                        pass  # Timeout is expected, continue to status check

                    # Periodically check subtask status in case we missed the done signal
                    current_time = asyncio.get_event_loop().time()
                    if current_time - last_status_check >= status_check_interval:
                        last_status_check = current_time
                        db.refresh(subtask)

                        if subtask.status == SubtaskStatus.COMPLETED:
                            yield f"data: {json.dumps({'content': '', 'done': True, 'result': subtask.result})}\n\n"
                            break

                        if subtask.status == SubtaskStatus.FAILED:
                            yield f"data: {json.dumps({'error': f'Subtask failed: {subtask.error_message}'})}\n\n"
                            break

                        if subtask.status not in [
                            SubtaskStatus.RUNNING,
                            SubtaskStatus.PENDING,
                        ]:
                            yield f"data: {json.dumps({'error': f'Unexpected subtask status: {subtask.status.value}'})}\n\n"
                            break
            finally:
                # Cleanup: unsubscribe and close client
                await pubsub.unsubscribe()
                await pubsub.close()
                if redis_client:
                    await redis_client.aclose()

        except Exception as e:
            logger.error(
                f"Error in resume_stream for subtask {subtask_id}: {e}", exc_info=True
            )
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate_resume(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "Content-Encoding": "none",
        },
    )


@router.get("/search-engines")
async def get_search_engines(
    current_user: User = Depends(security.get_current_user),
):
    """
    Get available search engines from configuration.

    Returns:
        {
            "enabled": bool,
            "engines": [{"name": str, "display_name": str}]
        }
    """
    from app.core.config import settings
    from app.services.search.factory import get_available_engines

    if not settings.WEB_SEARCH_ENABLED:
        return {"enabled": False, "engines": []}

    # Get available engines from factory
    engines = get_available_engines()

    return {
        "enabled": True,
        "engines": engines,
    }
