# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tools factory module.

Responsible for:
- Creating LoadSkillTool
- Dynamically creating skill tools
- Loading MCP servers from skill configurations

In HTTP mode, skill binaries are downloaded from backend API.
"""

import asyncio
import logging
import time
from typing import Any, Optional

import httpx

from chat_shell.core.config import settings
from shared.models.execution import ExecutionRequest
from shared.telemetry.context import get_request_id

logger = logging.getLogger(__name__)


def prepare_load_skill_tool(
    skill_names: list[str],
    user_id: int,
    skill_configs: list[dict] | None = None,
) -> Optional[Any]:
    """
    Prepare LoadSkillTool if skills are configured.

    This function creates a LoadSkillTool instance that allows the model
    to dynamically load skill prompts on demand.

    Skills with preload=True are filtered out from the available skill list,
    as they will be preloaded via preload_skill_prompt() and don't need to be
    loaded dynamically.

    Args:
        skill_names: List of skill names available for this session
        user_id: User ID for skill lookup
        skill_configs: Optional skill configurations containing prompts and preload flags

    Returns:
        LoadSkillTool instance or None if no skills configured
    """
    if not skill_names:
        return None

    # Import LoadSkillTool
    from chat_shell.tools.builtin import LoadSkillTool

    # Build skill metadata from skill_configs
    skill_metadata = {}
    if skill_configs:
        for config in skill_configs:
            name = config.get("name")
            if name:
                skill_metadata[name] = {
                    "description": config.get("description", ""),
                    "prompt": config.get("prompt", ""),
                    "displayName": config.get("displayName", ""),
                }

    # Create LoadSkillTool with the available skills
    load_skill_tool = LoadSkillTool(
        user_id=user_id,
        skill_names=skill_names,
        skill_metadata=skill_metadata,
    )

    logger.info(
        "[skill_factory] Created LoadSkillTool with skills: %s",
        skill_names,
    )

    return load_skill_tool


async def _download_skill_binary(download_url: str, skill_name: str) -> Optional[bytes]:
    """
    Download skill binary from backend API.

    Args:
        download_url: URL to download skill binary from
        skill_name: Skill name for logging

    Returns:
        Binary data or None if download failed
    """
    try:
        service_token = settings.backend_internal_token
        headers = {"X-Service-Name": "chat-shell"}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"
        request_id = get_request_id()
        if request_id:
            headers["X-Request-ID"] = request_id

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(download_url, headers=headers)
            response.raise_for_status()

            logger.debug(
                "[skill_factory] Downloaded skill binary for '%s': %d bytes",
                skill_name,
                len(response.content),
            )
            return response.content

    except httpx.HTTPStatusError as e:
        logger.error(
            "[skill_factory] HTTP error downloading skill '%s' from %s: %d %s",
            skill_name,
            download_url,
            e.response.status_code,
            e.response.text[:200] if e.response.text else "",
        )
    except Exception as e:
        logger.error(
            "[skill_factory] Error downloading skill '%s' from %s: %s",
            skill_name,
            download_url,
            str(e),
        )

    return None


async def _create_provider_tools_for_skill(
    *,
    task_id: int,
    subtask_id: int,
    user_id: int,
    skill_config: dict[str, Any],
    registry: Any,
    remote_url: str,
    ws_emitter: Any = None,
    user_name: Optional[str] = None,
    auth_token: Optional[str] = None,
    skill_identity_token: Optional[str] = None,
) -> list[Any]:
    """Load a skill provider if needed and create concrete tool instances."""
    from chat_shell.skills import SkillToolContext

    skill_name = skill_config.get("name", "unknown")
    provider_config = skill_config.get("provider")
    skill_id = skill_config.get("skill_id")
    skill_user_id = skill_config.get("skill_user_id")

    # Load provider from skill package if provider config is present.
    # SECURITY: Only public skills (user_id=0) can load code.
    provider_names = {
        tool_decl.get("provider")
        for tool_decl in skill_config.get("tools", [])
        if tool_decl.get("provider")
    }
    providers_already_loaded = bool(provider_names) and all(
        registry.get_provider(provider_name) is not None
        for provider_name in provider_names
    )
    if providers_already_loaded:
        logger.info(
            "[skill_factory] Skill '%s' provider(s) already registered, "
            "skipping binary download: %s",
            skill_name,
            sorted(provider_names),
        )
    elif provider_config and skill_id:
        is_public = skill_user_id == 0

        if not is_public:
            logger.warning(
                "[skill_factory] SECURITY: Skipping code loading for non-public "
                "skill '%s' (user_id=%s). Only public skills can load code.",
                skill_name,
                skill_user_id,
            )
        else:
            try:
                binary_data = None

                if remote_url and skill_id:
                    download_start = time.perf_counter()
                    download_url = f"{remote_url}/skills/{skill_id}/binary"
                    binary_data = await _download_skill_binary(download_url, skill_name)
                    logger.info(
                        "[skill_factory_perf] skill=%s binary_download=%.2fms",
                        skill_name,
                        (time.perf_counter() - download_start) * 1000,
                    )

                if binary_data:
                    provider_start = time.perf_counter()
                    loaded = registry.ensure_provider_loaded(
                        skill_name=skill_name,
                        provider_config=provider_config,
                        zip_content=binary_data,
                        is_public=is_public,
                    )
                    logger.info(
                        "[skill_factory_perf] skill=%s provider_load=%.2fms loaded=%s",
                        skill_name,
                        (time.perf_counter() - provider_start) * 1000,
                        loaded,
                    )
                    if not loaded:
                        logger.warning(
                            "[skill_factory] Failed to load provider for skill '%s'",
                            skill_name,
                        )
                else:
                    logger.warning(
                        "[skill_factory] No binary data found for skill '%s' (id=%s)",
                        skill_name,
                        skill_id,
                    )
            except Exception as e:
                logger.error(
                    "[skill_factory] Error loading provider for skill '%s': %s",
                    skill_name,
                    str(e),
                )

    context = SkillToolContext(
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=user_id,
        db_session=None,
        ws_emitter=ws_emitter,
        skill_config=skill_config,
        user_name=user_name,
        auth_token=auth_token,
        skill_identity_token=skill_identity_token,
    )

    create_tools_start = time.perf_counter()
    skill_tools = registry.create_tools_for_skill(skill_config, context)
    logger.info(
        "[skill_factory_perf] skill=%s create_tools=%.2fms tool_count=%d",
        skill_name,
        (time.perf_counter() - create_tools_start) * 1000,
        len(skill_tools or []),
    )
    return skill_tools or []


async def prepare_skill_tools(
    task_id: int,
    subtask_id: int,
    user_id: int,
    skill_configs: list[dict[str, Any]],
    ws_emitter: Any = None,
    load_skill_tool: Optional[Any] = None,
    preload_skills: Optional[list[str]] = None,
    user_selected_skills: Optional[list[str]] = None,
    user_name: str = "",
    auth_token: str = "",
    skill_identity_token: str = "",
    task_data: Optional[ExecutionRequest] = None,
) -> tuple[list[Any], list[Any]]:
    """
    Prepare skill tools dynamically using SkillToolRegistry.

    This function creates concrete tool instances only for active skills. For
    inactive provider-backed skills, lightweight proxy tools are registered and
    the provider package is downloaded only after load_skill activates the skill.

    For preloaded or user-selected skills, their tools are immediately available.
    For non-preloaded skills, registered tools become available after the skill
    is loaded via load_skill tool.

    Additionally, if an active skill has mcpServers configured, the MCP servers
    will be merged and loaded as one batch. Inactive skill MCP servers are
    deferred so ordinary chat turns do not pay connection and schema loading cost.

    Skill binaries are downloaded from backend API using REMOTE_STORAGE_URL.

    When a load_skill_tool is provided, this function will preload skills specified
    in preload_skills by calling preload_skill_prompt(). These skills will be automatically
    injected into model input via prompt_modifier.

    Args:
        task_id: Task ID for WebSocket room
        subtask_id: Subtask ID for correlation
        user_id: User ID for access control
        skill_configs: List of skill configurations from ChatConfig.skill_configs
            Each config contains: {"name": "...", "description": "...", "tools": [...],
                                   "provider": {...}, "skill_id": int, "mcpServers": {...}}
        ws_emitter: Optional WebSocket emitter for real-time communication
        load_skill_tool: Optional LoadSkillTool instance to preload skill prompts
        preload_skills: Optional list of skill names to preload into dynamic context.
                       Skills in this list will have their prompts injected automatically.
        user_selected_skills: Optional list of skill names that were explicitly selected
                             by the user for this message. These skills will be highlighted
                             in dynamic context to encourage the model to prioritize them.
        user_name: Username for identifying the user
        auth_token: JWT token for API authentication (e.g., attachment upload/download)
        skill_identity_token: JWT token for skill identity verification
        task_data: Optional task data for MCP variable substitution

    Returns:
        Tuple of (tools, mcp_clients) where:
        - tools: List of tool instances created from skill configurations
                 (only preloaded skills' tools are in this list for immediate use)
        - mcp_clients: List of MCPClient instances that need to be cleaned up
    """
    from chat_shell.skills import SkillToolContext, SkillToolRegistry

    tools: list[Any] = []
    mcp_clients: list[Any] = []

    if not ws_emitter:
        # In HTTP mode, WebSocket is not used, so this is expected
        logger.debug(
            "[skill_factory] WebSocket emitter not available (expected in HTTP mode)"
        )

    # Get the registry instance
    registry = SkillToolRegistry.get_instance()

    # Get base URL for skill binary downloads
    remote_url = getattr(settings, "REMOTE_STORAGE_URL", "").rstrip("/")

    # Collect active skill MCP server configs for batch loading. Candidate skills
    # stay available through load_skill prompt metadata without connecting their
    # MCP servers during request startup.
    skill_mcp_configs: dict[str, dict[str, Any]] = {}
    skill_mcp_server_owner: dict[str, str] = {}  # prefixed_server_name -> skill_name
    preload_skill_set = set(preload_skills or [])
    user_selected_skill_set = set(user_selected_skills or [])
    active_skill_set = preload_skill_set | user_selected_skill_set
    function_start = time.perf_counter()

    # Process each skill configuration
    for skill_config in skill_configs:
        skill_start = time.perf_counter()
        skill_name = skill_config.get("name", "unknown")
        tool_declarations = skill_config.get("tools", [])
        provider_config = skill_config.get("provider")
        skill_id = skill_config.get("skill_id")
        skill_user_id = skill_config.get("skill_user_id")
        mcp_servers = skill_config.get("mcpServers")

        # Check if this skill should be preloaded
        should_preload = skill_name in preload_skill_set
        is_user_selected = skill_name in user_selected_skill_set
        should_activate = skill_name in active_skill_set

        # Collect MCP servers from skill config.
        # Only active skill MCP servers are loaded here.
        if mcp_servers and should_activate:
            logger.info(
                "[skill_factory] Skill '%s' has %d active MCP server(s) configured "
                "(preload=%s, user_selected=%s)",
                skill_name,
                len(mcp_servers),
                should_preload,
                is_user_selected,
            )
            # Prefix MCP server names with skill name to avoid conflicts across skills.
            for server_name, server_config in mcp_servers.items():
                prefixed_name = f"{skill_name}_{server_name}"
                skill_mcp_configs[prefixed_name] = server_config
                skill_mcp_server_owner[prefixed_name] = skill_name
        elif mcp_servers:
            logger.info(
                "[skill_factory] Deferring %d MCP server(s) for inactive skill '%s' "
                "(preload=%s, user_selected=%s)",
                len(mcp_servers),
                skill_name,
                should_preload,
                is_user_selected,
            )
            if load_skill_tool is not None:

                async def load_deferred_mcp_tools(
                    skill_name=skill_name,
                    mcp_servers=mcp_servers,
                ):
                    load_start = time.perf_counter()
                    deferred_mcp_configs: dict[str, dict[str, Any]] = {}
                    for server_name, server_config in mcp_servers.items():
                        deferred_mcp_configs[f"{skill_name}_{server_name}"] = (
                            server_config
                        )

                    tools_with_server, clients = await _load_skill_mcp_tools(
                        deferred_mcp_configs,
                        task_id,
                        task_data,
                    )
                    if hasattr(load_skill_tool, "add_deferred_mcp_clients"):
                        load_skill_tool.add_deferred_mcp_clients(clients)

                    loaded_tools: list[Any] = []
                    for server_tools in tools_with_server.values():
                        loaded_tools.extend(server_tools)

                    logger.info(
                        "[skill_factory_perf] skill=%s deferred_mcp_load=%.2fms "
                        "server_count=%d tool_count=%d",
                        skill_name,
                        (time.perf_counter() - load_start) * 1000,
                        len(deferred_mcp_configs),
                        len(loaded_tools),
                    )
                    return loaded_tools

                load_skill_tool.register_skill_tool_loader(
                    skill_name, load_deferred_mcp_tools
                )

        if not tool_declarations:
            # No tools declared for this skill, skip tool creation
            # but MCP servers may still be loaded above for active skills.
            # Still preload the skill prompt if this skill is active.
            if should_activate and load_skill_tool is not None:
                skill_prompt = skill_config.get("prompt", "")
                if skill_prompt:
                    load_skill_tool.preload_skill_prompt(
                        skill_name, skill_config, is_user_selected=is_user_selected
                    )
                    logger.info(
                        "[skill_factory] Preloaded skill prompt for '%s' "
                        "(no tools, in preload_skills list, user_selected=%s)",
                        skill_name,
                        is_user_selected,
                    )
            logger.info(
                "[skill_factory_perf] skill=%s total=%.2fms active=%s "
                "tool_declarations=0 mcp_servers=%d",
                skill_name,
                (time.perf_counter() - skill_start) * 1000,
                should_activate,
                len(mcp_servers or {}),
            )
            continue

        logger.debug(
            "[skill_factory] Processing skill '%s' with %d tool declarations",
            skill_name,
            len(tool_declarations),
        )

        if not should_activate and load_skill_tool is not None:
            from chat_shell.tools.builtin.load_skill import LazySkillProviderTool

            lazy_tools = []
            for tool_decl in tool_declarations:
                tool_name = tool_decl.get("name")
                if not tool_name:
                    continue
                lazy_tools.append(
                    LazySkillProviderTool(
                        skill_name=skill_name,
                        tool_name=tool_name,
                        description=tool_decl.get("description", ""),
                        load_skill_tool=load_skill_tool,
                    )
                )

            if lazy_tools:

                async def load_deferred_tools(
                    skill_config=skill_config,
                    skill_name=skill_name,
                ):
                    load_start = time.perf_counter()
                    loaded_tools = await _create_provider_tools_for_skill(
                        task_id=task_id,
                        subtask_id=subtask_id,
                        user_id=user_id,
                        skill_config=skill_config,
                        registry=registry,
                        remote_url=remote_url,
                        ws_emitter=ws_emitter,
                        user_name=user_name,
                        auth_token=auth_token,
                        skill_identity_token=skill_identity_token,
                    )
                    logger.info(
                        "[skill_factory_perf] skill=%s deferred_provider_load=%.2fms "
                        "tool_count=%d",
                        skill_name,
                        (time.perf_counter() - load_start) * 1000,
                        len(loaded_tools),
                    )
                    return loaded_tools

                load_skill_tool.register_skill_tools(skill_name, lazy_tools)
                load_skill_tool.register_skill_tool_loader(
                    skill_name, load_deferred_tools
                )
                logger.info(
                    "[skill_factory] Deferred %d provider tool(s) for inactive skill '%s'",
                    len(lazy_tools),
                    skill_name,
                )

            logger.info(
                "[skill_factory_perf] skill=%s total=%.2fms active=%s "
                "tool_declarations=%d mcp_servers=%d",
                skill_name,
                (time.perf_counter() - skill_start) * 1000,
                should_activate,
                len(tool_declarations or []),
                len(mcp_servers or {}),
            )
            continue

        skill_tools = await _create_provider_tools_for_skill(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=user_id,
            skill_config=skill_config,
            registry=registry,
            remote_url=remote_url,
            ws_emitter=ws_emitter,
            user_name=user_name,
            auth_token=auth_token,
            skill_identity_token=skill_identity_token,
        )

        if skill_tools:
            logger.info(
                "[skill_factory] Created %d tools for skill '%s': %s",
                len(skill_tools),
                skill_name,
                [t.name for t in skill_tools],
            )

            # Register tools with LoadSkillTool for dynamic tool selection
            if load_skill_tool is not None:
                load_skill_tool.register_skill_tools(skill_name, skill_tools)
                logger.debug(
                    "[skill_factory] Registered %d tools for skill '%s' with LoadSkillTool",
                    len(skill_tools),
                    skill_name,
                )

            # For active skills, add tools to the immediate tools list
            # and preload the skill prompt
            if should_activate:
                tools.extend(skill_tools)
                if load_skill_tool is not None:
                    skill_prompt = skill_config.get("prompt", "")
                    if skill_prompt:
                        load_skill_tool.preload_skill_prompt(
                            skill_name, skill_config, is_user_selected=is_user_selected
                        )
                        logger.info(
                            "[skill_factory] Preloaded skill prompt for '%s' "
                            "(in preload_skills list, user_selected=%s)",
                            skill_name,
                            is_user_selected,
                        )
            else:
                logger.debug(
                    "[skill_factory] Skill '%s' tools registered but not immediately available "
                    "(will be available after load_skill is called)",
                    skill_name,
                )

        logger.info(
            "[skill_factory_perf] skill=%s total=%.2fms active=%s "
            "tool_declarations=%d mcp_servers=%d",
            skill_name,
            (time.perf_counter() - skill_start) * 1000,
            should_activate,
            len(tool_declarations or []),
            len(mcp_servers or {}),
        )

    # Load MCP tools from all skills if any MCP servers are configured
    if skill_mcp_configs:
        mcp_load_start = time.perf_counter()
        mcp_tools_with_server, skill_mcp_clients = await _load_skill_mcp_tools(
            skill_mcp_configs, task_id, task_data
        )
        mcp_clients.extend(skill_mcp_clients)
        logger.info(
            "[skill_factory_perf] active_skill_mcp_load=%.2fms server_count=%d",
            (time.perf_counter() - mcp_load_start) * 1000,
            len(skill_mcp_configs),
        )

        # Calculate total tools count
        total_mcp_tools = sum(len(tools) for tools in mcp_tools_with_server.values())

        logger.info(
            "[skill_factory] Loaded %d MCP tools from %d servers",
            total_mcp_tools,
            len(mcp_tools_with_server),
        )

        # Register MCP tools under their owning skills so they are only exposed
        # after the corresponding skill is loaded.
        if load_skill_tool is not None and mcp_tools_with_server:

            def _dedupe_by_tool_name(items: list[Any]) -> list[Any]:
                merged: list[Any] = []
                seen: set[str] = set()
                for item in items:
                    name = getattr(item, "name", None)
                    if isinstance(name, str) and name:
                        if name in seen:
                            continue
                        seen.add(name)
                    merged.append(item)
                return merged

            unassigned: list[Any] = []
            tools_by_skill: dict[str, list[Any]] = {}

            # Process tools by server - since server names are prefixed with skill name,
            # we can directly map them to skills
            for server_name, server_tools in mcp_tools_with_server.items():
                # server_name format: "{skill_name}_{original_server_name}"
                owner_skill = skill_mcp_server_owner.get(server_name)

                if owner_skill:
                    tools_by_skill.setdefault(owner_skill, []).extend(server_tools)
                    logger.debug(
                        "[skill_factory] Mapped %d tools from server '%s' to skill '%s'",
                        len(server_tools),
                        server_name,
                        owner_skill,
                    )
                else:
                    # This shouldn't happen since we control the server naming
                    logger.warning(
                        "[skill_factory] Server '%s' not found in skill_mcp_server_owner mapping",
                        server_name,
                    )
                    unassigned.extend(server_tools)

            for skill_name, skill_tools in tools_by_skill.items():
                existing = load_skill_tool.get_skill_tools(skill_name)
                merged_tools = _dedupe_by_tool_name(list(existing) + skill_tools)
                load_skill_tool.register_skill_tools(skill_name, merged_tools)
                logger.info(
                    "[skill_factory] Registered %d MCP tool(s) for skill '%s'",
                    len(skill_tools),
                    skill_name,
                )

            if unassigned:
                logger.warning(
                    "[skill_factory] %d MCP tool(s) could not be assigned to a skill; "
                    "they will not be skill-gated. tool_names=%s",
                    len(unassigned),
                    [getattr(t, "name", "unknown") for t in unassigned],
                )
                # Fallback: expose unassigned tools directly so functionality isn't lost.
                tools.extend(unassigned)
        elif load_skill_tool is None and mcp_tools_with_server:
            # Without LoadSkillTool we can't apply skill gating; keep previous behavior
            # and expose MCP tools directly.
            for server_tools in mcp_tools_with_server.values():
                tools.extend(server_tools)

    # Log summary of all skills loaded
    if tools:
        tool_names = [t.name for t in tools]
        logger.info(
            "[skill_factory] Loaded %d skill tools (including MCP): %s",
            len(tools),
            tool_names,
        )

    logger.info(
        "[skill_factory_perf] prepare_skill_tools total=%.2fms skill_count=%d "
        "active_skill_count=%d loaded_mcp_server_count=%d immediate_tool_count=%d",
        (time.perf_counter() - function_start) * 1000,
        len(skill_configs),
        len(active_skill_set),
        len(skill_mcp_configs),
        len(tools),
    )

    return tools, mcp_clients


async def _load_skill_mcp_tools(
    mcp_configs: dict[str, dict[str, Any]],
    task_id: int,
    task_data: Optional[ExecutionRequest] = None,
) -> tuple[dict[str, list[Any]], list[Any]]:
    """
    Load MCP tools from skill-level MCP server configurations.

    This function connects to MCP servers specified in skill configurations
    and returns the tools provided by those servers organized by server name.

    Args:
        mcp_configs: Merged MCP server configurations from all skills
        task_id: Task ID for logging
        task_data: Optional task data for variable substitution

    Returns:
        Tuple of (mcp_tools_with_server, mcp_clients) where:
        - mcp_tools_with_server: Dict mapping server_name to list of tools
        - mcp_clients: List of MCPClient instances
    """
    from chat_shell.tools.mcp import MCPClient

    if not mcp_configs:
        return {}, []

    logger.info(
        "[skill_factory] Loading MCP tools from %d skill MCP server(s): %s",
        len(mcp_configs),
        list(mcp_configs.keys()),
    )
    load_start = time.perf_counter()

    mcp_tools_with_server: dict[str, list[Any]] = {}
    mcp_clients: list[Any] = []
    client: Any = None

    try:
        # Create MCPClient with all skill MCP servers
        client = MCPClient(mcp_configs, task_data=task_data)

        try:
            await asyncio.wait_for(client.connect(), timeout=30.0)
            if client.is_connected:
                # Get tools organized by server name
                mcp_tools_with_server = client.get_tools_with_server()
                mcp_clients.append(client)

                # Calculate total tools count for logging
                total_tools = sum(
                    len(tools) for tools in mcp_tools_with_server.values()
                )
                logger.info(
                    "[skill_factory] Loaded %d MCP tools from %d skill servers for task %d "
                    "in %.2fms",
                    total_tools,
                    len(mcp_tools_with_server),
                    task_id,
                    (time.perf_counter() - load_start) * 1000,
                )

                # Log tool count per server
                for server_name, tools in mcp_tools_with_server.items():
                    logger.debug(
                        "[skill_factory] Server '%s': %d tools",
                        server_name,
                        len(tools),
                    )
            else:
                # Connection succeeded but client not ready, clean up
                logger.warning(
                    "[skill_factory] Failed to connect to skill MCP servers for task %d",
                    task_id,
                )
                await _safe_disconnect_client(client, task_id)
        except asyncio.TimeoutError:
            logger.error(
                "[skill_factory] Timeout connecting to skill MCP servers for task %d",
                task_id,
            )
            await _safe_disconnect_client(client, task_id)
        except Exception as e:
            logger.error(
                "[skill_factory] Failed to connect to skill MCP servers for task %d: %s",
                task_id,
                str(e),
            )
            await _safe_disconnect_client(client, task_id)

    except Exception:
        logger.exception(
            "[skill_factory] Unexpected error loading skill MCP tools for task %d",
            task_id,
        )
        # Clean up client if it was created before the exception
        if client is not None:
            await _safe_disconnect_client(client, task_id)

    return mcp_tools_with_server, mcp_clients


async def _safe_disconnect_client(client: Any, task_id: int) -> None:
    """
    Safely disconnect an MCP client, handling any exceptions.

    Args:
        client: The MCPClient instance to disconnect
        task_id: Task ID for logging
    """
    try:
        await client.disconnect()
        logger.debug(
            "[skill_factory] Disconnected MCP client for task %d after failure",
            task_id,
        )
    except Exception as e:
        logger.warning(
            "[skill_factory] Error disconnecting MCP client for task %d: %s",
            task_id,
            str(e),
        )
