"""Live product requests and narrowly scoped E2E state/lock inspection."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx
import socketio
from sqlalchemy import text

from app.db.session import SessionLocal
from app.models.user import User
from app.services.user_mcp_service import user_mcp_service
from e2e_checks.dingtalk_oauth.provider import DingTalkProvider, fingerprint
from tests.e2e.knowledge_remote_index_support import (
    BACKEND_URL,
    EMBEDDING_MODEL_URL,
    MOCK_MODEL_SERVER_URL,
    _chunk_contents,
    _create_knowledge_base,
    _create_retrieval_resources,
    _document_chunks,
    _require_remote_services,
)


def wait_until(check: Callable[[], Any], description: str, timeout: float = 60) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if result := check():
            return result
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {description}")


def ok(response: httpx.Response, expected: int = 200) -> Any:
    # Do not include raw responses: discovery and session bodies contain secrets.
    assert (
        response.status_code == expected
    ), f"HTTP {response.status_code}; expected {expected}"
    return response.json() if response.content else None


def assert_test_database() -> None:
    with SessionLocal() as db:
        url = db.get_bind().url
        assert url.get_backend_name() == "mysql"
        assert url.host in {"localhost", "127.0.0.1", "mysql"}
        assert "test" in (url.database or ""), "E2E requires a disposable test database"


@dataclass
class Authorization:
    actor: Actor
    service: str
    browser: httpx.Client
    session: dict[str, Any]
    callback: str

    def complete(self, status: int = 200) -> httpx.Response:
        response = self.browser.get(self.callback)
        assert (
            response.status_code == status
        ), f"OAuth callback returned {response.status_code}, expected {status}"
        return response

    def poll(self) -> dict[str, Any]:
        return ok(
            self.actor.client.get(
                self.actor.service_path(self.service)
                + f"/oauth/sessions/{self.session['session_id']}/poll",
                params={"poll_token": self.session["poll_token"]},
            )
        )


class Actor:
    def __init__(
        self, user_id: int, token: str, name: str, provider: DingTalkProvider
    ) -> None:
        self.id, self.name, self.provider = user_id, name, provider
        self.client = httpx.Client(
            base_url=BACKEND_URL,
            headers={"Authorization": f"Bearer {token}"},
            timeout=60,
        )
        self.token = token
        self.browsers: list[httpx.Client] = []
        self.cleanup_paths: list[str] = []
        self.document_ids: set[int] = set()
        self.knowledge_base_id: int | None = None

    @staticmethod
    def service_path(service: str) -> str:
        return f"/api/users/me/mcps/providers/dingtalk/services/{service}"

    def configure(
        self, service: str = "docs", *, mode: str = "oauth", suffix: str = ""
    ) -> None:
        ok(
            self.client.put(
                self.service_path(service),
                json={
                    "enabled": True,
                    "url": self.provider.resource(self.name, service) + suffix,
                    "auth_mode": mode,
                },
            )
        )

    def begin(self, service: str = "docs") -> Authorization:
        browser = httpx.Client(base_url=BACKEND_URL, timeout=60)
        self.browsers.append(browser)
        session = ok(
            browser.post(
                self.service_path(service) + "/oauth/sessions",
                headers={"Authorization": f"Bearer {self.token}"},
            )
        )
        consent = browser.get(session["authorize_url"])
        assert consent.status_code == 302
        return Authorization(
            self, service, browser, session, consent.headers["location"]
        )

    def authorize(self, service: str = "docs") -> None:
        self.configure(service)
        authorization = self.begin(service)
        authorization.complete()
        assert authorization.poll()["status"] == "success"
        assert self.credentials(service)["access_token"]

    def credentials(self, service: str = "docs") -> dict[str, Any]:
        with SessionLocal() as db:
            user = db.get(User, self.id)
            return user_mcp_service.get_service_oauth_credentials(
                user.preferences, "dingtalk", service
            )

    def snapshot(self, service: str = "docs") -> dict[str, Any]:
        credentials = self.credentials(service)
        return {
            "access": fingerprint(credentials["access_token"]),
            "refresh": fingerprint(credentials["refresh_token"]),
            "expires_at": credentials["expires_at"],
        }

    def expire(self, service: str = "docs", *, revoke: bool = False) -> None:
        # Only the clock metadata is arranged locally. All grants come from HTTP.
        with SessionLocal.begin() as db:
            user = db.query(User).filter(User.id == self.id).with_for_update().one()
            preferences = json.loads(user.preferences)
            preferences["mcps"]["dingtalk"]["services"][service]["credentials"][
                "expires_at"
            ] = 1
            user.preferences = json.dumps(preferences)
        credentials = self.credentials(service)
        self.provider.access[credentials["access_token"]]["active"] = False
        if revoke:
            self.provider.refresh[credentials["refresh_token"]]["active"] = False

    def sync_directory(self, status: int = 200) -> httpx.Response:
        response = self.client.post("/api/dingtalk-docs/sync")
        assert (
            response.status_code == status
        ), f"Directory sync returned {response.status_code}"
        return response

    def create_knowledge_base(self) -> int:
        _require_remote_services()
        _create_retrieval_resources(
            self.client, self.token, self.name, embedding_url=EMBEDDING_MODEL_URL
        )
        self.cleanup_paths.extend(
            [
                f"/api/v1/namespaces/default/models/{self.name}",
                f"/api/retrievers/{self.name}",
            ]
        )
        kb = _create_knowledge_base(self.client, self.token, self.name, self.name)
        self.knowledge_base_id = kb["id"]
        self.cleanup_paths.append(f"/api/knowledge-bases/{kb['id']}")
        return kb["id"]

    def import_document(self, node_id: str = "doc") -> dict[str, Any]:
        document = ok(
            self.client.post(
                f"/api/knowledge-bases/{self.knowledge_base_id}"
                "/documents/external-import",
                json={"provider": "dingtalk", "external_resource_id": node_id},
            ),
            201,
        )
        self.document_ids.add(document["id"])
        return document

    def evidence(self) -> dict[str, Any]:
        documents = []
        for document_id in sorted(self.document_ids):
            document = self.document(document_id)
            documents.append(
                {
                    "id": document_id,
                    "index_status": document["index_status"],
                    "index_generation": document["index_generation"],
                    "is_active": document["is_active"],
                    "error_code": (document.get("processing_error") or {}).get("code"),
                    "content_fingerprint": fingerprint(self.content(document_id)),
                }
            )
        return {
            "actor": self.name,
            "credentials": {
                service: self.snapshot(service)
                for service in ("docs", "table", "ai_table")
            },
            "documents": documents,
            "provider_events": [
                event
                for event in self.provider.events
                if event.get("actor") == self.name
            ],
        }

    def document(self, document_id: int) -> dict[str, Any]:
        return ok(self.client.get(f"/api/knowledge-documents/{document_id}"))

    def wait_document(
        self, document_id: int, expected: str = "success", marker: str | None = None
    ) -> dict[str, Any]:
        def settled() -> dict[str, Any] | None:
            document = self.document(document_id)
            if expected == "success" and document["index_status"] == "failed":
                raise AssertionError("Document indexing failed")
            if document["index_status"] != expected:
                return None
            if marker and marker not in self.content(document_id):
                return None
            return document

        return wait_until(
            settled, f"document {document_id} becomes {expected}", timeout=120
        )

    def content(self, document_id: int) -> str:
        return _chunk_contents(_document_chunks(self.client, self.token, document_id))

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [
            event
            for event in self.provider.events
            if event["kind"] == kind and event.get("actor") == self.name
        ]

    def assert_stored_grant(self, service: str = "docs") -> None:
        snapshot = self.snapshot(service)
        issued = [
            event for event in self.events("issued") if event["service"] == service
        ][-1]
        assert snapshot["access"] == issued["access"]
        assert snapshot["refresh"] == issued["refresh"]
        assert snapshot["expires_at"] > time.time()

    def close(self) -> None:
        self.provider.unblock()
        try:
            for path in reversed(self.cleanup_paths):
                response = self.client.delete(path)
                assert response.status_code in {
                    200,
                    204,
                }, f"Cleanup failed for {path}: HTTP {response.status_code}"
        finally:
            for browser in self.browsers:
                browser.close()
            self.client.close()


def wait_for_user_lock(actor: Actor, minimum: int = 1) -> None:
    def waiting() -> bool:
        with SessionLocal() as db:
            return (
                int(
                    db.scalar(
                        text(
                            "SELECT COUNT(DISTINCT w.REQUESTING_THREAD_ID) "
                            "FROM performance_schema.data_lock_waits w "
                            "JOIN performance_schema.data_locks l "
                            "ON w.BLOCKING_ENGINE_LOCK_ID=l.ENGINE_LOCK_ID "
                            "WHERE l.OBJECT_NAME='users' "
                            "AND l.INDEX_NAME='PRIMARY' AND l.LOCK_DATA=:id"
                        ),
                        {"id": str(actor.id)},
                    )
                    or 0
                )
                >= minimum
            )

    wait_until(waiting, "competing request waits on the user's InnoDB row", timeout=5)


async def send_chat(actor: Actor, team_id: int, prompt: str) -> int:
    client = socketio.AsyncClient(reconnection=False)
    try:
        await client.connect(
            BACKEND_URL,
            auth={"token": actor.token},
            namespaces=["/chat"],
            transports=["polling"],
        )
        ack = await client.call(
            "chat:send",
            {
                "team_id": team_id,
                "message": prompt,
                "additional_skills": [
                    {"name": "dingtalk-docs", "namespace": "default", "is_public": True}
                ],
            },
            namespace="/chat",
            timeout=30,
        )
        assert ack.get("task_id") and not ack.get("error"), "Chat send failed"
        return int(ack["task_id"])
    finally:
        if client.connected:
            await client.disconnect()


def create_chat_team(actor: Actor) -> int:
    name = actor.name + "-chat"
    ok(
        actor.client.post(
            "/api/v1/namespaces/default/models",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Model",
                "metadata": {"name": name, "namespace": "default"},
                "spec": {
                    "modelConfig": {
                        "env": {
                            "model": "openai",
                            "model_id": "mock-provider-native-model",
                            "api_key": "mock-api-key",
                            "base_url": f"{MOCK_MODEL_SERVER_URL}/v1",
                        }
                    }
                },
            },
        ),
        201,
    )
    actor.cleanup_paths.append(f"/api/v1/namespaces/default/models/{name}")
    bot = ok(
        actor.client.post(
            "/api/bots",
            json={
                "name": name,
                "shell_name": "Chat",
                "agent_config": {"bind_model": name, "bind_model_type": "user"},
                "system_prompt": (
                    "Read the DingTalk document using get_document_content."
                ),
                "namespace": "default",
                "is_active": True,
            },
        ),
        201,
    )
    actor.cleanup_paths.append(f"/api/v1/namespaces/default/bots/{name}")
    team = ok(
        actor.client.post(
            "/api/teams",
            json={
                "name": name,
                "bots": [{"bot_id": bot["id"], "bot_prompt": "", "role": "worker"}],
                "bind_mode": ["chat"],
                "namespace": "default",
                "is_active": True,
            },
        ),
        201,
    )
    actor.cleanup_paths.append(f"/api/v1/namespaces/default/teams/{name}")
    return team["id"]


def run_chat(actor: Actor, team_id: int) -> int:
    prompt = actor.name + "-read-marker"
    marker = actor.provider.marker(actor.name, "doc")
    with httpx.Client(base_url=MOCK_MODEL_SERVER_URL, timeout=10) as model:
        ok(
            model.post(
                "/tool-scenarios",
                json={
                    "matchText": prompt,
                    "steps": [
                        {
                            "toolCalls": [
                                {
                                    "toolName": "get_document_content",
                                    "arguments": {"nodeId": "doc"},
                                }
                            ]
                        },
                        {"responseContent": marker},
                    ],
                },
            )
        )
        try:
            task_id = asyncio.run(send_chat(actor, team_id, prompt))
            actor.cleanup_paths.append(f"/api/tasks/{task_id}")

            def completed() -> bool:
                response = ok(actor.client.get(f"/api/tasks/{task_id}/runtime-check"))
                state = response["task_status"].upper()
                assert state not in {"FAILED", "CANCELLED"}, "Chat task failed"
                return state == "COMPLETED"

            wait_until(completed, "real Chat Shell task completes")
            evidence = ok(model.get("/tool-scenarios", params={"matchText": prompt}))
            bodies = json.dumps(evidence["capturedRequests"])
            # The mock model's final answer is not evidence of a tool read.
            assert marker in bodies, "MCP result never returned to the model"
            final_task = ok(actor.client.get(f"/api/tasks/{task_id}"))
            assert marker in json.dumps(final_task), "Task did not persist the answer"
            return task_id
        finally:
            ok(model.delete("/tool-scenarios", params={"matchText": prompt}))
