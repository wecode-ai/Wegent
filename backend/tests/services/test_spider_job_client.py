# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import httpx
import pytest

from app.services.spider_job_client import SpiderJobClient, SpiderJobError


class _FakeClient:
    def __init__(self, payloads: list[dict]):
        self.payloads = iter(payloads)
        self.requests: list[tuple[str, dict]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def get(self, url: str, *, params: dict):
        self.requests.append((url, params))
        request = httpx.Request("GET", url, params=params)
        return httpx.Response(200, request=request, json=next(self.payloads))


def _install_fake_client(monkeypatch, payloads: list[dict]) -> _FakeClient:
    fake_client = _FakeClient(payloads)
    monkeypatch.setattr(
        "app.services.spider_job_client.httpx.AsyncClient",
        lambda **_kwargs: fake_client,
    )

    async def no_sleep(_seconds: float):
        return None

    monkeypatch.setattr("app.services.spider_job_client.asyncio.sleep", no_sleep)
    return fake_client


@pytest.mark.asyncio
async def test_run_job_submits_polls_and_returns_rows(monkeypatch):
    rows = [{"article": {"id": "article-1"}, "comments": []}]
    fake_client = _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "desc": "success", "result": {"run_id": "run-1"}},
            {"code": 0, "desc": "", "result": {"row": {"result": 0}}},
            {"code": 0, "desc": "", "result": {"row": {"result": 1}}},
            {"code": 0, "desc": "", "result": {"rows": rows}},
        ],
    )

    params = {"type": "page", "url": "https://example.com/post/1", "options": ""}
    result = await SpiderJobClient().run_job(params)

    assert result == rows
    assert [request[0] for request in fake_client.requests] == [
        "http://iam.erp.sina.com.cn/interface/index.php/c_cms_helper/run_job",
        "http://queue.spider.pub.sina.com.cn:9050/get_run",
        "http://queue.spider.pub.sina.com.cn:9050/get_run",
        "http://queue.spider.pub.sina.com.cn:9050/get_result",
    ]
    assert fake_client.requests[0][1] == params


@pytest.mark.asyncio
async def test_status_query_fails_after_three_consecutive_errors(monkeypatch):
    _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "result": {"run_id": "run-1"}},
            {"code": 1, "desc": "not ready"},
            {"code": 1, "desc": "not ready"},
            {"code": 1, "desc": "not ready"},
        ],
    )

    with pytest.raises(SpiderJobError, match="three consecutive times"):
        await SpiderJobClient().run_job({"type": "page"})


@pytest.mark.asyncio
async def test_status_query_fails_after_three_missing_status_values(monkeypatch):
    _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "result": {"run_id": "run-1"}},
            {"code": 0, "result": {"row": {}}},
            {"code": 0, "result": {"row": {}}},
            {"code": 0, "result": {"row": {}}},
        ],
    )

    with pytest.raises(SpiderJobError, match="three consecutive times"):
        await SpiderJobClient().run_job({"type": "page"})


@pytest.mark.asyncio
async def test_successful_status_query_resets_failure_count(monkeypatch):
    rows = [{"article": {"id": "article-1"}, "comments": []}]
    _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "result": {"run_id": "run-1"}},
            {"code": 1, "desc": "not ready"},
            {"code": 1, "desc": "not ready"},
            {"code": 0, "result": {"row": {"result": 0}}},
            {"code": 1, "desc": "not ready"},
            {"code": 1, "desc": "not ready"},
            {"code": 0, "result": {"row": {"result": 1}}},
            {"code": 0, "result": {"rows": rows}},
        ],
    )

    assert await SpiderJobClient().run_job({"type": "page"}) == rows


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "message"),
    [(2, "job failed"), (3, "job timed out")],
)
async def test_terminal_status_does_not_fetch_result(monkeypatch, status, message):
    fake_client = _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "result": {"run_id": "run-1"}},
            {"code": 0, "result": {"row": {"result": status}}},
        ],
    )

    with pytest.raises(SpiderJobError, match=message):
        await SpiderJobClient().run_job({"type": "page"})

    assert len(fake_client.requests) == 2


@pytest.mark.asyncio
async def test_run_job_allows_empty_result_rows(monkeypatch):
    _install_fake_client(
        monkeypatch,
        [
            {"code": 0, "result": {"run_id": "run-1"}},
            {"code": 0, "result": {"row": {"result": 1}}},
            {"code": 0, "result": {"rows": []}},
        ],
    )

    assert await SpiderJobClient().run_job({"type": "comment"}) == []
