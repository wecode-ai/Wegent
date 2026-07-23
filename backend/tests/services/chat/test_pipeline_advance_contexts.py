# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for pipeline context linking."""

from types import SimpleNamespace
from unittest.mock import patch

from app.services.chat.pipeline_advance import _link_payload_contexts


def test_link_payload_contexts_keeps_legacy_knowledge_base_selection():
    """A legacy KB selection must use the same linking path as contexts."""
    db = object()
    user = SimpleNamespace(id=17)
    task = SimpleNamespace(id=23)
    subtask = SimpleNamespace(id=29)
    payload = SimpleNamespace(
        attachment_ids=None,
        attachment_id=None,
        contexts=None,
        knowledge_base_id=31,
    )

    with patch(
        "app.services.chat.preprocessing.link_contexts_to_subtask",
        return_value=[37],
    ) as link_contexts:
        result = _link_payload_contexts(
            db=db,
            user=user,
            task=task,
            user_subtask=subtask,
            payload=payload,
        )

    assert result == [37]
    link_contexts.assert_called_once_with(
        db=db,
        subtask_id=29,
        user_id=17,
        attachment_ids=None,
        contexts=None,
        task=task,
        knowledge_base_id=31,
    )


def test_link_payload_contexts_skips_empty_payload():
    """An empty pipeline message must not acquire a Task row lock."""
    payload = SimpleNamespace(
        attachment_ids=None,
        attachment_id=None,
        contexts=None,
        knowledge_base_id=None,
    )

    with patch(
        "app.services.chat.preprocessing.link_contexts_to_subtask"
    ) as link_contexts:
        result = _link_payload_contexts(
            db=object(),
            user=SimpleNamespace(id=17),
            task=SimpleNamespace(id=23),
            user_subtask=SimpleNamespace(id=29),
            payload=payload,
        )

    assert result == []
    link_contexts.assert_not_called()
