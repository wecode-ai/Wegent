"""IM browser links preserve desktop destinations across URL decoding."""

from urllib.parse import parse_qs, urlsplit

import pytest

from app.core.config import settings
from app.services.wework_links import browser_link, runtime_task_url


@pytest.mark.parametrize(
    "destination",
    [
        "wework://boards",
        "wework://boards/12",
        "wework://boards/12/issues/gitlab%3A12%2Fissue%233",
        "wework://tasks/device-1/task%2F1",
    ],
)
def test_browser_link_uses_wegent_site(monkeypatch, destination):
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://wegent.example/")
    link = urlsplit(browser_link(destination))
    assert link.scheme == "https"
    assert link.netloc == "wegent.example"
    assert link.path == "/launch/wework"
    assert parse_qs(link.query) == {"destination": [destination]}


@pytest.mark.parametrize("destination", ["https://evil.test", "wework://shell/run"])
def test_browser_link_rejects_unsupported_destination(destination):
    with pytest.raises(ValueError):
        browser_link(destination)


def test_runtime_task_url_encodes_each_identifier():
    assert runtime_task_url("device/1", "task#1") == (
        "wework://tasks/device%2F1/task%231"
    )
