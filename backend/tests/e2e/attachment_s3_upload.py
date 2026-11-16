# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Upload through the production Rust handler to real MySQL, Redis and MinIO.

The dedicated CI job supplies the real S3 application assembly and services.
No object-store, HTTP, persistence or upload implementation is replaced. A real
MinIO user policy denies the second part by its SHA256 to exercise rollback.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse

import boto3
import httpx
from minio import Minio, MinioAdmin
from minio.credentials import StaticProvider
from redis import Redis

from app.core.config import settings
from app.core.security import create_access_token, get_password_hash
from app.db.session import SessionLocal
from app.models.subtask_context import SubtaskContext
from app.models.user import User

PART_SIZE = 5 * 1024 * 1024
REJECTED_PART = b"rejected second part"
ROOT = Path(__file__).resolve().parents[3]
REPORT = Path(os.environ["E2E_REPORT_DIR"])
COMMAND = "uv run --no-sync python tests/e2e/attachment_s3_upload.py"


class AttachmentS3Upload(unittest.TestCase):
    """Exercise the configured S3 backend, authentication and public routes."""

    @classmethod
    def setUpClass(cls) -> None:
        REPORT.mkdir(parents=True, exist_ok=True)
        assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        endpoint = urlparse(os.environ["E2E_MINIO_URL"])
        assert endpoint.scheme == "http", "Use the disposable local MinIO"
        root_key = os.environ["E2E_MINIO_ROOT_USER"]
        root_secret = os.environ["E2E_MINIO_ROOT_PASSWORD"]
        cls.store = Minio(
            endpoint.netloc, access_key=root_key, secret_key=root_secret, secure=False
        )
        cls.s3 = boto3.client(
            "s3",
            endpoint_url=endpoint.geturl(),
            region_name="us-east-1",
            aws_access_key_id=root_key,
            aws_secret_access_key=root_secret,
        )
        cls.addClassCleanup(cls.s3.close)
        cls.admin = MinioAdmin(
            endpoint=endpoint.netloc,
            secure=False,
            credentials=StaticProvider(root_key, root_secret),
        )
        cls.suffix = uuid.uuid4().hex
        cls.bucket = f"attachment-e2e-{cls.suffix}"
        cls.store.make_bucket(cls.bucket)
        cls.addClassCleanup(cls._clean_bucket)
        # Root credentials can bypass IAM; product requests use a real user.
        access_key = f"attachment-{cls.suffix}"
        secret_key = secrets.token_urlsafe(32)
        cls.admin.user_add(access_key, secret_key)
        cls.addClassCleanup(cls._clean_identity, access_key)
        policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Action": ["s3:*"],
                    "Resource": [
                        f"arn:aws:s3:::{cls.bucket}",
                        f"arn:aws:s3:::{cls.bucket}/*",
                    ],
                },
                {
                    "Effect": "Deny",
                    "Action": ["s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{cls.bucket}/*"],
                    "Condition": {
                        "StringEquals": {
                            "s3:x-amz-content-sha256": hashlib.sha256(
                                REJECTED_PART
                            ).hexdigest(),
                        }
                    },
                },
            ],
        }
        cls.admin.policy_add(access_key, policy=policy)
        cls.admin.policy_set(access_key, user=access_key)
        cls.db = SessionLocal()
        cls.addClassCleanup(cls.db.close)
        password = secrets.token_urlsafe(24)
        user = User(
            user_name=f"s3-upload-{cls.suffix}",
            password_hash=get_password_hash(password),
            role="user",
            auth_source="password",
            is_active=True,
        )
        cls.db.add(user)
        cls.db.commit()
        cls.user_id = user.id
        cls.addClassCleanup(cls._clean_database)
        cls.log_paths = [
            REPORT / "rust-logs" / name for name in ("info.log", "error.log")
        ]
        cls.evidence: list[dict] = []
        cls._start_backend(endpoint.geturl(), access_key, secret_key)
        # The product verifies this fixture JWT and loads the real MySQL user.
        token = create_access_token(data={"sub": user.user_name, "user_id": user.id})
        cls.headers = {"Authorization": f"Bearer {token}"}

    @classmethod
    def _start_backend(cls, endpoint: str, access_key: str, secret_key: str) -> None:
        empty_env = REPORT / "empty.env"
        empty_env.write_text(
            "# Isolated E2E configuration comes from the environment.\n"
        )
        environment = dict(
            os.environ,
            ATTACHMENT_STORAGE_BACKEND="s3",
            ATTACHMENT_ENCRYPTION_ENABLED="false",
            ATTACHMENT_S3_ENDPOINT=endpoint,
            ATTACHMENT_S3_ACCESS_KEY=access_key,
            ATTACHMENT_S3_SECRET_KEY=secret_key,
            ATTACHMENT_S3_BUCKET=cls.bucket,
            ATTACHMENT_S3_REGION="us-east-1",
            WEGENT_BACKEND_RS_ENV_FILE=str(empty_env),
            WEGENT_RS_ROUTES_FILE=str(ROOT / "backend-rs/config/routes.toml"),
            WEGENT_RS_LISTEN_HOST="127.0.0.1",
            WEGENT_RS_LISTEN_PORT="0",
            WEGENT_PYTHON_UPSTREAM_URL="http://127.0.0.1:1",
            EXECUTOR_MANAGER_URL="http://127.0.0.1:1",
            BREEZE_LOG_DIR=str(REPORT / "rust-logs"),
            RUST_LOG="info,wegent_backend_rs::attachments::upload::s3=debug",
        )
        log = (REPORT / "backend.log").open("wb")
        cls.addClassCleanup(log.close)
        cls.process = subprocess.Popen(
            [os.environ["WEGENT_RS_BINARY_PATH"]],
            cwd=ROOT,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        cls.addClassCleanup(cls._stop_backend)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            assert cls.process.poll() is None, "Rust Backend exited during startup"
            info_log = REPORT / "rust-logs" / "info.log"
            started = re.search(
                r"Wegent migration gateway started listen=(127\.0\.0\.1:\d+)",
                info_log.read_text() if info_log.exists() else "",
            )
            if not started:
                time.sleep(0.1)
                continue
            if not hasattr(cls, "client"):
                cls.client = httpx.Client(
                    base_url=f"http://{started.group(1)}", timeout=60, trust_env=False
                )
                cls.addClassCleanup(cls.client.close)
            try:
                response = cls.client.get("/api/attachments/0/download")
                if response.status_code == 401:
                    return
            except httpx.ConnectError:
                pass
            time.sleep(0.1)
        raise AssertionError("Rust Backend did not become ready")

    @classmethod
    def _stop_backend(cls) -> None:
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=10)

    @classmethod
    def _clean_database(cls) -> None:
        cls.db.rollback()
        cls.db.query(SubtaskContext).filter(
            SubtaskContext.user_id == cls.user_id
        ).delete()
        cls.db.query(User).filter(User.id == cls.user_id).delete()
        cls.db.commit()

    @classmethod
    def _clean_identity(cls, access_key: str) -> None:
        cls.admin.user_remove(access_key)
        cls.admin.policy_remove(access_key)

    @classmethod
    def _clean_bucket(cls) -> None:
        for item in cls.store.list_objects(cls.bucket, recursive=True):
            cls.store.remove_object(cls.bucket, item.object_name)
        cls.store.remove_bucket(cls.bucket)

    def setUp(self) -> None:
        self.log_offsets = [path.stat().st_size for path in self.log_paths]

    def _logs(self, required: dict[str, int]) -> str:
        # Breeze flushes asynchronously once per second; wait for evidence,
        # without repeating any upload or changing its business outcome.
        deadline = time.monotonic() + 5
        while True:
            lines = []
            for path, offset in zip(self.log_paths, self.log_offsets):
                with path.open("rb") as log:
                    log.seek(offset)
                    lines.append(log.read().decode(errors="replace"))
            text = "\n".join(lines)
            if (
                all(text.count(item) >= count for item, count in required.items())
                or time.monotonic() >= deadline
            ):
                return text
            time.sleep(0.05)

    def _round_trip(self, size: int, expected_parts: int) -> None:
        content = (b"real-s3-upload-0123456789\n" * (size // 24 + 1))[:size]
        self.assertEqual(len(content), size)
        filename = f"{self._testMethodName}-{self.suffix}.txt"
        response = self.client.post(
            "/api/attachments/upload",
            headers=self.headers,
            files={"file": (filename, content, "text/plain")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["status"], "ready")
        self.db.rollback()
        row = self.db.query(SubtaskContext).filter_by(id=result["id"]).one()
        self.assertEqual(row.type_data["storage_backend"], "minio")
        self.assertFalse(row.binary_data, "S3 upload must not retain MySQL bytes")
        stat = self.store.stat_object(self.bucket, row.type_data["storage_key"])
        self.assertEqual(stat.size, size)
        if expected_parts > 1:
            self.assertTrue(stat.etag.endswith(f"-{expected_parts}"), stat.etag)
        else:
            self.assertEqual(stat.etag, hashlib.md5(content).hexdigest())
        download = self.client.get(
            f"/api/attachments/{row.id}/download", headers=self.headers
        )
        self.assertEqual(download.status_code, 200)
        self.assertEqual(download.content, content)
        stages = (
            ["put_object"]
            if expected_parts == 1
            else [
                "create_multipart_upload",
                *("upload_part" for _ in range(expected_parts)),
                "complete_multipart_upload",
            ]
        )
        logs = self._logs(
            {f'stage="{stage}"': stages.count(stage) for stage in set(stages)}
        )
        for stage in set(stages):
            self.assertEqual(logs.count(f'stage="{stage}"'), stages.count(stage), logs)
        self.evidence.append(
            {
                "case": self._testMethodName,
                "size": size,
                "parts": expected_parts,
                "etag": stat.etag,
                "sha256": hashlib.sha256(download.content).hexdigest(),
                "stages": stages,
            }
        )

    def test_below_multipart_threshold(self) -> None:
        self._round_trip(PART_SIZE - 1, 1)

    def test_at_multipart_threshold(self) -> None:
        self._round_trip(PART_SIZE, 1)

    def test_above_multipart_threshold(self) -> None:
        self._round_trip(2 * PART_SIZE + 19, 3)

    def test_part_rejection_rolls_back_attachment(self) -> None:
        content = b"a" * PART_SIZE + REJECTED_PART
        objects_before = [
            item.object_name
            for item in self.store.list_objects(self.bucket, recursive=True)
        ]
        filename = f"rejected-{self.suffix}.txt"
        response = self.client.post(
            "/api/attachments/upload",
            headers=self.headers,
            files={"file": (filename, content, "text/plain")},
        )
        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(response.json(), {"detail": "Failed to upload attachment"})
        self.db.rollback()
        self.assertEqual(
            self.db.query(SubtaskContext)
            .filter_by(user_id=self.user_id, name=filename)
            .count(),
            0,
        )
        self.assertEqual(
            [
                item.object_name
                for item in self.store.list_objects(self.bucket, recursive=True)
            ],
            objects_before,
        )
        self._assert_part_rejection_logs()
        self.assertEqual(
            self.s3.list_multipart_uploads(Bucket=self.bucket).get("Uploads", []), []
        )
        self.evidence.append(
            {
                "case": self._testMethodName,
                "status": 500,
                "error_stage": "upload_part",
                "s3_code": "AccessDenied",
                "attachment_rows": 0,
                "completed_objects_added": 0,
                "abort": True,
                "incomplete_uploads": 0,
            }
        )

    def _assert_part_rejection_logs(self) -> None:
        required = {
            'stage="create_multipart_upload"': 1,
            'stage="upload_part"': 2,
            'stage="abort_multipart_upload"': 1,
            's3_code="AccessDenied"': 1,
            "status=403": 1,
            "attachment storage write failed": 1,
        }
        logs = self._logs(required)
        for expected in required:
            self.assertIn(expected, logs)
        self.assertNotIn('stage="complete_multipart_upload"', logs)
        successful = [
            line
            for line in logs.splitlines()
            if "attachment S3 request succeeded" in line
        ]
        self.assertEqual(sum('stage="upload_part"' in line for line in successful), 1)
        self.assertTrue(
            any('stage="abort_multipart_upload"' in line for line in successful)
        )

    @classmethod
    def tearDownClass(cls) -> None:
        (REPORT / "evidence.json").write_text(json.dumps(cls.evidence, indent=2) + "\n")


if __name__ == "__main__":
    REPORT.mkdir(parents=True, exist_ok=True)
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(AttachmentS3Upload)
    )
    report = {
        "sha": os.environ["E2E_TEST_SHA"],
        "command": COMMAND,
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "success": result.wasSuccessful()
        and result.testsRun == 4
        and not result.skipped,
    }
    (REPORT / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
    sys.exit(0 if report["success"] else 1)
