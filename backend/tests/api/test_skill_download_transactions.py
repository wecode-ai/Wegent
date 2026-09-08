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


def _request_stub():
    return SimpleNamespace(headers={}, state=SimpleNamespace())


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
        request=_request_stub(),
        namespace="default",
        task_id=None,
        current_user=SimpleNamespace(id=current_user.id, role="user"),
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

    request = _request_stub()
    response = skills_endpoint.download_skill(
        skill_id=42,
        request=request,
        namespace="default",
        task_id=None,
        if_none_match=f'"sha256:{expected_hash}"',
        current_user=SimpleNamespace(id=current_user.id, role="user"),
        db=db,
    )

    assert isinstance(response, Response)
    assert response.status_code == 304
    assert response.headers["etag"] == f'"sha256:{expected_hash}"'
    assert request.state.skill_download_metadata.cache_source == "conditional_etag"
    assert request.state.skill_download_metadata.bytes_count == 0


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
        request=_request_stub(),
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

    request = _request_stub()
    response = skills_endpoint.download_public_skill(
        skill_id=42,
        request=request,
        current_user=SimpleNamespace(id=7, role="admin"),
        db=db,
    )

    assert (
        response.headers["Content-Disposition"]
        == "attachment; filename*=UTF-8''%E5%88%86%E6%9E%90%20Tool.zip"
    )
    assert response.headers["Content-Length"] == "8"
    assert request.state.skill_download_metadata.skill_name == "分析 Tool"
    assert request.state.skill_download_metadata.cache_source == "skill_binary"
    assert request.state.skill_download_metadata.bytes_count == 8
