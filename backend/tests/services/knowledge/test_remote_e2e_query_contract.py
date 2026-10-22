# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""E2E HTTP requests must satisfy the real Runtime transport contract."""

import importlib.util
from pathlib import Path
from typing import Any

import httpx
import pytest

from shared.models import RemoteQueryRequest


@pytest.mark.parametrize("kb_id,document_id,owner_id", [(66, 2, 1), (8, 57, 17)])
def test_remote_e2e_query_is_accepted_by_runtime_protocol(
    monkeypatch: pytest.MonkeyPatch, kb_id: int, document_id: int, owner_id: int
) -> None:
    monkeypatch.setenv("E2E_INTERNAL_SERVICE_TOKEN", "synthetic-service-token")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "synthetic-service-token")
    path = Path(__file__).resolve().parents[2] / "e2e/knowledge_remote_index_support.py"
    spec = importlib.util.spec_from_file_location("remote_e2e_query_support", path)
    assert spec is not None and spec.loader is not None
    support = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(support)
    observed: list[RemoteQueryRequest] = []

    def runtime_post(
        url: str, *, json: dict[str, Any], **kwargs: Any
    ) -> httpx.Response:
        request = RemoteQueryRequest.model_validate(json)
        observed.append(request)
        return httpx.Response(200, json={"records": []})

    monkeypatch.setattr(support.httpx, "post", runtime_post)

    response = support._runtime_query(
        kb_id, document_id, "e2e-resource", owner_id, "query"
    )

    assert response.status_code == 200
    assert len(observed) == 1
    grant = observed[0].authorized_resources[0]
    assert grant.operation == "query"
    assert grant.knowledge_base_id == kb_id
    assert grant.index_owner_user_id == owner_id
    assert observed[0].document_ids == [document_id]
