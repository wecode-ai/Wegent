# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the IM model selection cache payload."""

from app.services.channels.model_selection import ModelSelection


def test_model_selection_round_trips_namespace() -> None:
    selection = ModelSelection(
        model_name="shared-model",
        model_type="group",
        model_namespace="platform",
    )

    restored = ModelSelection.from_dict(selection.to_dict())

    assert restored.model_namespace == "platform"


def test_model_selection_accepts_legacy_cached_payload() -> None:
    selection = ModelSelection.from_dict(
        {"model_name": "legacy-model", "model_type": "public"}
    )

    assert selection.model_namespace is None
