# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Upload through the real hybrid gateway while real MySQL replication is paused.

CI runs this in Platform E2E shard 1. Supply isolated DATABASE_URL and
E2E_REPLICA_DATABASE_URL ending in /wegent_test, E2E_REPLICATION_SOURCE_HOST,
REDIS_URL, WEGENT_RS_BINARY_PATH, E2E_REPORT_DIR and E2E_EXPECTED_SHA.
No application services, SQL drivers, storage backends or HTTP calls are mocked.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import unittest
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import urlparse

from attachment_replica_fixture import ReplicaFixture, execute, gateway
from redis import Redis
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models import Kind, KnowledgeDocument, User


class AttachmentUploadReplica(unittest.TestCase):
    """Exercise committed upload responses with a stopped replica SQL thread."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.resources = ExitStack()
        cls.addClassCleanup(cls.resources.close)
        cls.report = Path(os.environ["E2E_REPORT_DIR"]).resolve()
        cls.report.mkdir(parents=True, exist_ok=True)
        broker = urlparse(os.environ["REDIS_URL"])
        assert broker.hostname in {
            "127.0.0.1",
            "localhost",
            "attachment-redis",
        }, "a dedicated local E2E Redis broker is required"
        assert broker.path in {"", "/0"}, "use database zero on the dedicated broker"
        cls.fixture = ReplicaFixture(cls.resources)
        (cls.report / "servers.json").write_text(
            json.dumps({"primary_and_replica_uuids": cls.fixture.server_uuids})
        )
        cls.password = secrets.token_urlsafe(24)
        with Session(cls.fixture.db, expire_on_commit=False) as db:
            cls.user = User(
                user_name="upload-replica-e2e",
                password_hash=get_password_hash(cls.password),
                role="user",
                auth_source="password",
                is_active=True,
            )
            db.add(cls.user)
            db.commit()
        cls.fixture.sync()
        cls.client = cls.resources.enter_context(gateway(cls.fixture, cls.report))
        login = cls.client.post(
            "/api/auth/login",
            json={"user_name": cls.user.user_name, "password": cls.password},
        )
        assert login.status_code == 200, f"login returned {login.status_code}"
        cls.headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
        cls.fixture.sync()

    def upload(self, name: str, content: bytes, context_id: int | None = None):
        """Send the public multipart request without replacing any dependencies."""
        params = {"storage_purpose": "default"}
        if context_id is not None:
            params["overwrite_attachment_id"] = str(context_id)
        return self.client.post(
            "/api/attachments/upload",
            params=params,
            headers=self.headers,
            files={"file": (name, content, "text/markdown")},
        )

    def assert_attachment(self, response, name: str, content: bytes) -> int:
        """Check the HTTP contract and actual committed bytes on the primary."""
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["filename"], name)
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["file_size"], len(content))
        self.assertEqual(body["text_length"], len(content.decode()))
        context_id = body["id"]
        row = self.fixture.attachment(context_id)
        self.assertEqual(row["name"], name)
        self.assertEqual(row["status"], "ready")
        self.assertEqual(row["binary_data"], content)
        self.assertEqual(json.loads(row["type_data"])["file_size"], len(content))
        return context_id

    def test_new_upload_returns_committed_row_when_replica_is_missing_it(self) -> None:
        """A new upload must return 200 even while its row cannot reach the replica."""
        with self.fixture.paused():
            since = self.fixture.mark()
            content = b"# New attachment\n\nCommitted primary content.\n"
            response = self.upload("new-primary.md", content)
            context_id = self.assert_attachment(response, "new-primary.md", content)
            self.assertIsNone(self.fixture.attachment(context_id, replica=True))
            self.fixture.assert_primary_refresh(context_id, since)

    def test_overwrite_returns_new_metadata_while_replica_remains_stale(self) -> None:
        """An overwrite must replace filename, status and size in its HTTP response."""
        old = b"old"
        context_id = self.assert_attachment(self.upload("old.md", old), "old.md", old)
        execute(
            self.fixture.primary,
            f"UPDATE `{self.fixture.database}`.subtask_contexts "
            "SET status='uploading' WHERE id=:id",
            id=context_id,
        )
        with self.fixture.paused():
            since = self.fixture.mark()
            content = b"# Replacement\n\nA larger version of the attachment.\n"
            response = self.upload("replacement.md", content, context_id)
            self.assertEqual(
                self.assert_attachment(response, "replacement.md", content), context_id
            )
            stale = self.fixture.attachment(context_id, replica=True)
            self.assertEqual(stale["name"], "old.md")
            self.assertEqual(stale["status"], "uploading")
            self.assertEqual(json.loads(stale["type_data"])["file_size"], len(old))
            self.fixture.assert_primary_refresh(context_id, since)

    def test_missing_primary_is_not_resurrected_by_a_lingering_replica_row(
        self,
    ) -> None:
        """A replica-only attachment cannot turn a missing primary row into success."""
        content = b"original"
        context_id = self.assert_attachment(
            self.upload("deleted.md", content), "deleted.md", content
        )
        with self.fixture.paused():
            execute(
                self.fixture.primary,
                f"DELETE FROM `{self.fixture.database}`.subtask_contexts WHERE id=:id",
                id=context_id,
            )
            self.assertIsNone(self.fixture.attachment(context_id))
            self.assertIsNotNone(self.fixture.attachment(context_id, replica=True))
            since = self.fixture.mark()
            response = self.upload("must-not-exist.md", b"replacement", context_id)
            self.assertEqual(response.status_code, 404, response.text)
            self.assertEqual(response.json(), {"detail": "Attachment not found"})
            self.assertIsNone(self.fixture.attachment(context_id))
            self.fixture.assert_primary_refresh(context_id, since)

    def conversion_document(self, attachment_id: int) -> tuple[int, int]:
        """Seed only the conversion input, using the application's real models."""
        with Session(self.fixture.db) as db:
            kb = Kind(
                kind="KnowledgeBase",
                name="upload-replica-conversion",
                namespace="default",
                user_id=self.user.id,
                is_active=True,
                json={"spec": {"type": "personal", "kbType": "classic"}},
            )
            db.add(kb)
            db.flush()
            document = KnowledgeDocument(
                kind_id=kb.id,
                attachment_id=attachment_id,
                user_id=self.user.id,
                name="original.md",
                file_extension="md",
                file_size=8,
                status="enabled",
                is_active=True,
                index_status="converting",
                index_generation=1,
            )
            db.add(document)
            db.commit()
            return document.id, kb.id

    def test_internal_conversion_upload_refreshes_the_primary_after_commit(
        self,
    ) -> None:
        """The real conversion callback must use the same primary upload refresh."""
        content = b"original"
        original_id = self.assert_attachment(
            self.upload("original.md", content), "original.md", content
        )
        document_id, kb_id = self.conversion_document(original_id)
        converted = b"# Converted\n\nReal internal attachment upload.\n"
        with self.fixture.paused():
            since = self.fixture.mark()
            response = self.client.post(
                "/api/internal/conversion/callback/completed",
                headers={
                    "Authorization": f"Bearer {os.environ['INTERNAL_SERVICE_TOKEN']}"
                },
                json={
                    "document_id": document_id,
                    "generation": 1,
                    "converted_name": "converted.md",
                    "converted_extension": "md",
                    "file_size": len(converted),
                    "markdown_bytes": base64.b64encode(converted).decode(),
                    "index_dispatch_payload": {
                        "attachment_id": original_id,
                        "document_id": document_id,
                        "knowledge_base_id": kb_id,
                        "index_generation": 1,
                    },
                },
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["ok"])
            self.assertFalse(response.json()["skipped"])
            self.assertTrue(response.json()["index_task_id"])
            document = (
                execute(
                    self.fixture.primary,
                    f"SELECT source_config, index_status FROM "
                    f"`{self.fixture.database}`.knowledge_documents WHERE id=:id",
                    id=document_id,
                )
                .mappings()
                .one()
            )
            self.assertEqual(document["index_status"], "queued")
            converted_id = json.loads(document["source_config"])[
                "converted_attachment_id"
            ]
            row = self.fixture.attachment(converted_id)
            self.assertEqual(row["name"], "converted.md")
            self.assertEqual(row["status"], "ready")
            self.assertEqual(row["binary_data"], converted)
            self.assertIsNone(self.fixture.attachment(converted_id, replica=True))
            self.fixture.assert_primary_refresh(converted_id, since, count=2)
            with Redis.from_url(os.environ["REDIS_URL"]) as broker:
                published = [
                    json.loads(message)
                    for message in broker.lrange("wegent_online", 0, -1)
                ]
            message = next(
                item
                for item in published
                if item["headers"]["id"] == response.json()["index_task_id"]
            )
            kwargs = json.loads(base64.b64decode(message["body"]))[1]
            self.assertEqual(kwargs["attachment_id"], converted_id)
            self.assertEqual(kwargs["document_id"], document_id)


if __name__ == "__main__":
    report = Path(os.environ["E2E_REPORT_DIR"]).resolve()
    report.mkdir(parents=True, exist_ok=True)
    repository = Path(__file__).resolve().parents[3]
    actual_sha = subprocess.check_output(
        [
            "git",
            "-c",
            f"safe.directory={repository}",
            "-C",
            str(repository),
            "rev-parse",
            "HEAD",
        ],
        text=True,
    ).strip()
    assert actual_sha == os.environ["E2E_EXPECTED_SHA"], "unexpected E2E checkout"
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(AttachmentUploadReplica)
    )
    success = result.wasSuccessful() and result.testsRun == 4 and not result.skipped
    (report / "result.json").write_text(
        json.dumps(
            {
                "sha": actual_sha,
                "tests": result.testsRun,
                "success": success,
                "skipped": len(result.skipped),
            }
        )
    )
    raise SystemExit(0 if success else 1)
