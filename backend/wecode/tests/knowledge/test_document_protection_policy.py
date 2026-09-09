# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the internal default layered onto the core download policy."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from wecode.service.knowledge.document_protection_policy import (
    is_internal_original_download_allowed,
)


def _knowledge_base(
    spec: dict[str, object], namespace: str = "company"
) -> SimpleNamespace:
    return SimpleNamespace(json={"spec": spec}, namespace=namespace)


@pytest.mark.parametrize(
    ("configured_value", "expected_allowed"),
    [(True, True), (False, False)],
)
def test_explicit_administrator_setting_overrides_internal_default(
    configured_value: bool,
    expected_allowed: bool,
) -> None:
    allowed = is_internal_original_download_allowed(
        MagicMock(),
        _knowledge_base({"allowDocumentDownload": configured_value}),
    )

    assert allowed is expected_allowed


def test_missing_setting_protects_organization_knowledge_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "wecode.service.knowledge.document_protection_policy.load_active_namespace_map",
        lambda _db, _names: {"company": SimpleNamespace(level="organization")},
    )

    allowed = is_internal_original_download_allowed(MagicMock(), _knowledge_base({}))

    assert allowed is False


def test_missing_setting_allows_non_organization_knowledge_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "wecode.service.knowledge.document_protection_policy.load_active_namespace_map",
        lambda _db, _names: {"company": SimpleNamespace(level="group")},
    )

    allowed = is_internal_original_download_allowed(MagicMock(), _knowledge_base({}))

    assert allowed is True
