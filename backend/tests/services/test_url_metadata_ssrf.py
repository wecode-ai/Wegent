import threading

import pytest

from app.services import url_metadata
from app.services.url_metadata import (
    UrlMetadataResult,
    _is_ip_blocked,
    _validate_url_for_ssrf,
)


@pytest.mark.parametrize("ip", ["0.0.0.0", "::"])
def test_unspecified_ip_is_blocked(ip):
    assert _is_ip_blocked(ip) is True


@pytest.mark.parametrize(
    "url",
    [
        "http://0.0.0.0",
        "http://0.0.0.0/",
        "http://0.0.0.0:8080",
        "http://[::]",
        "http://[::]/",
        "http://[::]:8080",
    ],
)
def test_unspecified_url_is_blocked(url):
    assert _validate_url_for_ssrf(url) is False


@pytest.mark.asyncio
async def test_fetch_url_metadata_offloads_dns_and_cache(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread_id = threading.get_ident()
    worker_thread_ids: list[int] = []

    def validate(_url: str) -> bool:
        worker_thread_ids.append(threading.get_ident())
        return True

    def read_cache(url: str) -> UrlMetadataResult:
        worker_thread_ids.append(threading.get_ident())
        return UrlMetadataResult(url=url, title="Cached")

    monkeypatch.setattr(url_metadata, "_validate_url_for_ssrf", validate)
    monkeypatch.setattr(url_metadata, "_read_cached_result", read_cache)

    result = await url_metadata.fetch_url_metadata("https://example.com")

    assert result.title == "Cached"
    assert len(worker_thread_ids) == 2
    assert all(thread_id != loop_thread_id for thread_id in worker_thread_ids)
