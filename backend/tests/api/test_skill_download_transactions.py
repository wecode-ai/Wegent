# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.api.endpoints.kind import skills as skills_endpoint


class _QueryStub:
    def __init__(self, result):
        self.result = result

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.result


@pytest.mark.unit
def test_download_public_skill_releases_transaction_before_streaming_response(
    monkeypatch,
):
    call_order = []
    public_skill = SimpleNamespace(name="public-skill")
    db = Mock()
    db.query.return_value = _QueryStub(public_skill)
    db.rollback.side_effect = lambda: call_order.append("rollback")

    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_binary",
        Mock(return_value=b"zip-data"),
    )

    def fake_streaming_response(*_args, **_kwargs):
        call_order.append("stream")
        return SimpleNamespace()

    monkeypatch.setattr(skills_endpoint, "StreamingResponse", fake_streaming_response)

    skills_endpoint.download_public_skill(
        skill_id=42,
        request=SimpleNamespace(headers={}),
        current_user=SimpleNamespace(id=7, role="admin"),
        db=db,
    )

    assert call_order == ["rollback", "stream"]


@pytest.mark.unit
def test_download_public_skill_encodes_content_disposition_filename(monkeypatch):
    public_skill = SimpleNamespace(name="分析 Tool")
    db = Mock()
    db.query.return_value = _QueryStub(public_skill)

    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_binary",
        Mock(return_value=b"zip-data"),
    )

    response = skills_endpoint.download_public_skill(
        skill_id=42,
        request=SimpleNamespace(headers={}),
        current_user=SimpleNamespace(id=7, role="admin"),
        db=db,
    )

    assert (
        response.headers["Content-Disposition"]
        == "attachment; filename*=UTF-8''%E5%88%86%E6%9E%90%20Tool.zip"
    )
