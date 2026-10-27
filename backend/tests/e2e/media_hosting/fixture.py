# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real service and resource assembly shared by the hosting E2E scenarios."""

import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
from minio import Minio, MinioAdmin
from minio.credentials import StaticProvider
from redis import Redis

from app.core.config import settings
from app.core.security import create_access_token, get_password_hash
from app.db.session import SessionLocal
from app.models import Kind, Subtask, SubtaskContext, TaskResource, User
from app.models.subtask import SubtaskRole, SubtaskStatus

from .model import ModelServer

ROOT = Path(__file__).resolve().parents[4]
REPORT = Path(os.environ["E2E_REPORT_DIR"]).resolve()


def free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


class HostingFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        REPORT.mkdir(parents=True, exist_ok=True)
        assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"
        assert not settings.ATTACHMENT_PUBLIC_BASE_URL, "Public URL must remain unset"
        cls.redis = Redis.from_url(os.environ["REDIS_URL"])
        cls.addClassCleanup(cls.redis.close)
        assert cls.redis.ping(), "Real Redis is required"
        cls.evidence = []
        cls.suffix = uuid.uuid4().hex
        cls.bucket = f"media-hosting-{cls.suffix}"
        endpoint = urlparse(os.environ["E2E_MINIO_URL"])
        assert endpoint.hostname in {"127.0.0.1", "localhost"}, "Use disposable MinIO"
        root_key = os.environ["E2E_MINIO_ROOT_USER"]
        root_secret = os.environ["E2E_MINIO_ROOT_PASSWORD"]
        cls.store = Minio(
            endpoint.netloc, access_key=root_key, secret_key=root_secret, secure=False
        )
        cls.store.make_bucket(cls.bucket)
        cls.addClassCleanup(cls.clean_bucket)
        cls.store.set_bucket_policy(
            cls.bucket,
            json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Principal": {"AWS": ["*"]},
                            "Action": ["s3:GetObject"],
                            "Resource": [f"arn:aws:s3:::{cls.bucket}/*"],
                        }
                    ],
                }
            ),
        )
        cls.media = cls.create_media()
        cls.admin = MinioAdmin(
            endpoint=endpoint.netloc,
            secure=False,
            credentials=StaticProvider(root_key, root_secret),
        )
        cls.access_key = "media-" + cls.suffix
        cls.secret_key = secrets.token_urlsafe(32)
        cls.admin.user_add(cls.access_key, cls.secret_key)
        cls.addClassCleanup(cls.clean_identity)
        cls.admin.policy_add(
            cls.access_key,
            policy={
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
                                    cls.media["denied"]
                                ).hexdigest()
                            }
                        },
                    },
                ],
            },
        )
        cls.admin.policy_set(cls.access_key, user=cls.access_key)
        cls.model = ModelServer()
        cls.addClassCleanup(cls.model.close)
        cls.seed_resources()
        cls.start_application()

    @classmethod
    def create_media(cls) -> dict[str, bytes]:
        media = {}
        for name, source, codec, extension in (
            ("video", "color=c=red:s=64x64:r=10:d=1", "mpeg4", "mp4"),
            ("denied", "color=c=blue:s=64x64:r=10:d=1", "mpeg4", "mp4"),
            ("audio", "sine=frequency=440:duration=1", "pcm_s16le", "wav"),
        ):
            path = REPORT / f"{name}.{extension}"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    source,
                    "-c:v" if extension == "mp4" else "-c:a",
                    codec,
                    "-y",
                    str(path),
                ],
                check=True,
            )
            media[name] = path.read_bytes()
        return media

    @classmethod
    def seed_resources(cls) -> None:
        with SessionLocal() as db:
            users = [
                User(
                    user_name=f"media-{name}-{cls.suffix}",
                    password_hash=get_password_hash(secrets.token_urlsafe(24)),
                    role="user",
                    auth_source="password",
                    is_active=True,
                )
                for name in ("owner", "other")
            ]
            db.add_all(users)
            db.flush()
            cls.user_id, cls.other_id = [user.id for user in users]
            cls.user_name = users[0].user_name
            cls.jwt = create_access_token(
                data={"sub": cls.user_name, "user_id": cls.user_id}
            )
            cls.other_jwt = create_access_token(
                data={"sub": users[1].user_name, "user_id": cls.other_id}
            )
            cls.headers = {"Authorization": f"Bearer {cls.jwt}"}
            specs = {
                "Ghost": {"systemPrompt": "Generate a video from the user's media."},
                "Shell": {"shellType": "Chat", "requiresWorkspace": False},
                "Model": {
                    "modelType": "video",
                    "protocol": "seedance",
                    "modelConfig": {
                        "env": {
                            "model": "openai",
                            "model_id": "seedance-e2e",
                            "base_url": f"http://127.0.0.1:{cls.model.server_port}",
                            "api_key": "e2e-model-key",
                        }
                    },
                    "videoConfig": {
                        "capabilities": {
                            "supports_video_input": True,
                            "supports_audio_input": True,
                            "supports_image_input": True,
                        }
                    },
                },
                "Bot": {
                    "ghostRef": {"name": cls.suffix},
                    "shellRef": {"name": cls.suffix},
                    "modelRef": {"name": cls.suffix},
                },
                "Team": {
                    "collaborationModel": "solo",
                    "members": [{"botRef": {"name": cls.suffix}}],
                    "requiresWorkspace": False,
                    "bind_mode": ["video"],
                },
            }
            cls.resources = {}
            for kind, spec in specs.items():
                resource = Kind(
                    kind=kind,
                    name=cls.suffix,
                    namespace="default",
                    user_id=cls.user_id,
                    is_active=True,
                    json={
                        "apiVersion": "agent.wecode.io/v1",
                        "kind": kind,
                        "metadata": {"name": cls.suffix, "namespace": "default"},
                        "spec": spec,
                    },
                )
                db.add(resource)
                db.flush()
                cls.resources[kind] = resource.id
            db.commit()
        cls.addClassCleanup(cls.clean_database)

    @classmethod
    def start_application(cls) -> None:
        python_port, rust_port = free_port(), free_port()
        cls.url = f"http://127.0.0.1:{rust_port}"
        empty_env = REPORT / "empty.env"
        empty_env.write_text("")
        environment = dict(
            os.environ,
            E2E_MEDIA_BUCKET=cls.bucket,
            ATTACHMENT_PUBLIC_BASE_URL="",
            ATTACHMENT_STORAGE_BACKEND="media_minio",
            ATTACHMENT_ENCRYPTION_ENABLED="false",
            ATTACHMENT_S3_ENDPOINT=os.environ["E2E_MINIO_URL"],
            ATTACHMENT_S3_BUCKET=cls.bucket,
            ATTACHMENT_S3_ACCESS_KEY=cls.access_key,
            ATTACHMENT_S3_SECRET_KEY=cls.secret_key,
            ATTACHMENT_S3_REGION="us-east-1",
            WEGENT_BACKEND_RS_ENV_FILE=str(empty_env),
            WEGENT_RS_ROUTES_FILE=str(ROOT / "backend-rs/config/routes.toml"),
            WEGENT_RS_LISTEN_HOST="127.0.0.1",
            WEGENT_RS_LISTEN_PORT=str(rust_port),
            WEGENT_PYTHON_UPSTREAM_URL=f"http://127.0.0.1:{python_port}",
            BREEZE_LOG_DIR=str(REPORT / "rust"),
            LOG_DIR=str(REPORT / "python"),
            EMBEDDED_CELERY_ENABLED="false",
            SCHEDULED_TASKS_ENABLED="false",
            DB_AUTO_MIGRATE="false",
            INIT_DATA_ENABLED="false",
            CHECK_SYSTEM_INITIALIZATION_STATUS="false",
            DB_POOL_SIZE="1",
            DB_MAX_OVERFLOW="0",
            DB_POOL_TIMEOUT="2",
            EXECUTOR_MANAGER_URL="http://127.0.0.1:1",
            RUST_LOG="info",
        )
        cls.launch(
            "python",
            [
                sys.executable,
                "-m",
                "uvicorn",
                "media_hosting.application:app",
                "--app-dir",
                "tests/e2e",
                "--host",
                "127.0.0.1",
                "--port",
                str(python_port),
            ],
            environment,
            ROOT / "backend",
        )
        cls.launch(
            "rust", [os.environ["WEGENT_HOSTING_BINARY_PATH"]], environment, ROOT
        )
        cls.client = httpx.Client(base_url=cls.url, timeout=45, trust_env=False)
        cls.addClassCleanup(cls.client.close)
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                if cls.client.get("/api/health").status_code == 200:
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.2)
        raise AssertionError("Hybrid Backend startup failed; inspect process logs")

    @classmethod
    def launch(
        cls, name: str, command: list[str], environment: dict[str, str], cwd: Path
    ) -> None:
        log = (REPORT / f"{name}.log").open("w")
        cls.addClassCleanup(log.close)
        process = subprocess.Popen(
            command, cwd=cwd, env=environment, stdout=log, stderr=subprocess.STDOUT
        )
        cls.addClassCleanup(cls.stop, process)

    @staticmethod
    def stop(process: subprocess.Popen) -> None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)

    @classmethod
    def clean_bucket(cls) -> None:
        for item in cls.store.list_objects(cls.bucket, recursive=True):
            cls.store.remove_object(cls.bucket, item.object_name)
        cls.store.remove_bucket(cls.bucket)

    @classmethod
    def clean_identity(cls) -> None:
        cls.admin.user_remove(cls.access_key)
        cls.admin.policy_remove(cls.access_key)

    @classmethod
    def clean_database(cls) -> None:
        with SessionLocal() as db:
            for model in (SubtaskContext, Subtask, TaskResource, Kind, User):
                key = model.id if model is User else model.user_id
                db.query(model).filter(key.in_([cls.user_id, cls.other_id])).delete(
                    synchronize_session=False
                )
            db.commit()

    def upload(
        self,
        filename: str,
        content: bytes,
        purpose: str = "default",
        token: str | None = None,
    ) -> httpx.Response:
        return self.client.post(
            "/api/attachments/upload",
            params={"storage_purpose": purpose},
            headers={"Authorization": f"Bearer {token or self.jwt}"},
            files={"file": (filename, content, "application/octet-stream")},
        )

    def objects(self) -> set[str]:
        return {
            item.object_name
            for item in self.store.list_objects(self.bucket, recursive=True)
        }

    def attachment(self, attachment_id: int) -> SubtaskContext:
        with SessionLocal() as db:
            row = db.get(SubtaskContext, attachment_id)
            db.expunge(row)
            return row

    def new_tool_task(self) -> tuple[int, int]:
        with SessionLocal() as db:
            name = "media-tool-" + uuid.uuid4().hex
            task = TaskResource(
                user_id=self.user_id,
                kind="Task",
                name=name,
                namespace="default",
                is_active=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Task",
                    "metadata": {"name": name, "namespace": "default"},
                    "spec": {
                        "title": name,
                        "prompt": name,
                        "teamRef": {"name": self.suffix},
                        "workspaceRef": {"name": "empty"},
                    },
                    "status": {"status": "RUNNING"},
                },
            )
            db.add(task)
            db.flush()
            subtask = Subtask(
                user_id=self.user_id,
                task_id=task.id,
                team_id=self.resources["Team"],
                title=name,
                bot_ids=[self.resources["Bot"]],
                role=SubtaskRole.ASSISTANT,
                status=SubtaskStatus.RUNNING,
            )
            db.add(subtask)
            db.commit()
            return task.id, subtask.id

    @classmethod
    def tearDownClass(cls) -> None:
        (REPORT / "evidence.json").write_text(json.dumps(cls.evidence, indent=2) + "\n")
