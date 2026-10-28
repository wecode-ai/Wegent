"""External OAuth/MCP/download simulator; never replaces Wegent collaborators.

Tokens are opaque, bound to one resource, rotated once, and never recorded in
evidence. Gates coordinate real HTTP requests with real database lock waits.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import secrets
import ssl
import threading
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from aiohttp import web
from openpyxl import Workbook

ORIGIN = "http://127.0.0.1:10099"
NODES = {"doc": "adoc", "other": "adoc", "sheet": "axls", "base": "able"}
TOOLS = {
    "docs": ["list_nodes", "get_document_info", "get_document_content"],
    "table": ["submit_export_job", "query_export_job"],
    "ai_table": ["export_data"],
}


def fingerprint(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16] if value else ""


@dataclass
class Gate:
    entered: threading.Event = field(default_factory=threading.Event)
    release: threading.Event = field(default_factory=threading.Event)

    async def wait(self) -> None:
        self.entered.set()
        if not await asyncio.to_thread(self.release.wait, 12):
            raise RuntimeError("E2E coordinator failed to release external request")


class DingTalkProvider:
    def __init__(self, download_origin: str) -> None:
        self.download_origin = download_origin
        self.clients: dict[str, list[str]] = {}
        self.codes: dict[str, dict[str, str]] = {}
        self.access: dict[str, dict[str, Any]] = {}
        self.refresh: dict[str, dict[str, Any]] = {}
        self.downloads: dict[str, tuple[str, str]] = {}
        self.events: list[dict[str, Any]] = []
        self.gates: dict[tuple[str, str], Gate] = {}
        self.versions: dict[str, int] = {}
        self.personal: dict[str, str] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None

    def resource(self, actor: str, service: str) -> str:
        return f"{ORIGIN}/mcp/{actor}/{service}"

    def gate(self, kind: str, actor: str) -> Gate:
        gate = Gate()
        self.gates[kind, actor] = gate
        return gate

    def unblock(self) -> None:
        for gate in self.gates.values():
            gate.release.set()

    def record(self, kind: str, **values: Any) -> None:
        self.events.append({"kind": kind, **values})

    def issue(self, resource: str, client_id: str) -> dict[str, Any]:
        actor, service = urlsplit(resource).path.split("/")[-2:]
        grant = {"actor": actor, "service": service, "client_id": client_id}
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.access[access] = {**grant, "active": True}
        self.refresh[refresh] = {**grant, "active": True, "resource": resource}
        self.record(
            "issued", **grant, access=fingerprint(access), refresh=fingerprint(refresh)
        )
        return {"access_token": access, "refresh_token": refresh, "expires_in": 7200}

    async def discovery(self, request: web.Request) -> web.Response:
        if request.path == "/.well-known/oauth-authorization-server":
            return web.json_response(
                {
                    "issuer": ORIGIN,
                    "authorization_endpoint": f"{ORIGIN}/authorize",
                    "token_endpoint": f"{ORIGIN}/token",
                    "registration_endpoint": f"{ORIGIN}/register",
                    "scopes_supported": ["read"],
                    "response_types_supported": ["code"],
                    "code_challenge_methods_supported": ["S256"],
                }
            )
        return web.json_response({"authorization_servers": [ORIGIN]})

    async def register(self, request: web.Request) -> web.Response:
        body = await request.json()
        client_id = secrets.token_urlsafe(16)
        self.clients[client_id] = body["redirect_uris"]
        return web.json_response({"client_id": client_id}, status=201)

    async def authorize(self, request: web.Request) -> web.Response:
        params = dict(request.query)
        if params.get("redirect_uri") not in self.clients.get(
            params.get("client_id", ""), []
        ):
            raise web.HTTPBadRequest(text="Unregistered redirect URI")
        if params.get("code_challenge_method") != "S256":
            raise web.HTTPBadRequest(text="PKCE is required")
        code = secrets.token_urlsafe(24)
        self.codes[code] = params
        self.record("consent", actor=urlsplit(params["resource"]).path.split("/")[-2])
        return web.Response(
            status=302,
            headers={
                "Location": params["redirect_uri"]
                + "?"
                + urlencode(
                    {
                        "code": code,
                        "state": params["state"],
                    }
                )
            },
        )

    async def token(self, request: web.Request) -> web.Response:
        params = parse_qs(await request.text())

        def value(key: str) -> str:
            return params.get(key, [""])[0]

        if value("grant_type") == "authorization_code":
            code = self.codes.pop(value("code"), None)
            challenge = (
                base64.urlsafe_b64encode(
                    hashlib.sha256(value("code_verifier").encode()).digest()
                )
                .decode()
                .rstrip("=")
            )
            if (
                not code
                or any(
                    code[key] != value(key)
                    for key in ("client_id", "redirect_uri", "resource")
                )
                or challenge != code["code_challenge"]
            ):
                return web.json_response({"error": "invalid_grant"}, status=400)
            actor = urlsplit(code["resource"]).path.split("/")[-2]
            if gate := self.gates.get(("exchange", actor)):
                await gate.wait()
            return web.json_response(self.issue(code["resource"], code["client_id"]))
        grant = self.refresh.get(value("refresh_token"))
        if not grant or grant["client_id"] != value("client_id"):
            return web.json_response({"error": "invalid_grant"}, status=400)
        self.record(
            "refresh",
            actor=grant["actor"],
            service=grant["service"],
            refresh=fingerprint(value("refresh_token")),
        )
        if gate := self.gates.get(("refresh", grant["actor"])):
            await gate.wait()
        if not grant["active"]:
            self.record("invalid_grant", actor=grant["actor"], service=grant["service"])
            return web.json_response({"error": "invalid_grant"}, status=400)
        grant["active"] = False
        return web.json_response(self.issue(grant["resource"], grant["client_id"]))

    def info(self, actor: str, node_id: str) -> dict[str, Any]:
        return {
            "nodeId": node_id,
            "name": f"E2E-{node_id}",
            "nodeType": "file",
            "contentType": "ALIDOC",
            "extension": NODES[node_id],
            "url": f"https://alidocs.dingtalk.com/i/nodes/{node_id}",
            "updateTime": 1800000000 + self.versions.get(actor, 1),
        }

    def marker(self, actor: str, node_id: str) -> str:
        return f"DINGTALK-{actor}-{node_id}-V{self.versions.get(actor, 1)}"

    def download_url(self, actor: str, service: str) -> str:
        ticket = secrets.token_urlsafe(24)
        self.downloads[ticket] = (actor, service)
        return f"{self.download_origin}/download?ticket={ticket}"

    async def mcp(self, request: web.Request) -> web.Response:
        actor, service = request.match_info["actor"], request.match_info["service"]
        if request.method == "DELETE":
            return web.Response(status=200)
        if request.method != "POST":
            return web.Response(
                status=401,
                headers={
                    "WWW-Authenticate": (
                        f'Bearer resource_metadata="{ORIGIN}'
                        '/.well-known/oauth-protected-resource"'
                    )
                },
            )
        bearer = request.headers.get("Authorization", "").removeprefix("Bearer ")
        grant = self.access.get(bearer, {})
        personal = (
            request.query.get("personal") == self.personal.get(actor)
            and actor in self.personal
        )
        authorized = (
            grant.get("active")
            and grant.get("actor") == actor
            and grant.get("service") == service
        ) or (personal and not bearer)
        message = await request.json()
        method = message["method"]
        self.record(
            "mcp",
            actor=actor,
            service=service,
            method=method,
            accepted=bool(authorized),
            access=fingerprint(bearer),
        )
        if not authorized:
            return web.Response(status=401)
        if method.startswith("notifications/"):
            return web.Response(status=202)
        if method == "initialize":
            result = {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "external-dingtalk-e2e", "version": "1"},
            }
        elif method == "tools/list":
            result = {
                "tools": [
                    {
                        "name": name,
                        "inputSchema": {"type": "object", "additionalProperties": True},
                    }
                    for name in TOOLS[service]
                ]
            }
        elif method == "tools/call":
            name = message["params"]["name"]
            if name not in TOOLS[service]:
                raise web.HTTPForbidden(text="Tool belongs to another service")
            args = message["params"].get("arguments", {})
            self.record(
                "tool",
                actor=actor,
                service=service,
                name=name,
                access=fingerprint(bearer),
            )
            payload = self.tool(actor, service, name, args)
            result = {
                "content": [{"type": "text", "text": json.dumps(payload)}],
                "isError": False,
            }
        else:
            raise web.HTTPBadRequest(text="Unsupported MCP method")
        return web.json_response(
            {"jsonrpc": "2.0", "id": message["id"], "result": result}
        )

    def tool(
        self, actor: str, service: str, name: str, args: dict[str, Any]
    ) -> dict[str, Any]:
        if name == "list_nodes":
            return {"items": [self.info(actor, node_id) for node_id in NODES]}
        if name == "get_document_info":
            return {"success": True, **self.info(actor, args["nodeId"])}
        if name == "get_document_content":
            return {"success": True, "markdown": self.marker(actor, args["nodeId"])}
        if name == "submit_export_job":
            return {"success": True, "jobId": f"{actor}-sheet"}
        if name == "query_export_job":
            return {
                "success": True,
                "jobId": args["jobId"],
                "status": "success",
                "downloadUrl": self.download_url(actor, service),
            }
        return {
            "status": "success",
            "data": {
                "taskId": f"{actor}-base",
                "status": "success",
                "fileName": "export.xlsx",
                "downloadUrl": self.download_url(actor, service),
            },
        }

    async def download(self, request: web.Request) -> web.Response:
        target = self.downloads.pop(request.query.get("ticket", ""), None)
        # Signed download tickets are allowed; MCP credentials must never travel here.
        leaked = any(
            token in request.raw_path
            or any(token in value for value in request.headers.values())
            for token in [*self.access, *self.refresh]
        )
        self.record(
            "download",
            actor=target[0] if target else "",
            service=target[1] if target else "",
            leaked=leaked,
            authorization=bool(request.headers.get("Authorization")),
        )
        if not target or leaked or request.headers.get("Authorization"):
            raise web.HTTPForbidden(text="Invalid download credentials")
        workbook = Workbook()
        workbook.active.append(["marker"])
        workbook.active.append(
            [self.marker(target[0], "sheet" if target[1] == "table" else "base")]
        )
        content = io.BytesIO()
        workbook.save(content)
        return web.Response(
            body=content.getvalue(),
            content_type=(
                "application/vnd.openxmlformats-officedocument." "spreadsheetml.sheet"
            ),
        )

    async def serve(
        self, certificate: str | None, private_key: str | None
    ) -> web.AppRunner:
        app = web.Application()
        app.router.add_get("/.well-known/{tail:.*}", self.discovery)
        app.router.add_post("/register", self.register)
        app.router.add_get("/authorize", self.authorize)
        app.router.add_post("/token", self.token)
        app.router.add_route("*", "/mcp/{actor}/{service}", self.mcp)
        app.router.add_get("/download", self.download)
        runner = web.AppRunner(app, access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 10099).start()
        if certificate and private_key:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certificate, private_key)
            await web.TCPSite(runner, "0.0.0.0", 10443, ssl_context=context).start()
        return runner

    def start(
        self, certificate: str | None = None, private_key: str | None = None
    ) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.runner = asyncio.run_coroutine_threadsafe(
            self.serve(certificate, private_key), self.loop
        ).result(10)

    def stop(self) -> None:
        self.unblock()
        assert self.loop and self.thread
        asyncio.run_coroutine_threadsafe(self.runner.cleanup(), self.loop).result(15)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()
