# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for in-conversation connector authorization guidance."""

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import connector_app_service
from app.services.connector_connections import connector_connection_service
from app.services.execution import connector_guidance
from app.services.execution.provider_guidance import (
    GUIDANCE_START,
    apply_execution_guidance,
)
from shared.models import ExecutionRequest


def _create_app(
    db: Session,
    admin: User,
    *,
    slug: str,
    auth_type: str = "oauth2",
    mcp_url: str | None = None,
    tool_loading_mode: str = "static",
    keywords: list[str] | None = None,
):
    return connector_app_service.create_app(
        db,
        ConnectorAppWrite(
            slug=slug,
            name=f"{slug} app",
            transport="streamable-http",
            mcp_url=mcp_url or f"https://mcp.example.test/{slug}",
            auth_type=auth_type,
            tool_loading_mode=tool_loading_mode,
            keywords=keywords or [],
        ),
        admin,
    )


def _connect(db: Session, slug: str, user_id: int) -> None:
    connector_connection_service.save_oauth_connection(
        db,
        slug=slug,
        user_id=user_id,
        access_token="token",
        refresh_token=None,
        token_type="bearer",
        granted_scopes=[],
        external_account_name=None,
        expires_at=None,
    )


def test_pending_apps_include_unauthorized_oauth_apps(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="pending-app")
    _create_app(test_db, test_admin_user, slug="connected-app")
    _create_app(test_db, test_admin_user, slug="no-auth-app", auth_type="none")
    _connect(test_db, "connected-app", test_user.id)

    available, pending = connector_guidance.connector_apps_by_state(test_db, test_user)

    assert [app.slug for app in pending] == ["pending-app"]
    assert sorted(app.slug for app in available) == ["connected-app", "no-auth-app"]


def test_guidance_links_open_the_authorization_dialog(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="pending-app")

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="pending-app app"
    )

    assert "wegent://modal/connector-oauth?slug=pending-app" in section
    assert "pending-app app" in section
    assert "Authorized and ready" not in section


def test_guidance_is_skipped_when_every_app_is_connected(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="connected-app")
    _connect(test_db, "connected-app", test_user.id)

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="connected-app app"
    )

    assert section == ""


def test_lazy_apps_stay_out_of_the_global_guidance(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="lazy-app",
        auth_type="none",
        tool_loading_mode="lazy",
    )

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="lazy-app app"
    )

    assert section == ""


def test_connector_guidance_travels_with_the_user_turn(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    """Resumed sessions keep their first system prompt, so guide per turn."""
    _create_app(test_db, test_admin_user, slug="pending-app")
    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="pending-app app"
    )
    request = ExecutionRequest(
        task_id=1,
        prompt="please inspect it",
        system_prompt="Base instructions",
        bot=[{"shell_type": "Chat", "system_prompt": "Bot instructions"}],
    )

    request.prompt = connector_guidance.append_turn_guidance(request.prompt, section)
    apply_execution_guidance(
        request, ["## Provider configuration required\nprovider-link"]
    )

    assert request.system_prompt.startswith("Base instructions")
    assert request.system_prompt.count(GUIDANCE_START) == 1
    assert "provider-link" in request.system_prompt
    assert "connector-oauth" not in request.system_prompt
    assert "provider-link" in request.bot[0]["system_prompt"]
    assert request.prompt.startswith("please inspect it")
    assert request.prompt.count(connector_guidance.TURN_GUIDANCE_START) == 1
    assert "wegent://modal/connector-oauth?slug=pending-app" in request.prompt


def test_turn_guidance_replaces_the_previous_block() -> None:
    """A retried or replayed prompt must not accumulate authorization lists."""
    first = connector_guidance.append_turn_guidance("please inspect it", "first")
    second = connector_guidance.append_turn_guidance(first, "second")

    assert second.startswith("please inspect it")
    assert "second" in second
    assert "first" not in second
    assert second.count(connector_guidance.TURN_GUIDANCE_START) == 1


def test_turn_guidance_appends_to_a_vision_prompt() -> None:
    """Image turns keep their content blocks and gain a text block."""
    prompt = [
        {"type": "input_text", "text": "look at this"},
        {"type": "input_image", "image_url": "data:image/png;base64,AA"},
    ]

    updated = connector_guidance.append_turn_guidance(prompt, "authorize me")

    assert updated[0]["text"].startswith("look at this")
    assert "authorize me" in updated[0]["text"]
    assert updated[0]["text"].endswith(connector_guidance.TURN_GUIDANCE_END)
    assert updated[1] == prompt[1]
    assert len(updated) == 2


def test_static_pending_apps_are_listed_without_mention(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(test_db, test_admin_user, slug="pending-app")
    _create_app(test_db, test_admin_user, slug="other-app")

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="帮我写一份周报"
    )

    assert "wegent://modal/connector-oauth?slug=pending-app" in section
    assert "wegent://modal/connector-oauth?slug=other-app" in section


def test_only_the_mentioned_app_gets_a_link(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="pending-app",
        tool_loading_mode="lazy",
    )
    _create_app(
        test_db,
        test_admin_user,
        slug="other-app",
        tool_loading_mode="lazy",
    )

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="用 pending-app 查一下"
    )

    assert "wegent://modal/connector-oauth?slug=pending-app" in section
    assert "other-app" not in section


def test_lazy_pending_app_is_listed_when_keywords_match(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    _create_app(
        test_db,
        test_admin_user,
        slug="lazy-pending",
        tool_loading_mode="lazy",
        keywords=["钉钉 表格", "spreadsheet"],
    )

    matched = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="帮我看下钉钉里的表格"
    )
    unmatched = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="帮我写一份周报"
    )

    assert "wegent://modal/connector-oauth?slug=lazy-pending" in matched
    assert unmatched == ""


def test_apps_sharing_an_endpoint_are_listed_once(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    shared = "https://mcp.example.test/shared"
    _create_app(test_db, test_admin_user, slug="legacy-app", mcp_url=shared)
    _create_app(test_db, test_admin_user, slug="builtin-app", mcp_url=shared)

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="legacy-app 和 builtin-app"
    )

    assert section.count("wegent://modal/connector-oauth") == 1


def test_apps_with_a_personal_url_are_not_prompted_for_oauth(
    test_db: Session, test_admin_user: User, test_user: User
) -> None:
    """Legacy API-key users keep working without a connector authorization."""
    from app.services.user_mcp_service import user_mcp_service

    _create_app(test_db, test_admin_user, slug="dingtalk_docs")
    preferences = user_mcp_service.set_provider_service_config(
        None,
        provider_id="dingtalk",
        service_id="docs",
        enabled=True,
        url="https://mcp-gw.dingtalk.com/server/abc?key=secret",
    )
    test_user.preferences = user_mcp_service.dump_preferences(preferences)

    section = connector_guidance.build_connector_guidance_section(
        test_db, test_user, mention="钉钉文档"
    )

    assert section == ""
