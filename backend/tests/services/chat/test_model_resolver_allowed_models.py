# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for allowed_models whitelist validation in _resolve_model_for_bot().

Tests cover:
- No allowed_models configured (allow all models)
- Empty allowed_models list (allow all models)
- Model in whitelist (pass)
- Model not in whitelist (raise ValueError)
- Whitelist only applies when override_model_name is used
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.chat.config.model_resolver import _resolve_model_for_bot


def _make_bot(agent_config: dict) -> MagicMock:
    """Create a mock Bot Kind object with the given agent_config."""
    bot = MagicMock()
    bot.name = "test-bot"
    bot.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": "test-bot", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "test-ghost", "namespace": "default"},
            "shellRef": {"name": "test-shell", "namespace": "default"},
            "agent_config": agent_config,
        },
    }
    return bot


def _make_db_with_model(model_name: str) -> MagicMock:
    """Create a mock DB session that returns a model Kind for the given name."""
    model_kind = MagicMock()
    model_kind.name = model_name
    model_kind.namespace = "default"
    model_kind.json = {
        "spec": {
            "modelConfig": {
                "env": {
                    "model": "openai",
                    "model_id": model_name,
                    "api_key": "sk-test",
                    "base_url": "https://api.openai.com/v1",
                }
            }
        }
    }

    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = model_kind
    return db


class TestAllowedModelsNoRestriction:
    """Tests for cases where allowed_models is absent or empty (no restriction)."""

    def test_no_allowed_models_key_allows_any_override(self):
        """When allowed_models is not set, any override model should be accepted."""
        agent_config = {
            "bind_model": "gpt-4o",
            "bind_model_type": "public",
            "bind_model_namespace": "default",
        }
        bot = _make_bot(agent_config)
        db = _make_db_with_model("claude-3-5-sonnet")

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=db,
                bot=bot,
                user_id=1,
                override_model_name="claude-3-5-sonnet",
                force_override=True,
            )

        assert model_name == "claude-3-5-sonnet"

    def test_empty_allowed_models_list_allows_any_override(self):
        """When allowed_models is an empty list, any override model should be accepted."""
        agent_config = {
            "bind_model": "gpt-4o",
            "bind_model_type": "public",
            "bind_model_namespace": "default",
            "allowed_models": [],
        }
        bot = _make_bot(agent_config)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="any-model",
                force_override=True,
            )

        assert model_name == "any-model"

    def test_null_allowed_models_allows_any_override(self):
        """When allowed_models is None, any override model should be accepted."""
        agent_config = {
            "bind_model": "gpt-4o",
            "allowed_models": None,
        }
        bot = _make_bot(agent_config)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="any-model",
                force_override=True,
            )

        assert model_name == "any-model"


class TestAllowedModelsWithWhitelist:
    """Tests for cases where allowed_models contains a non-empty whitelist."""

    def _make_agent_config_with_whitelist(self) -> dict:
        return {
            "bind_model": "gpt-4o",
            "bind_model_type": "public",
            "bind_model_namespace": "default",
            "allowed_models": [
                {"name": "gpt-4o", "type": "public", "namespace": "default"},
                {"name": "claude-3-5-sonnet", "type": "user", "namespace": "default"},
                {"name": "my-model", "type": "group", "namespace": "my-group"},
            ],
        }

    def test_model_in_whitelist_passes(self):
        """When override model is in the whitelist, it should be accepted."""
        bot = _make_bot(self._make_agent_config_with_whitelist())

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="claude-3-5-sonnet",
                force_override=True,
            )

        assert model_name == "claude-3-5-sonnet"

    def test_bind_model_in_whitelist_passes(self):
        """When override model is the bind_model itself and in whitelist, it should pass."""
        bot = _make_bot(self._make_agent_config_with_whitelist())

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="gpt-4o",
                force_override=True,
            )

        assert model_name == "gpt-4o"

    def test_group_model_in_whitelist_passes(self):
        """When override model is a group model in the whitelist, it should pass."""
        bot = _make_bot(self._make_agent_config_with_whitelist())

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="my-model",
                force_override=True,
            )

        assert model_name == "my-model"

    def test_model_not_in_whitelist_raises_value_error(self):
        """When override model is NOT in the whitelist, ValueError should be raised."""
        bot = _make_bot(self._make_agent_config_with_whitelist())

        with pytest.raises(ValueError) as exc_info:
            _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="forbidden-model",
                force_override=True,
            )

        assert "forbidden-model" in str(exc_info.value)
        assert "test-bot" in str(exc_info.value)
        assert "allowed models" in str(exc_info.value)

    def test_model_not_in_whitelist_without_force_override_raises(self):
        """Whitelist check also applies when override_model_name is used as fallback."""
        agent_config = {
            # No bind_model set, so override_model_name will be used as fallback
            "allowed_models": [
                {"name": "gpt-4o", "type": "public", "namespace": "default"},
            ],
        }
        bot = _make_bot(agent_config)

        with pytest.raises(ValueError) as exc_info:
            _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="not-allowed-model",
                force_override=False,
            )

        assert "not-allowed-model" in str(exc_info.value)

    def test_no_override_model_skips_whitelist_check(self):
        """When no override_model_name is provided, whitelist check is skipped."""
        agent_config = {
            "bind_model": "gpt-4o",
            "bind_model_type": "public",
            "bind_model_namespace": "default",
            "allowed_models": [
                {"name": "claude-3-5-sonnet", "type": "user", "namespace": "default"},
            ],
        }
        bot = _make_bot(agent_config)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            # No override_model_name - should use bind_model (gpt-4o) without whitelist check
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name=None,
                force_override=False,
            )

        # bind_model is used, no whitelist check since no override was requested
        assert model_name == "gpt-4o"

    def test_whitelist_with_malformed_entries_is_robust(self):
        """Malformed entries in allowed_models (non-dict) should be safely ignored."""
        agent_config = {
            "bind_model": "gpt-4o",
            "allowed_models": [
                "not-a-dict",  # malformed entry
                None,  # malformed entry
                {"name": "gpt-4o", "type": "public", "namespace": "default"},
            ],
        }
        bot = _make_bot(agent_config)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (MagicMock(), {"modelConfig": {}})
            model_kind, model_spec, model_name, raw_config = _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="gpt-4o",
                force_override=True,
            )

        assert model_name == "gpt-4o"

    def test_whitelist_with_only_malformed_entries_blocks_all(self):
        """If all entries are malformed, allowed_names is empty, so any model is blocked."""
        agent_config = {
            "bind_model": "gpt-4o",
            "allowed_models": [
                "not-a-dict",
                None,
            ],
        }
        bot = _make_bot(agent_config)

        with pytest.raises(ValueError):
            _resolve_model_for_bot(
                db=MagicMock(),
                bot=bot,
                user_id=1,
                override_model_name="gpt-4o",
                force_override=True,
            )
