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

from app.services.chat.config.model_resolver import (
    _resolve_model_for_bot,
    allowed_model_names_for_bot,
    allowed_model_names_for_team,
)
from app.services.readers import kindReader


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

    def test_model_not_in_agent_config_bound_model_whitelist_raises(self):
        """A whitelist carried by the agent_config bound model must be enforced."""
        bot = _make_bot({"bind_model": "pointer-model"})

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (
                MagicMock(),
                {"modelConfig": {"allowed_models": [{"name": "gpt-4o"}]}},
            )
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


def _make_team(bot_names: list[str]) -> MagicMock:
    """Create a mock Team Kind object referencing the given bots."""
    team = MagicMock()
    team.user_id = 7
    team.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Team",
        "metadata": {"name": "test-team", "namespace": "default"},
        "spec": {
            "members": [
                {
                    "botRef": {"name": name, "namespace": "default"},
                    "role": "worker",
                }
                for name in bot_names
            ],
            "collaborationModel": "solo",
        },
    }
    return team


class TestAllowedModelNamesForBot:
    """Tests for the shared allowed_models resolution helper."""

    def test_returns_none_without_whitelist(self):
        """A bot without allowed_models does not restrict any model."""
        bot = _make_bot({"bind_model": "gpt-4o"})

        assert allowed_model_names_for_bot(MagicMock(), bot, 1) is None

    def test_returns_names_from_agent_config(self):
        """The bot's own allowed_models whitelist is returned as a name set."""
        bot = _make_bot(
            {
                "bind_model": "gpt-4o",
                "allowed_models": [
                    {"name": "gpt-4o", "type": "public", "namespace": "default"},
                    {"name": "claude-3-5-sonnet", "type": "user"},
                ],
            }
        )

        assert allowed_model_names_for_bot(MagicMock(), bot, 1) == {
            "gpt-4o",
            "claude-3-5-sonnet",
        }

    def test_falls_back_to_bound_model_whitelist(self):
        """A Bot that binds a whitelist-only Model must still restrict models."""
        bot = _make_bot({"bind_model": "pointer-model"})
        bot.json["spec"]["modelRef"] = {
            "name": "pointer-model",
            "namespace": "default",
        }

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (
                MagicMock(),
                {"modelConfig": {"allowed_models": [{"name": "gpt-4o"}]}},
            )
            allowed_names = allowed_model_names_for_bot(MagicMock(), bot, 1)

        assert allowed_names == {"gpt-4o"}

    def test_falls_back_to_agent_config_bound_model_whitelist(self):
        """The agent_config bound model is read before the legacy modelRef."""
        db = MagicMock()
        bot = _make_bot({"bind_model": "pointer-model"})

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (
                MagicMock(),
                {"modelConfig": {"allowed_models": [{"name": "gpt-4o"}]}},
            )
            allowed_names = allowed_model_names_for_bot(db, bot, 1)

        assert allowed_names == {"gpt-4o"}
        mock_find.assert_called_once_with(db, "pointer-model", 1)

    def test_prefers_bind_model_whitelist_over_model_ref(self):
        """The bound model of the bot wins over the legacy modelRef reference."""
        db = MagicMock()
        bot = _make_bot({"bind_model": "bind-model"})
        bot.json["spec"]["modelRef"] = {"name": "legacy-model", "namespace": "default"}

        def _fake_find(_db, model_name, _user_id):
            if model_name == "bind-model":
                return MagicMock(), {
                    "modelConfig": {"allowed_models": [{"name": "bind-model"}]}
                }
            return MagicMock(), {
                "modelConfig": {"allowed_models": [{"name": "legacy-model"}]}
            }

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace",
            side_effect=_fake_find,
        ) as mock_find:
            allowed_names = allowed_model_names_for_bot(db, bot, 1)

        assert allowed_names == {"bind-model"}
        mock_find.assert_called_once_with(db, "bind-model", 1)

    def test_malformed_entries_return_empty_set(self):
        """Malformed whitelist entries keep the restriction but allow nothing."""
        bot = _make_bot({"allowed_models": ["not-a-dict", None]})

        assert allowed_model_names_for_bot(MagicMock(), bot, 1) == set()

    def test_unrestricted_bot_entries_ignored(self):
        """Non-list allowed_models values do not restrict models."""
        bot = _make_bot({"allowed_models": {"name": "gpt-4o"}})

        assert allowed_model_names_for_bot(MagicMock(), bot, 1) is None


class TestAllowedModelNamesForTeam:
    """Tests for team-level model restriction aggregation."""

    def test_returns_none_when_no_bot_restricts_models(self):
        """A team of unrestricted bots allows every model."""
        team = _make_team(["bot-a"])

        with patch.object(
            kindReader,
            "get_by_name_and_namespace",
            return_value=_make_bot({"bind_model": "gpt-4o"}),
        ):
            assert allowed_model_names_for_team(MagicMock(), team, 1) is None

    def test_intersects_bot_whitelists(self):
        """A model override must satisfy every restricted bot of the team."""
        team = _make_team(["bot-a", "bot-b"])
        bots = [
            _make_bot({"allowed_models": [{"name": "gpt-4o"}, {"name": "o3"}]}),
            _make_bot({"allowed_models": [{"name": "gpt-4o"}]}),
        ]

        with patch.object(
            kindReader,
            "get_by_name_and_namespace",
            side_effect=bots,
        ):
            allowed_names = allowed_model_names_for_team(MagicMock(), team, 1)

        assert allowed_names == {"gpt-4o"}

    def test_ignores_team_without_json(self):
        """Teams without parseable JSON metadata cannot be evaluated."""
        team = MagicMock()
        team.json = None

        assert allowed_model_names_for_team(MagicMock(), team, 1) is None
