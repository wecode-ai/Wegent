# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.services.chat.config.model_resolver import get_model_config_for_bot
from app.services.user_runtime_config import user_runtime_config_service


def _create_codex_bot(test_db: Session, user: User) -> Kind:
    bot = Kind(
        user_id=user.id,
        kind="Bot",
        name="codex-bot",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "codex-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "ghost", "namespace": "default"},
                "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(bot)
    test_db.commit()
    test_db.refresh(bot)
    return bot


def test_resolves_runtime_codex_model_when_user_auth_enabled(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    """Execution should resolve the Wework-only Codex model without a Model CRD."""
    monkeypatch.setattr(
        "app.services.chat.config.model_resolver.settings.EXECUTOR_ENV", ""
    )
    monkeypatch.delenv("EXECUTOR_ENV", raising=False)
    monkeypatch.delenv("DEFAULT_HEADERS", raising=False)
    user_runtime_config_service.save_auth_json(
        test_db,
        user_id=test_user.id,
        runtime="codex",
        auth_json='{"token":"secret"}',
    )
    user_runtime_config_service.set_use_user_config(
        test_db,
        user=test_user,
        runtime="codex",
        use_user_config=True,
    )
    test_db.refresh(test_user)
    bot = _create_codex_bot(test_db, test_user)

    config = get_model_config_for_bot(
        test_db,
        bot,
        test_user.id,
        override_model_name="codex-gpt-5.5",
        force_override=True,
    )

    assert config == {
        "api_key": "",
        "base_url": "https://api.openai.com/v1",
        "model_id": "gpt-5.5",
        "model": "openai",
        "default_headers": {},
        "api_format": "responses",
        "protocol": "openai-responses",
        "context_window": None,
        "max_output_tokens": None,
        "modelType": "llm",
        "videoConfig": None,
        "think_config": None,
        "supports_developer_role": None,
        "temperature": None,
        "model_name": "codex-gpt-5.5",
        "model_namespace": "default",
    }
