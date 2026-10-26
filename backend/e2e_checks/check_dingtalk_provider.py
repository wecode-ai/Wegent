"""Exercise the external simulator over HTTP and the unmodified MCP client.

This validates fixture behavior only; the live Wegent suite is a separate step.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from e2e_checks.dingtalk_oauth.provider import ORIGIN, DingTalkProvider


async def read(resource: str, access: str) -> None:
    async with streamablehttp_client(
        resource, headers={"Authorization": f"Bearer {access}"}
    ) as (reader, writer, _):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "list_nodes",
                "get_document_info",
                "get_document_content",
            }
            result = await session.call_tool("get_document_content", {"nodeId": "doc"})
            assert not result.isError
            assert "DINGTALK-check-doc-V1" in result.content[0].text


def check() -> None:
    provider = DingTalkProvider(ORIGIN)
    provider.start()
    try:
        with httpx.Client(base_url=ORIGIN, timeout=10) as client:
            metadata = client.get("/.well-known/oauth-authorization-server").json()
            client_id = client.post(
                metadata["registration_endpoint"],
                json={"redirect_uris": ["http://localhost/callback"]},
            ).json()["client_id"]
            verifier = "fixture-verifier"
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                .decode()
                .rstrip("=")
            )
            resource = provider.resource("check", "docs")
            discovery = client.get(resource)
            assert discovery.status_code == 401
            assert "resource_metadata=" in discovery.headers["WWW-Authenticate"]
            consent = client.get(
                metadata["authorization_endpoint"],
                params={
                    "client_id": client_id,
                    "redirect_uri": "http://localhost/callback",
                    "response_type": "code",
                    "resource": resource,
                    "state": "fixture-state",
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                },
            )
            callback = parse_qs(urlsplit(consent.headers["location"]).query)
            assert callback["state"] == ["fixture-state"]
            exchange = {
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": callback["code"][0],
                "code_verifier": verifier,
                "redirect_uri": "http://localhost/callback",
                "resource": resource,
            }
            issued = client.post("/token", data=exchange)
            assert issued.status_code == 200
            assert client.post("/token", data=exchange).status_code == 400
            tokens = issued.json()
            asyncio.run(read(resource, tokens["access_token"]))
            for wrong in [
                provider.resource("someone-else", "docs"),
                provider.resource("check", "table"),
            ]:
                denied = client.post(
                    wrong,
                    headers={"Authorization": f"Bearer {tokens['access_token']}"},
                    json={"jsonrpc": "2.0", "id": 1, "method": "initialize"},
                )
                assert denied.status_code == 401
            body = {
                "grant_type": "refresh_token",
                "client_id": client_id,
                "refresh_token": tokens["refresh_token"],
            }
            rotated = client.post("/token", data=body)
            assert rotated.status_code == 200
            assert client.post("/token", data=body).json()["error"] == "invalid_grant"
            download = provider.download_url("check", "table")
            assert (
                client.get(
                    download,
                    headers={"Authorization": f"Bearer {tokens['access_token']}"},
                ).status_code
                == 403
            )
            assert provider.events[-1]["leaked"]
            clean = client.get(provider.download_url("check", "table"))
            assert clean.status_code == 200 and clean.content.startswith(b"PK")
        print("External simulator protocol checks passed (not a Wegent E2E result)")
    finally:
        provider.stop()


if __name__ == "__main__":
    check()
