"""Protocol discovery tests using real HTTP response parsing."""

from collections.abc import Callable

import httpx
import pytest
from fastapi import HTTPException

from app.services.connector_oauth_discovery import (
    _require_secure_url,
    discover_connector_oauth,
)

RESOURCE = "https://fig.example.test/mcp"
ISSUER = "https://identity.example.test/tenant"
RESOURCE_PATH = "https://fig.example.test/.well-known/oauth-protected-resource/mcp"
RESOURCE_ROOT = "https://fig.example.test/.well-known/oauth-protected-resource"
AUTH_URLS = [
    "https://identity.example.test/.well-known/oauth-authorization-server/tenant",
    "https://identity.example.test/.well-known/openid-configuration/tenant",
    "https://identity.example.test/tenant/.well-known/openid-configuration",
]


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Callable:
    def install(responses: dict[str, object]) -> list[str]:
        urls: list[str] = []

        def handle(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            urls.append(url)
            response = responses.get(url)
            if isinstance(response, httpx.Response):
                return response
            if response is None:
                return httpx.Response(404)
            return httpx.Response(200, json=response)

        monkeypatch.setattr(
            "app.services.connector_oauth_discovery.create_connector_http_client",
            lambda **kwargs: httpx.AsyncClient(
                transport=httpx.MockTransport(handle), **kwargs
            ),
        )
        return urls

    return install


def protected_resource(resource: str = RESOURCE, issuer: str = ISSUER) -> dict:
    return {"resource": resource, "authorization_servers": [issuer]}


def authorization_server(issuer: str = ISSUER) -> dict:
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/authorize",
        "token_endpoint": f"{issuer}/token",
        "registration_endpoint": f"{issuer}/register",
        "scopes_supported": ["figma:mcp", "figma:rest"],
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("resource_metadata", [RESOURCE_PATH, RESOURCE_ROOT])
@pytest.mark.parametrize("authorization_metadata", AUTH_URLS)
async def test_discovery_uses_ordered_resource_and_oauth_or_oidc_endpoints(
    serve: Callable, resource_metadata: str, authorization_metadata: str
) -> None:
    urls = serve(
        {
            RESOURCE: httpx.Response(401),
            resource_metadata: protected_resource(),
            authorization_metadata: authorization_server(),
        }
    )
    metadata = await discover_connector_oauth(RESOURCE)
    assert metadata == {
        "resource": RESOURCE,
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "registration_endpoint": f"{ISSUER}/register",
        "scope": "figma:mcp figma:rest",
    }
    resource_urls = [RESOURCE_PATH]
    if resource_metadata == RESOURCE_ROOT:
        resource_urls.append(RESOURCE_ROOT)
    assert urls == [
        RESOURCE,
        *resource_urls,
        *AUTH_URLS[: AUTH_URLS.index(authorization_metadata) + 1],
    ]


@pytest.mark.asyncio
async def test_www_authenticate_metadata_takes_priority_without_root_fallback(
    serve: Callable,
) -> None:
    advertised = "https://metadata.example.test/resource"
    urls = serve(
        {
            RESOURCE: httpx.Response(
                401,
                headers={
                    "WWW-Authenticate": f'Bearer resource_metadata="{advertised}"'
                },
            ),
            advertised: protected_resource(),
            AUTH_URLS[0]: authorization_server(),
        }
    )
    await discover_connector_oauth(RESOURCE)
    assert urls == [RESOURCE, advertised, AUTH_URLS[0]]


@pytest.mark.asyncio
async def test_root_resource_and_issuer_do_not_repeat_discovery_urls(
    serve: Callable,
) -> None:
    resource = "https://fig.example.test"
    issuer = "https://identity.example.test"
    oidc = f"{issuer}/.well-known/openid-configuration"
    urls = serve(
        {
            resource: httpx.Response(401),
            RESOURCE_ROOT: protected_resource(resource, issuer),
            oidc: authorization_server(issuer),
        }
    )
    await discover_connector_oauth(resource)
    assert urls == [
        resource,
        RESOURCE_ROOT,
        f"{issuer}/.well-known/oauth-authorization-server",
        oidc,
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["resource", "authorization", "advertised"])
async def test_discovery_reports_exhausted_metadata_without_using_other_identities(
    serve: Callable, missing: str
) -> None:
    responses: dict[str, object] = {RESOURCE: httpx.Response(401)}
    expected = [RESOURCE, RESOURCE_PATH, RESOURCE_ROOT]
    if missing == "authorization":
        responses[RESOURCE_PATH] = protected_resource()
        expected = [RESOURCE, RESOURCE_PATH, *AUTH_URLS]
    elif missing == "advertised":
        advertised = "https://metadata.example.test/missing"
        responses[RESOURCE] = httpx.Response(
            401,
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{advertised}"'},
        )
        responses[RESOURCE_ROOT] = protected_resource()
        expected = [RESOURCE, advertised]
    urls = serve(responses)
    with pytest.raises(HTTPException) as failure:
        await discover_connector_oauth(RESOURCE)
    assert failure.value.status_code == 502
    assert urls == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["resource", "issuer"])
async def test_valid_but_mismatched_metadata_is_rejected_immediately(
    serve: Callable, mismatch: str
) -> None:
    protected = protected_resource()
    metadata = authorization_server()
    if mismatch == "resource":
        protected["resource"] = "https://fig.example.test/other"
    else:
        metadata["issuer"] = "https://identity.example.test/other"
    urls = serve(
        {
            RESOURCE: httpx.Response(401),
            RESOURCE_PATH: protected,
            RESOURCE_ROOT: protected_resource(),
            **{url: metadata for url in AUTH_URLS},
        }
    )
    with pytest.raises(HTTPException) as failure:
        await discover_connector_oauth(RESOURCE)
    assert failure.value.status_code == 502
    assert urls == [RESOURCE, RESOURCE_PATH] + (
        [] if mismatch == "resource" else [AUTH_URLS[0]]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    [
        "header",
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
    ],
)
async def test_discovery_rejects_insecure_metadata_urls(
    serve: Callable, field: str
) -> None:
    protected = protected_resource()
    metadata = authorization_server()
    response = httpx.Response(401)
    if field == "header":
        response = httpx.Response(
            401,
            headers={
                "WWW-Authenticate": 'Bearer resource_metadata="http://metadata.example.test/resource"'
            },
        )
    elif field == "issuer":
        protected["authorization_servers"] = ["http://identity.example.test"]
    else:
        metadata[field] = "http://identity.example.test/insecure"
    urls = serve({RESOURCE: response, RESOURCE_PATH: protected, AUTH_URLS[0]: metadata})
    with pytest.raises(HTTPException) as failure:
        await discover_connector_oauth(RESOURCE)
    assert failure.value.status_code == 400
    assert not any(url.startswith("http:") for url in urls)


@pytest.mark.asyncio
async def test_discovery_rejects_insecure_resource_url() -> None:
    with pytest.raises(HTTPException) as failure:
        await discover_connector_oauth("http://fig.example.test/mcp")
    assert failure.value.status_code == 400


@pytest.mark.parametrize(
    "url",
    ["http://localhost:9000/mcp", "http://127.0.0.1:9000/mcp", "http://[::1]:9000/mcp"],
)
def test_discovery_allows_http_loopback_hosts(url: str) -> None:
    assert _require_secure_url(url, field="resource URL") == url
