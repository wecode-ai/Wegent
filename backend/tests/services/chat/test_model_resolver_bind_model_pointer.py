# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for bind_model pointer resolution in model_resolver.py.

Covers the "Not logged in" root cause: a Bot's modelRef points at a private
Model whose modelConfig only carries {"bind_model": ..., "allowed_models": [...]}
(no "env" section) - the real provider config lives on the Model named by
bind_model. Without following that pointer, _extract_model_config used to
silently fall back to placeholder defaults (gpt-4 / openai / empty api_key)
instead of raising, producing an authentication failure deep inside the
executor container.
"""

from unittest.mock import MagicMock, patch

import pytest

from app.services.chat.config.model_resolver import (
    _extract_model_config,
    _resolve_bind_model_pointer,
    _resolve_model_for_bot,
    get_model_config_for_bot,
)

_DECRYPT_PATCH = patch(
    "app.services.chat.config.model_resolver.decrypt_api_key",
    side_effect=lambda k: k,
)


def _model_kind(name: str, spec: dict) -> MagicMock:
    kind = MagicMock()
    kind.name = name
    kind.namespace = "default"
    kind.json = {"spec": spec}
    return kind


def _make_bot(model_ref_name: str = "leader-editor-model") -> MagicMock:
    bot = MagicMock()
    bot.name = "leader-editor"
    bot.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": "leader-editor", "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "ghost", "namespace": "default"},
            "shellRef": {"name": "ClaudeCode", "namespace": "default"},
            "modelRef": {"name": model_ref_name, "namespace": "default"},
        },
    }
    return bot


class TestResolveBindModelPointer:
    """Unit tests for _resolve_bind_model_pointer."""

    def test_model_with_env_returns_unchanged(self):
        """A Model that already has env is returned as-is, no DB lookup."""
        spec = {"modelConfig": {"env": {"api_key": "sk-test"}}}
        kind = _model_kind("direct-model", spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            result_kind, result_spec = _resolve_bind_model_pointer(
                db=MagicMock(), user_id=1, model_kind=kind, model_spec=spec
            )

        mock_find.assert_not_called()
        assert result_kind is kind
        assert result_spec is spec

    def test_empty_model_config_returns_unchanged(self):
        """No env and no bind_model (Pattern B) - nothing to follow, returned as-is."""
        spec = {"modelConfig": {}, "isCustomConfig": True}
        kind = _model_kind("empty-model", spec)

        result_kind, result_spec = _resolve_bind_model_pointer(
            db=MagicMock(), user_id=1, model_kind=kind, model_spec=spec
        )

        assert result_kind is kind
        assert result_spec is spec

    def test_none_model_spec_returns_none(self):
        """When the starting model was never found, pass through unchanged."""
        result_kind, result_spec = _resolve_bind_model_pointer(
            db=MagicMock(), user_id=1, model_kind=None, model_spec=None
        )

        assert result_kind is None
        assert result_spec is None

    def test_follows_bind_model_pointer_to_target_with_env(self):
        """A pointer wrapper Model resolves to the target Model's real env."""
        pointer_spec = {
            "modelConfig": {
                "bind_model": "wecode-claude-weibo",
                "bind_model_type": "public",
                "allowed_models": [{"name": "wecode-claude-weibo"}],
            },
            "isCustomConfig": True,
        }
        pointer_kind = _model_kind("leader-editor-model", pointer_spec)

        target_spec = {
            "modelConfig": {
                "env": {
                    "model": "claude",
                    "model_id": "claude-3-5-sonnet",
                    "api_key": "sk-real-key",
                    "base_url": "https://api.anthropic.com",
                }
            }
        }
        target_kind = _model_kind("wecode-claude-weibo", target_spec)
        db = MagicMock()

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (target_kind, target_spec)
            result_kind, result_spec = _resolve_bind_model_pointer(
                db=db,
                user_id=1,
                model_kind=pointer_kind,
                model_spec=pointer_spec,
            )

        mock_find.assert_called_once_with(db, "wecode-claude-weibo", 1)
        assert result_kind is target_kind
        assert result_spec is target_spec

    def test_multi_hop_pointer_chain_resolves(self):
        """A -> B -> C where only C has env should resolve all the way to C."""
        spec_a = {"modelConfig": {"bind_model": "model-b"}}
        spec_b = {"modelConfig": {"bind_model": "model-c"}}
        spec_c = {"modelConfig": {"env": {"api_key": "sk-c"}}}
        kind_a = _model_kind("model-a", spec_a)
        kind_b = _model_kind("model-b", spec_b)
        kind_c = _model_kind("model-c", spec_c)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [(kind_b, spec_b), (kind_c, spec_c)]
            result_kind, result_spec = _resolve_bind_model_pointer(
                db=MagicMock(), user_id=1, model_kind=kind_a, model_spec=spec_a
            )

        assert result_kind is kind_c
        assert result_spec is spec_c
        assert mock_find.call_count == 2

    def test_pointer_target_not_found_raises(self):
        """If bind_model names a Model that no longer exists, raise loudly."""
        pointer_spec = {"modelConfig": {"bind_model": "missing-model"}}
        pointer_kind = _model_kind("leader-editor-model", pointer_spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (None, None)
            with pytest.raises(ValueError) as exc_info:
                _resolve_bind_model_pointer(
                    db=MagicMock(),
                    user_id=1,
                    model_kind=pointer_kind,
                    model_spec=pointer_spec,
                )

        assert "missing-model" in str(exc_info.value)
        assert "leader-editor-model" in str(exc_info.value)

    def test_cyclic_pointer_chain_raises(self):
        """A -> B -> A should be detected and raise instead of looping forever."""
        spec_a = {"modelConfig": {"bind_model": "model-b"}}
        spec_b = {"modelConfig": {"bind_model": "model-a"}}
        kind_a = _model_kind("model-a", spec_a)
        kind_b = _model_kind("model-b", spec_b)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [(kind_b, spec_b), (kind_a, spec_a)]
            with pytest.raises(ValueError):
                _resolve_bind_model_pointer(
                    db=MagicMock(), user_id=1, model_kind=kind_a, model_spec=spec_a
                )

    def test_pointer_chain_too_deep_raises(self):
        """A chain longer than the max depth should raise rather than loop forever."""
        specs = [{"modelConfig": {"bind_model": f"model-{i + 1}"}} for i in range(10)]
        kinds = [_model_kind(f"model-{i}", specs[i]) for i in range(10)]

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [(kinds[i], specs[i]) for i in range(1, 10)]
            with pytest.raises(ValueError):
                _resolve_bind_model_pointer(
                    db=MagicMock(), user_id=1, model_kind=kinds[0], model_spec=specs[0]
                )


class TestExtractModelConfigExplicitErrors:
    """_extract_model_config must raise instead of silently defaulting."""

    @_DECRYPT_PATCH
    def test_valid_env_still_extracts_normally(self, _decrypt):
        spec = {
            "modelConfig": {
                "env": {
                    "api_key": "sk-test",
                    "base_url": "https://api.example.com/v1",
                    "model_id": "claude-3-5-sonnet",
                    "model": "claude",
                }
            }
        }
        result = _extract_model_config(spec)
        assert result["api_key"] == "sk-test"
        assert result["model_id"] == "claude-3-5-sonnet"
        assert result["model"] == "claude"

    @_DECRYPT_PATCH
    def test_legacy_model_capabilities_are_normalized(self, _decrypt):
        spec = {
            "modelConfig": {
                "env": {
                    "api_key": "sk-test",
                    "model_id": "gemini-test",
                    "model": "gemini",
                },
                "modelCapabilities": {
                    "supportsImage": True,
                    "supportsVideo": True,
                },
            }
        }

        result = _extract_model_config(spec)

        assert result["modelCapabilities"] == {
            "supportsImage": True,
            "supportsVideo": True,
        }

    @_DECRYPT_PATCH
    def test_canonical_model_capabilities_override_legacy_config(self, _decrypt):
        spec = {
            "modelConfig": {
                "env": {
                    "api_key": "sk-test",
                    "model_id": "gemini-test",
                    "model": "gemini",
                },
                "modelCapabilities": {
                    "supportsImage": False,
                    "supportsVideo": True,
                },
            },
            "modelCapabilities": {
                "supportsImage": True,
                "supportsVideo": False,
            },
        }

        result = _extract_model_config(spec)

        assert result["modelCapabilities"] == {
            "supportsImage": True,
            "supportsVideo": False,
        }

    def test_unresolved_bind_model_raises(self):
        spec = {
            "modelConfig": {
                "bind_model": "wecode-claude-weibo",
                "allowed_models": [{"name": "wecode-claude-weibo"}],
            },
            "isCustomConfig": True,
        }
        with pytest.raises(ValueError) as exc_info:
            _extract_model_config(spec)

        assert "wecode-claude-weibo" in str(exc_info.value)

    def test_empty_model_config_raises(self):
        spec = {"modelConfig": {}, "isCustomConfig": True}
        with pytest.raises(ValueError):
            _extract_model_config(spec)

    def test_missing_model_config_raises(self):
        spec = {}
        with pytest.raises(ValueError):
            _extract_model_config(spec)


class TestResolveModelForBotWithPointer:
    """End-to-end (mocked DB) reproduction of the qiqi10-style incident."""

    def test_bot_with_pointer_model_resolves_to_real_target(self):
        """
        Bot.spec.modelRef -> private Model {bind_model, allowed_models} (no env)
        -> public Model with real env. Resolution should reach the real env.
        """
        bot = _make_bot(model_ref_name="leader-editor-model")

        pointer_spec = {
            "modelConfig": {
                "bind_model": "wecode-claude-weibo",
                "bind_model_type": "public",
                "allowed_models": [{"name": "wecode-claude-weibo"}],
            },
            "isCustomConfig": True,
        }
        pointer_kind = _model_kind("leader-editor-model", pointer_spec)

        target_spec = {
            "modelConfig": {
                "env": {
                    "model": "claude",
                    "model_id": "claude-3-5-sonnet",
                    "api_key": "sk-real-key",
                    "base_url": "https://api.anthropic.com",
                }
            }
        }
        target_kind = _model_kind("wecode-claude-weibo", target_spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [
                (pointer_kind, pointer_spec),
                (target_kind, target_spec),
            ]
            model_kind, model_spec, model_name, _ = _resolve_model_for_bot(
                db=MagicMock(), bot=bot, user_id=1
            )

        assert model_name == "leader-editor-model"
        assert model_kind is target_kind
        assert model_spec is target_spec

    @_DECRYPT_PATCH
    def test_get_model_config_for_bot_returns_real_credentials_not_gpt4_default(
        self, _decrypt
    ):
        """
        Regression test for the reported incident: without pointer resolution
        this used to silently return model_id="gpt-4"/api_key="" instead of
        raising or resolving the real credentials.
        """
        bot = _make_bot(model_ref_name="leader-editor-model")

        pointer_spec = {
            "modelConfig": {
                "bind_model": "wecode-claude-weibo",
                "bind_model_type": "public",
                "allowed_models": [{"name": "wecode-claude-weibo"}],
            },
            "isCustomConfig": True,
        }
        pointer_kind = _model_kind("leader-editor-model", pointer_spec)

        target_spec = {
            "modelConfig": {
                "env": {
                    "model": "claude",
                    "model_id": "claude-3-5-sonnet",
                    "api_key": "sk-real-key",
                    "base_url": "https://api.anthropic.com",
                }
            }
        }
        target_kind = _model_kind("wecode-claude-weibo", target_spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [
                (pointer_kind, pointer_spec),
                (target_kind, target_spec),
            ]
            config = get_model_config_for_bot(db=MagicMock(), bot=bot, user_id=1)

        assert config["api_key"] == "sk-real-key"
        assert config["model_id"] == "claude-3-5-sonnet"
        assert config["model"] == "claude"

    def test_get_model_config_for_bot_raises_when_pointer_target_missing(self):
        """Pattern A with a dangling bind_model should raise, not default to gpt-4."""
        bot = _make_bot(model_ref_name="leader-editor-model")

        pointer_spec = {
            "modelConfig": {"bind_model": "deleted-model"},
            "isCustomConfig": True,
        }
        pointer_kind = _model_kind("leader-editor-model", pointer_spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.side_effect = [(pointer_kind, pointer_spec), (None, None)]
            with pytest.raises(ValueError):
                get_model_config_for_bot(db=MagicMock(), bot=bot, user_id=1)

    def test_get_model_config_for_bot_raises_for_pattern_b_empty_config(self):
        """Pattern B: modelConfig is entirely empty - must raise, not default."""
        bot = _make_bot(model_ref_name="empty-model")

        empty_spec = {"modelConfig": {}, "isCustomConfig": True}
        empty_kind = _model_kind("empty-model", empty_spec)

        with patch(
            "app.services.chat.config.model_resolver._find_model_with_namespace"
        ) as mock_find:
            mock_find.return_value = (empty_kind, empty_spec)
            with pytest.raises(ValueError):
                get_model_config_for_bot(db=MagicMock(), bot=bot, user_id=1)
