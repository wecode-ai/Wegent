# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""真实混合网关知识库回迁契约；由 GitHub CI 启动真实服务后执行。

Run with ``uv run --no-sync python tests/e2e/knowledge_python_gateway.py``.
Only fixture records are inserted directly. Every observed product operation,
including authentication, upload and MCP tool calls, uses the public gateway.
Do not run through the unit-test conftest, which installs service doubles.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import unittest
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from redis import Redis
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.api_key import APIKey
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.knowledge_artifact import KnowledgeArtifactRecord
from app.models.resource_member import ResourceMember
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.services.knowledge.external_document_access import (
    DOWNLOAD_TOKEN_HEADER,
    create_document_download_token,
)

BASE_URL = os.environ["E2E_API_URL"].rstrip("/")
COMMAND = "uv run --no-sync python tests/e2e/knowledge_python_gateway.py"


class KnowledgePythonGateway(unittest.TestCase):
    """Share real persistence fixtures without invoking indexing or generation."""

    @classmethod
    def setUpClass(cls) -> None:
        state = dict(
            line.split("=", 1)
            for line in Path(os.environ["WEGENT_HYBRID_STATE_FILE"])
            .read_text()
            .splitlines()
        )
        for process in ("rust", "python"):
            os.kill(int(state[process]), 0)
        assert urlparse(BASE_URL).port != int(state["python_port"])
        assert settings.DATABASE_URL.startswith("mysql"), "MySQL is required"
        cls.redis = Redis.from_url(os.environ["REDIS_URL"])
        assert cls.redis.ping(), "Redis is required"
        cls.client = httpx.Client(base_url=BASE_URL, timeout=30)
        cls.db = SessionLocal()
        cls.suffix = uuid.uuid4().hex[:12]
        cls.password = secrets.token_urlsafe(24)
        cls.users = [
            User(
                user_name=f"kb-gateway-{role}-{cls.suffix}",
                password_hash=get_password_hash(cls.password),
                role="user",
                auth_source="password",
                is_active=True,
            )
            for role in ("owner", "reader", "outsider")
        ]
        cls.db.add_all(cls.users)
        cls.db.commit()
        cls.headers = []
        cls.api_headers = []
        for user in cls.users:
            login = cls.client.post(
                "/api/auth/login",
                json={"user_name": user.user_name, "password": cls.password},
            )
            assert login.status_code == 200, f"login status: {login.status_code}"
            headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
            cls.headers.append(headers)
            key = cls.client.post(
                "/api/api-keys", headers=headers, json={"name": "gateway E2E"}
            )
            assert key.status_code == 201, f"API key status: {key.status_code}"
            cls.api_headers.append({"Authorization": f"Bearer {key.json()['key']}"})
        cls.kbs = []
        for name in ("main", "other", "empty"):
            kb = Kind(
                kind="KnowledgeBase",
                name=f"gateway-{name}-{cls.suffix}",
                namespace="default",
                user_id=cls.users[0].id,
                is_active=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "KnowledgeBase",
                    "metadata": {"name": f"gateway-{name}-{cls.suffix}"},
                    "spec": {
                        "description": "gateway E2E",
                        "type": "personal",
                        "kbType": "classic",
                        "summaryEnabled": False,
                        "allowDocumentDownload": True,
                    },
                },
            )
            cls.db.add(kb)
            cls.kbs.append(kb)
        cls.db.commit()
        cls.member = ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=cls.kbs[0].id,
            entity_type="user",
            entity_id=str(cls.users[1].id),
            role="Reporter",
            status="approved",
        )
        cls.folder = KnowledgeFolder(kind_id=cls.kbs[0].id, name="目录", parent_id=0)
        cls.db.add_all([cls.member, cls.folder])
        cls.db.commit()
        cls.content = "# 知识库真实文件\n\n网关保留中文、分页和原始字节。\n"
        upload = cls.client.post(
            "/api/attachments/upload",
            headers=cls.headers[0],
            files={"file": ("gateway.md", cls.content.encode(), "text/markdown")},
        )
        assert upload.status_code == 200, f"upload status: {upload.status_code}"
        cls.attachment_id = int(upload.json()["id"])
        cls.documents = []
        for index, kb in enumerate((cls.kbs[0], cls.kbs[0], cls.kbs[1])):
            document = KnowledgeDocument(
                kind_id=kb.id,
                attachment_id=cls.attachment_id,
                name=f"gateway-{index}.md",
                file_extension="md",
                file_size=len(cls.content.encode()),
                user_id=cls.users[0].id,
                status="enabled",
                is_active=True,
                index_status="success",
                folder_id=cls.folder.id if index == 0 else 0,
            )
            cls.db.add(document)
            cls.documents.append(document)
        cls.db.commit()

    @classmethod
    def tearDownClass(cls) -> None:
        ids = [user.id for user in cls.users]
        kb_ids = [kb.id for kb in cls.kbs]
        cls.db.rollback()
        cls.db.query(KnowledgeArtifactRecord).filter(
            KnowledgeArtifactRecord.knowledge_base_id.in_(kb_ids)
        ).delete(synchronize_session=False)
        cls.db.query(KnowledgeDocument).filter(
            KnowledgeDocument.kind_id.in_(kb_ids)
        ).delete(synchronize_session=False)
        cls.db.query(KnowledgeFolder).filter(
            KnowledgeFolder.kind_id.in_(kb_ids)
        ).delete(synchronize_session=False)
        cls.db.query(ResourceMember).filter(
            ResourceMember.resource_type == "KnowledgeBase",
            ResourceMember.resource_id.in_(kb_ids),
        ).delete(synchronize_session=False)
        cls.db.query(APIKey).filter(APIKey.user_id.in_(ids)).delete(
            synchronize_session=False
        )
        cls.db.query(Subtask).filter(Subtask.user_id.in_(ids)).delete(
            synchronize_session=False
        )
        cls.db.query(Kind).filter(Kind.id.in_(kb_ids)).delete(synchronize_session=False)
        cls.db.query(SubtaskContext).filter(
            SubtaskContext.id == cls.attachment_id
        ).delete(synchronize_session=False)
        cls.db.query(User).filter(User.id.in_(ids)).delete(synchronize_session=False)
        cls.db.commit()
        cls.db.close()
        cls.client.close()
        cls.redis.close()

    def get(self, path: str, *, actor: int = 0, **kwargs: Any) -> httpx.Response:
        return self.client.get(path, headers=self.headers[actor], **kwargs)

    def policy(self, allowed: bool) -> None:
        self.db.refresh(self.kbs[0])
        self.kbs[0].json["spec"]["allowDocumentDownload"] = allowed
        flag_modified(self.kbs[0], "json")
        self.db.commit()

    def tool(self, document_id: int, disposition: str, actor: int = 0) -> dict:
        response = self.client.post(
            "/api/mcp/knowledge-external/sse",
            headers={
                **self.api_headers[actor],
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2024-11-05",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "wegent_kb_get_document_download",
                    "arguments": {
                        "document_id": document_id,
                        "disposition": disposition,
                    },
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertNotIn("error", result)
        return json.loads(result["result"]["content"][0]["text"])

    def test_protection_and_private_cache(self) -> None:
        path = f"/api/knowledge-bases/{self.kbs[0].id}/document-protection"
        for allowed in (True, False):
            with self.subTest(allowed=allowed):
                try:
                    self.policy(allowed)
                    response = self.get(path, actor=1)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(
                        response.headers["cache-control"], "private, no-store"
                    )
                    self.assertEqual(
                        response.json(),
                        {
                            "original_download_allowed": allowed,
                            "watermark_text": (
                                None if allowed else self.users[1].user_name
                            ),
                        },
                    )
                finally:
                    self.policy(True)

    def test_lists_filters_pagination_and_folder_tree(self) -> None:
        kb_id = self.kbs[0].id
        paths = (
            ("/api/knowledge/documents", {"knowledge_base_id": kb_id}),
            (f"/api/knowledge-bases/{kb_id}/documents", {}),
        )
        for path, params in paths:
            with self.subTest(path=path):
                first = self.get(
                    path,
                    params={
                        **params,
                        "limit": 1,
                        "sort_by": "name",
                        "sort_order": "asc",
                    },
                )
                self.assertEqual(first.status_code, 200)
                page = first.json()
                self.assertEqual(page["total"], 2)
                self.assertEqual(page["returned_count"], 1)
                self.assertTrue(page["has_more"])
                second = self.get(
                    path,
                    params={
                        **params,
                        "limit": 1,
                        "offset": 1,
                        "sort_by": "name",
                        "sort_order": "asc",
                    },
                ).json()
                self.assertFalse(second["has_more"])
                self.assertNotEqual(page["items"][0]["id"], second["items"][0]["id"])
                filtered = self.get(
                    path,
                    params={
                        **params,
                        "keyword": "gateway-0",
                        "folder_id": self.folder.id,
                    },
                ).json()
                self.assertEqual(
                    [row["id"] for row in filtered["items"]], [self.documents[0].id]
                )
        folders = self.get(f"/api/knowledge-bases/{kb_id}/folders")
        self.assertEqual(folders.status_code, 200)
        self.assertEqual(folders.json()[0]["id"], self.folder.id)
        self.assertEqual(folders.json()[0]["total_document_count"], 1)

    def test_content_detail_and_cross_library_isolation(self) -> None:
        document = self.documents[0]
        response = self.get(
            f"/api/knowledge/documents/{document.id}/content",
            params={"offset": 2, "limit": 7},
        )
        self.assertEqual(response.status_code, 200)
        content = response.json()
        self.assertEqual(content["content"], self.content[2:9])
        self.assertEqual(content["kb_id"], self.kbs[0].id)
        self.assertEqual(content["index_status"], "success")
        self.assertEqual(content["returned_length"], 7)
        self.assertTrue(content["has_more"])
        detail = self.get(
            f"/api/knowledge-bases/{self.kbs[0].id}/documents/{document.id}/detail",
            params={"include_summary": "false"},
        )
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["content"], self.content)
        self.assertEqual(detail.json()["document_id"], document.id)
        wrong_library = self.get(
            f"/api/knowledge-bases/{self.kbs[1].id}/documents/{document.id}/detail"
        )
        self.assertEqual(wrong_library.status_code, 404)

    def test_artifact_empty_persisted_and_reopened(self) -> None:
        empty = self.get(f"/api/knowledge-bases/{self.kbs[2].id}/artifacts")
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.json()["items"], [])
        self.assertEqual(empty.json()["available_document_count"], 0)
        artifact_id = str(uuid.uuid4())
        completed = Subtask(
            user_id=self.users[0].id,
            task_id=0,
            team_id=0,
            title="E2E completed Artifact",
            bot_ids=[],
            role=SubtaskRole.ASSISTANT,
            status=SubtaskStatus.COMPLETED,
            result={"value": "# 已生成\n"},
        )
        self.db.add(completed)
        self.db.flush()
        self.db.add(
            KnowledgeArtifactRecord(
                artifact_id=artifact_id,
                knowledge_base_id=self.kbs[0].id,
                title="持久化产物",
                status="running",
                assistant_subtask_id=completed.id,
                source_document_ids=[self.documents[0].id],
                user_id=self.users[0].id,
            )
        )
        self.db.commit()
        path = f"/api/knowledge-bases/{self.kbs[0].id}/artifacts"
        for reopen in (False, True):
            with self.subTest(reopen=reopen):
                with httpx.Client(base_url=BASE_URL, timeout=30) as client:
                    response = client.get(path, headers=self.headers[1])
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertFalse(body["can_manage"])
                self.assertEqual(body["available_document_count"], 2)
                self.assertEqual(body["processing_document_count"], 0)
                item = next(
                    item for item in body["items"] if item["artifact_id"] == artifact_id
                )
                self.assertEqual(item["status"], "succeeded")
                self.assertEqual(item["content"], "# 已生成")
                self.assertEqual(item["source_document_ids"], [self.documents[0].id])
        # End MySQL's previous REPEATABLE READ snapshot before checking the
        # reconciliation transaction committed by the remote Python process.
        self.db.rollback()
        persisted = self.db.get(KnowledgeArtifactRecord, artifact_id)
        self.assertEqual(persisted.status, "succeeded")
        self.assertEqual(persisted.content, "# 已生成")

    def test_wiki_and_my_permission(self) -> None:
        wiki = self.get("/api/wiki/connections")
        self.assertEqual(wiki.status_code, 200)
        self.assertEqual(wiki.json()["connections"], [])
        self.assertIsInstance(wiki.json()["available_connectors"], list)
        path = f"/api/share/KnowledgeBase/{self.kbs[0].id}/my-permission"
        for actor, role, access in (
            (0, "Owner", True),
            (1, "Reporter", True),
            (2, None, False),
        ):
            with self.subTest(actor=actor):
                response = self.get(path, actor=actor)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["has_access"], access)
                self.assertEqual(response.json()["is_creator"], actor == 0)
                self.assertEqual(response.json()["role"], role)

    def test_anonymous_and_denied_permissions(self) -> None:
        kb_id, doc_id = self.kbs[0].id, self.documents[0].id
        paths = (
            (f"/api/knowledge-bases/{kb_id}/document-protection", {}, 404),
            (f"/api/knowledge-bases/{kb_id}/folders", {}, 404),
            (f"/api/knowledge-bases/{kb_id}/artifacts", {}, 404),
            ("/api/knowledge/documents", {"knowledge_base_id": kb_id}, 404),
            (f"/api/knowledge/documents/{doc_id}/content", {}, 403),
            (f"/api/knowledge-bases/{kb_id}/documents/{doc_id}/detail", {}, 403),
        )
        for path, params, denied in paths:
            with self.subTest(path=path):
                anonymous = self.client.get(path, params=params)
                self.assertEqual(anonymous.status_code, 401)
                self.assertEqual(
                    self.get(path, actor=2, params=params).status_code, denied
                )
        self.assertEqual(self.client.get("/api/wiki/connections").status_code, 401)
        self.assertEqual(
            self.client.get(
                f"/api/share/KnowledgeBase/{kb_id}/my-permission"
            ).status_code,
            401,
        )
        self.assertEqual(
            self.client.post("/api/mcp/knowledge-external/sse", json={}).status_code,
            401,
        )

    def test_mcp_download_formal_mount_bytes_tokens_and_policy(self) -> None:
        doc_id = self.documents[0].id
        for disposition in ("inline", "attachment"):
            with self.subTest(disposition=disposition):
                result = self.tool(doc_id, disposition, actor=1)
                self.assertEqual(
                    result["resource_url"],
                    f"/api/mcp/knowledge-external/documents/{doc_id}/file",
                )
                self.assertEqual(result["disposition"], disposition)
                self.assertEqual(result["expiration_seconds"], 300)
                self.assertIn(DOWNLOAD_TOKEN_HEADER, result["headers"])
                download = self.client.get(
                    result["resource_url"], headers=result["headers"]
                )
                self.assertEqual(download.status_code, 200)
                self.assertEqual(download.content, self.content.encode())
                self.assertTrue(
                    download.headers["content-disposition"].startswith(
                        disposition + ";"
                    )
                )
                self.assertEqual(download.headers["x-content-type-options"], "nosniff")
                self.assertTrue(
                    download.headers["content-type"].startswith("text/markdown")
                )
        url = result["resource_url"]
        self.assertEqual(self.client.get(url).status_code, 401)
        self.assertEqual(
            self.client.get(
                url, headers={DOWNLOAD_TOKEN_HEADER: "invalid"}
            ).status_code,
            401,
        )
        expired = create_document_download_token(
            user_id=self.users[1].id,
            document_id=doc_id,
            disposition="inline",
            expires_seconds=-1,
        )
        self.assertEqual(
            self.client.get(url, headers={DOWNLOAD_TOKEN_HEADER: expired}).status_code,
            401,
        )
        self.assertEqual(self.tool(doc_id, "inline", actor=2)["code"], "forbidden")
        mismatch = self.client.get(
            f"/api/mcp/knowledge-external/documents/{self.documents[1].id}/file",
            headers=result["headers"],
        )
        self.assertEqual(mismatch.status_code, 401)
        try:
            self.policy(False)
            blocked = self.client.get(url, headers=result["headers"])
            self.assertEqual(blocked.status_code, 404)
            self.assertEqual(blocked.json()["code"], "DOCUMENT_DOWNLOAD_DISABLED")
            self.assertEqual(
                self.tool(doc_id, "inline")["code"], "DOCUMENT_DOWNLOAD_DISABLED"
            )
        finally:
            self.policy(True)
        try:
            self.member.status = "rejected"
            self.db.commit()
            revoked = self.client.get(url, headers=result["headers"])
            self.assertEqual(revoked.status_code, 403)
            self.assertEqual(revoked.json()["code"], "forbidden")
        finally:
            self.member.status = "approved"
            self.db.commit()

    def test_mcp_real_redis_rate_limit(self) -> None:
        doc_id = self.documents[1].id
        result = self.tool(doc_id, "inline")
        limit = settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_REQUESTS
        self.assertTrue(settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED)
        self.assertGreater(limit, 0)
        # Populate the real limiter's two adjacent windows to avoid a clock-boundary
        # race; Redis and the application's limiter execute their production code.
        import time

        window_seconds = (
            settings.EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS
        )
        window = int(time.time() // window_seconds)
        keys = [
            f"external_kb_mcp:rate:download:user:{self.users[0].id}:document:{doc_id}:{value}"
            for value in (window, window + 1)
        ]
        try:
            for key in keys:
                self.redis.set(key, limit, ex=window_seconds * 2 + 1)
            response = self.client.get(
                result["resource_url"], headers=result["headers"]
            )
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.json()["code"], "rate_limited")
        finally:
            self.redis.delete(*keys)

    def test_z_all_migrated_gets_reached_real_python_process(self) -> None:
        kb_id, doc_id = self.kbs[0].id, self.documents[0].id
        paths = (
            f"/api/knowledge-bases/{kb_id}/document-protection",
            f"/api/knowledge-bases/{kb_id}/artifacts",
            "/api/knowledge/documents",
            f"/api/knowledge/documents/{doc_id}/content",
            f"/api/knowledge-bases/{kb_id}/documents/{doc_id}/detail",
            f"/api/knowledge-bases/{kb_id}/folders",
            f"/api/share/KnowledgeBase/{kb_id}/my-permission",
            "/api/wiki/connections",
            f"/api/mcp/knowledge-external/documents/{doc_id}/file",
        )
        # app.main's real request middleware writes before calling the handler;
        # its log proves the public requests reached the Python process even
        # though the retained Rust handlers could produce identical payloads.
        log = Path(os.environ["E2E_PYTHON_LOG"]).read_text()
        for path in paths:
            with self.subTest(path=path):
                self.assertIn(f"request : GET {path} ", log)
        evidence = {path: f"request : GET {path} " in log for path in paths}
        (Path(os.environ["E2E_REPORT_DIR"]) / "python-upstream.json").write_text(
            json.dumps(evidence, indent=2) + "\n"
        )


if __name__ == "__main__":
    sha = os.environ["E2E_TEST_SHA"]
    report_dir = Path(os.environ["E2E_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(KnowledgePythonGateway)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {
        "sha": sha,
        "command": COMMAND,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "success": result.wasSuccessful()
        and result.testsRun > 0
        and not result.skipped,
    }
    (report_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
