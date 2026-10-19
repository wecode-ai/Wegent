# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.models.user import User
from app.services import model_credential_service as credentials


@pytest.fixture(autouse=True)
def isolate_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(credentials, "_model_api_key_resolver", None)


@pytest.fixture
def user() -> User:
    return User(id=101, user_name="request-user", is_active=True)


@pytest.mark.parametrize("key", ["provider-key", "  provider-key  ", "", None])
async def test_default_preserves_literal_and_anonymous_credentials(
    user: User, key
) -> None:
    assert await credentials.resolve_model_provider_api_key({"api_key": key}, user) == (
        key.strip() if isinstance(key, str) else ""
    )


@pytest.mark.parametrize("key", ["", None, "${UNRESOLVED_KEY}", "key\r\ninjected"])
async def test_required_credentials_fail_closed(user: User, key) -> None:
    with pytest.raises(credentials.ModelCredentialError):
        await credentials.resolve_model_provider_api_key(
            {"api_key": key}, user, require_api_key=True
        )


def test_original_template_is_preserved_without_mutating_config() -> None:
    config = {"api_key": "global-key"}
    spec = {"modelConfig": {"env": {"api_key": "${USER_SCOPED_MODEL_KEY}"}}}
    resolved = credentials.with_model_api_key_template(config, spec)
    assert resolved["_api_key_template"] == "${USER_SCOPED_MODEL_KEY}"
    assert config == {"api_key": "global-key"}
    assert spec["modelConfig"]["env"]["api_key"] == "${USER_SCOPED_MODEL_KEY}"


async def test_extension_overrides_processed_environment_value_for_each_user(
    user: User,
) -> None:
    other = User(id=102, user_name="other-user", is_active=True)
    template = "${USER_SCOPED_MODEL_KEY}"
    config = {"api_key": "global-key", "_api_key_template": template}

    async def lookup(raw_template: str, caller: User) -> str:
        assert raw_template == template
        await asyncio.sleep(0)
        return f"synthetic-key-{caller.id}"

    resolver = AsyncMock(side_effect=lookup)
    credentials.register_model_api_key_resolver(resolver)
    first, second = await asyncio.gather(
        credentials.resolve_model_provider_api_key(config, user),
        credentials.resolve_model_provider_api_key(config, other),
    )
    assert (first, second) == ("synthetic-key-101", "synthetic-key-102")
    assert config["api_key"] == "global-key"
    assert resolver.await_count == 2
    assert {call.args[1].id for call in resolver.await_args_list} == {101, 102}


async def test_unhandled_templates_keep_core_resolution(user: User) -> None:
    resolver = AsyncMock(return_value=None)
    credentials.register_model_api_key_resolver(resolver)
    config = {
        "api_key": "resolved-server-key",
        "_api_key_template": "${SERVER_MODEL_KEY}",
    }
    assert (
        await credentials.resolve_model_provider_api_key(config, user)
        == "resolved-server-key"
    )
    resolver.assert_awaited_once_with("${SERVER_MODEL_KEY}", user)


@pytest.mark.parametrize(
    "result", ["", "  ", 123, "${UNRESOLVED_KEY}", "key\r\ninjected"]
)
async def test_claimed_templates_never_fall_back_to_global_key(
    user: User, result
) -> None:
    credentials.register_model_api_key_resolver(AsyncMock(return_value=result))
    with pytest.raises(credentials.ModelCredentialError):
        await credentials.resolve_model_provider_api_key(
            {"api_key": "global-key", "_api_key_template": "${USER_SCOPED_MODEL_KEY}"},
            user,
        )


async def test_resolver_errors_are_sanitized(user: User, caplog) -> None:
    credentials.register_model_api_key_resolver(
        AsyncMock(side_effect=RuntimeError("private-provider-key"))
    )
    with pytest.raises(credentials.ModelCredentialError) as error:
        await credentials.resolve_model_provider_api_key(
            {"api_key": "global-key"}, user
        )
    assert str(error.value) == "Model credentials unavailable"
    assert "private-provider-key" not in caplog.text
    assert error.value.__suppress_context__ is True


async def test_timeout_cancels_resolution_without_fallback(
    user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    cancelled = asyncio.Event()

    async def lookup(template: str, caller: User) -> str:
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    credentials.register_model_api_key_resolver(lookup)
    monkeypatch.setattr(credentials, "MODEL_API_KEY_RESOLUTION_TIMEOUT", 0.01)
    with pytest.raises(credentials.ModelCredentialError):
        await credentials.resolve_model_provider_api_key(
            {"api_key": "global-key"}, user
        )
    assert cancelled.is_set()


async def test_registration_can_restore_default_behavior(user: User) -> None:
    credentials.register_model_api_key_resolver(AsyncMock(return_value="user-key"))
    assert (
        await credentials.resolve_model_provider_api_key(
            {"api_key": "static-key"}, user
        )
        == "user-key"
    )
    credentials.register_model_api_key_resolver(None)
    assert (
        await credentials.resolve_model_provider_api_key(
            {"api_key": "static-key"}, user
        )
        == "static-key"
    )
