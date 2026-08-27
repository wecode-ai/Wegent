# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from app.services.adapters.team_kinds import team_kinds_service


def test_cached_public_bot_summary_preserves_model_restrictions() -> None:
    bot = MagicMock()
    bot.name = "minute-video-bot"
    bot.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Bot",
        "metadata": {"name": bot.name, "namespace": "default"},
        "spec": {
            "ghostRef": {"name": "minute-video-ghost", "namespace": "default"},
            "shellRef": {"name": "Chat", "namespace": "default"},
            "modelRef": {
                "name": "minute-video-bot-model",
                "namespace": "default",
            },
        },
    }

    model = MagicMock()
    model.name = "minute-video-bot-model"
    model.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Model",
        "metadata": {"name": model.name, "namespace": "default"},
        "spec": {
            "isCustomConfig": True,
            "modelConfig": {
                "bind_model": "Seedance-2.0-Fast",
                "bind_model_type": "public",
                "allowed_models": [
                    {
                        "name": "Seedance-2.0-Fast",
                        "type": "public",
                        "namespace": "default",
                    }
                ],
            },
        },
    }

    summary = team_kinds_service._get_bot_summary_with_cache(
        bot=bot,
        user_id=7,
        shells_cache={},
        public_shells_cache={},
        models_cache={},
        public_models_cache={model.name: model},
    )

    assert summary["agent_config"] == model.json["spec"]["modelConfig"]
