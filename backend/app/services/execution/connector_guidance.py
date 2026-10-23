# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""In-conversation OAuth guidance for administrator-published connector apps.

Connector apps are published by administrators and authorized per user. When a
visible app still needs the current user's OAuth grant, the agent should tell
the user and offer the authorization dialog link instead of claiming the
capability is available. The link is handled by the Wegent web scheme system.
"""

from __future__ import annotations

import logging
import re
from typing import Union
from urllib.parse import quote

from sqlalchemy.orm import Session

from app.models.user import User
from app.services.connector_apps import ConnectorApp, ConnectorAppService
from app.services.mcp_provider_registry import get_mcp_service_by_connector_slug
from app.services.user_mcp_service import user_mcp_service

logger = logging.getLogger(__name__)

CONNECTOR_OAUTH_MODAL = "wegent://modal/connector-oauth"
# The authorization list depends on the current message (lazy apps are only
# listed when the message mentions them), so it travels with the user turn.
TURN_GUIDANCE_START = "<wegent_connector_apps>"
TURN_GUIDANCE_END = "</wegent_connector_apps>"
TURN_GUIDANCE_BLOCK = re.compile(
    rf"(?:\n\n)?{TURN_GUIDANCE_START}.*?{TURN_GUIDANCE_END}", re.DOTALL
)


def connector_apps_by_state(
    db: Session, user: User
) -> tuple[list[ConnectorApp], list[ConnectorApp]]:
    """Split the user's visible apps into (available, awaiting authorization)."""
    return ConnectorAppService.split_by_availability(db, user)


def pending_authorization_apps(db: Session, user: User) -> list[ConnectorApp]:
    """Return visible apps the user has not authorized yet."""
    return connector_apps_by_state(db, user)[1]


def connector_authorization_link(slug: str) -> str:
    return f"{CONNECTOR_OAUTH_MODAL}?slug={quote(slug)}"


def _matches_mention(app: ConnectorApp, mention: str) -> bool:
    haystack = mention.casefold()
    return app.name.casefold() in haystack or app.slug.casefold() in haystack


def _matches_keywords(app: ConnectorApp, text: str) -> bool:
    haystack = text.casefold()
    for keyword in app.keywords or []:
        terms = [term for term in keyword.casefold().split() if term]
        if terms and all(term in haystack for term in terms):
            return True
    return False


def _has_personal_mcp_config(user: User, app: ConnectorApp) -> bool:
    """Whether the user still holds the legacy personal URL for this app.

    Those configurations (API key Streamable HTTP URLs) keep working through
    the provider Skill, so prompting for connector OAuth would be wrong.
    """
    runtime = get_mcp_service_by_connector_slug(app.slug)
    if runtime is None:
        return False
    provider, service = runtime
    configured = user_mcp_service.get_enabled_mcp_server(
        getattr(user, "preferences", None),
        provider["provider_id"],
        service["service_id"],
    )
    return configured is not None


def _dedupe_by_endpoint(apps: list[ConnectorApp]) -> list[ConnectorApp]:
    """Keep one entry per upstream URL.

    A deployment can hold several apps pointing at the same MCP server (for
    example a built-in DingTalk app and a hand-created one). Listing every copy
    would ask the user to authorize the same service twice.
    """
    seen: set[str] = set()
    unique: list[ConnectorApp] = []
    for app in apps:
        key = (app.mcp_url or app.slug).rstrip("/").casefold()
        if key in seen:
            continue
        seen.add(key)
        unique.append(app)
    return unique


def build_connector_authorization_prompt(
    pending: list[ConnectorApp],
) -> str:
    """Render authorization guidance only for apps relevant to this turn."""
    pending = _dedupe_by_endpoint(pending)
    lines = ["## Connector apps"]
    lines.extend(
        [
            "",
            "These apps require OAuth authorization before their tools are available:",
            "",
        ]
    )
    for app in pending:
        link = connector_authorization_link(app.slug)
        lines.append(f"- {app.name} (`{app.slug}`): [打开 {app.name} 授权]({link})")
    lines.extend(
        [
            "",
            "Rules:",
            "- Do not claim you can read or change data in these apps before the user authorizes them.",
            "- When the request needs one of them, say briefly that it needs authorization and repeat its link above.",
            "- If a connector tool is missing, returns `connector_auth_required`, or cannot run, you MUST include that app's authorization link above and must not describe it as a temporary network or session problem.",
            "- Never print the raw link target; always render it as the markdown link shown above.",
            "- After the user authorizes, continue the original task.",
        ]
    )
    return "\n".join(lines)


def build_connector_guidance_section(
    db: Session, user: User, *, mention: str = ""
) -> str:
    """Return the guidance section for the user's connector apps."""
    try:
        _, pending = connector_apps_by_state(db, user)
    except Exception:  # Guidance must never block task execution.
        logger.exception(
            "[ConnectorGuidance] failed to resolve apps user_id=%s", user.id
        )
        return ""
    # Static apps are expected to be directly available, so a pending static
    # app always warrants an authorization hint. Lazy apps are only surfaced
    # when the current message explicitly mentions or matches one of them.
    selected = [
        app
        for app in pending
        if not _has_personal_mcp_config(user, app)
        and (
            app.tool_loading_mode == "static"
            or _matches_mention(app, mention)
            or _matches_keywords(app, mention)
        )
    ]
    if not selected:
        return ""
    logger.info(
        "[ConnectorGuidance] user_id=%s pending=%s",
        user.id,
        [app.slug for app in selected],
    )
    return build_connector_authorization_prompt(selected)


def append_turn_guidance(prompt: Union[str, list], section: str) -> Union[str, list]:
    """Attach the authorization list to the current user message.

    Resumed agent sessions keep the system prompt they started with (Claude Code
    ``--resume`` and Codex threads both do), so turn-scoped guidance that depends
    on this message must travel with the message instead.
    """
    block = f"{TURN_GUIDANCE_START}\n{section.strip()}\n{TURN_GUIDANCE_END}"
    if isinstance(prompt, str):
        cleaned = TURN_GUIDANCE_BLOCK.sub("", prompt).rstrip()
        return "\n\n".join(part for part in (cleaned, block) if part)
    if not isinstance(prompt, list):
        return prompt

    cleaned: list = []
    for item in prompt:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            cleaned.append({**item, "text": TURN_GUIDANCE_BLOCK.sub("", item["text"])})
        else:
            cleaned.append(item)
    # Reuse the vision-prompt shape the executors already understand.
    for index, item in enumerate(cleaned):
        if isinstance(item, dict) and item.get("type") == "input_text":
            cleaned[index] = {**item, "text": f"{item['text'].rstrip()}\n\n{block}"}
            return cleaned
    cleaned.append({"type": "input_text", "text": block})
    return cleaned
