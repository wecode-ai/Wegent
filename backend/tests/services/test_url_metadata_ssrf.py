import pytest

from app.services.url_metadata import _is_ip_blocked, _validate_url_for_ssrf


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
