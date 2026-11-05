import pytest
from fastapi import HTTPException

from app.services.connector_oauth_discovery import (
    _require_secure_url,
    discover_connector_oauth,
)


@pytest.mark.asyncio
async def test_discovery_resolves_protected_resource_and_authorization_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class ResourceResponse:
        status_code = 401
        headers = {
            "www-authenticate": (
                'Bearer realm="mcp", resource_metadata='
                '"https://fig.example.test/.well-known/oauth-protected-resource/mcp"'
            )
        }

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "resource": "https://fig.example.test/mcp",
                "authorization_servers": ["https://fig.example.test"],
            }

    class MetadataResponse:
        headers = {}

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "authorization_endpoint": "https://fig.example.test/authorize",
                "token_endpoint": "https://fig.example.test/token",
                "registration_endpoint": "https://fig.example.test/register",
                "scopes_supported": ["figma:mcp", "figma:rest"],
            }

    class Client:
        def __init__(self):
            self.urls = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def get(self, url: str, **_kwargs):
            self.urls.append(url)
            if url.endswith("/.well-known/oauth-protected-resource/mcp"):
                return ResourceResponse()
            return MetadataResponse()

    client = Client()

    def factory(**_kwargs):
        return client

    import app.services.connector_oauth_discovery as discovery

    monkeypatch.setattr(discovery.httpx, "AsyncClient", factory)

    metadata = await discover_connector_oauth("https://fig.example.test/mcp")

    assert metadata["authorization_endpoint"] == "https://fig.example.test/authorize"
    assert metadata["registration_endpoint"] == "https://fig.example.test/register"
    assert metadata["scope"] == "figma:mcp figma:rest"


def test_discovery_rejects_insecure_resource_url() -> None:
    with pytest.raises(HTTPException) as exc_info:
        import asyncio

        asyncio.run(discover_connector_oauth("http://fig.example.test/mcp"))

    assert exc_info.value.status_code == 400


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:9000/mcp",
        "http://127.0.0.1:9000/mcp",
        "http://[::1]:9000/mcp",
    ],
)
def test_discovery_allows_http_loopback_hosts(url: str) -> None:
    assert _require_secure_url(url, field="resource URL") == url
