# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from starlette.responses import Response

from app.api.endpoints.kind import skills as skills_endpoint


class _QueryStub:
    def __init__(self, result):
        self.result = result

    def filter(self, *_args, **_kwargs):
        return self

    def first(self):
        return self.result


@pytest.mark.unit
def test_download_skill_releases_transaction_before_streaming_response(monkeypatch):
    call_order = []
    db = Mock()
    db.rollback.side_effect = lambda: call_order.append("rollback")
    current_user = SimpleNamespace(id=7)
    skill = SimpleNamespace(metadata=SimpleNamespace(name="team-skill"))

    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_by_id",
        Mock(return_value=skill),
    )
    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_binary",
        Mock(return_value=b"zip-data"),
    )

    def fake_streaming_response(*_args, **_kwargs):
        call_order.append("stream")
        return SimpleNamespace()

    monkeypatch.setattr(skills_endpoint, "StreamingResponse", fake_streaming_response)

    skills_endpoint.download_skill(
        skill_id=42,
        namespace="default",
        task_id=None,
        current_user=current_user,
        db=db,
    )

    assert call_order == ["rollback", "stream"]


@pytest.mark.unit
def test_download_skill_returns_not_modified_for_matching_etag(monkeypatch):
    db = Mock()
    current_user = SimpleNamespace(id=7)
    skill = SimpleNamespace(metadata=SimpleNamespace(name="team-skill"))
    archive = b"zip-data"
    expected_hash = "00c11ef6a96eac1263aef4878e7d5a8b35fea40863f5d1c84f15ffa19f65ecae"

    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_by_id",
        Mock(return_value=skill),
    )
    monkeypatch.setattr(
        skills_endpoint.skill_kinds_service,
        "get_skill_binary",
        Mock(return_value=archive),
    )

    response = skills_endpoint.download_skill(
        skill_id=42,
        namespace="default",
        task_id=None,
        if_none_match=f'"sha256:{expected_hash}"',
        current_user=current_user,
        db=db,
    )

    assert isinstance(response, Response)
    assert response.status_code == 304
    assert response.headers["etag"] == f'"sha256:{expected_hash}"'


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
        current_user=SimpleNamespace(id=7),
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
        current_user=SimpleNamespace(id=7),
        db=db,
    )

    assert (
        response.headers["Content-Disposition"]
        == "attachment; filename*=UTF-8''%E5%88%86%E6%9E%90%20Tool.zip"
    )
