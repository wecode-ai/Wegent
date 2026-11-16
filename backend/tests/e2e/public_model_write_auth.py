# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public model write authorization through the real hybrid gateway.

Run directly, outside pytest's service-mocking conftest. The platform E2E job
supplies the running Rust/Python Backend, MySQL and Redis. Only isolated user
and model rows are seeded; all observed operations use the public gateway.
"""

from __future__ import annotations

import os
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
from redis import Redis

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User


class PublicModelWriteAuth(unittest.TestCase):
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
        base_url = os.environ["E2E_API_URL"].rstrip("/")
        assert urlparse(base_url).port != int(state["python_port"])
        assert settings.DATABASE_URL.startswith("mysql"), "Real MySQL is required"
        with Redis.from_url(os.environ["REDIS_URL"]) as redis:
            assert redis.ping(), "Real Redis is required"
        cls.client = httpx.Client(base_url=base_url, timeout=30, trust_env=False)
        cls.addClassCleanup(cls.client.close)

    def setUp(self) -> None:
        self.marker = f"public-model-auth-{uuid.uuid4().hex[:12]}"
        password = os.urandom(24).hex()
        with SessionLocal() as db:
            self.admin = User(
                user_name=f"{self.marker}-admin",
                password_hash=get_password_hash(password),
                role="admin",
                auth_source="password",
                is_active=True,
                git_info=[],
            )
            self.regular = User(
                user_name=f"{self.marker}-user",
                password_hash=get_password_hash(password),
                role="user",
                auth_source="password",
                is_active=True,
                git_info=[],
            )
            db.add_all([self.admin, self.regular])
            db.commit()
            db.refresh(self.admin)
            db.refresh(self.regular)
            self.user_ids = [self.admin.id, self.regular.id]
        self.addCleanup(self._cleanup)

        self.admin_headers = self._login(self.admin.user_name, password)
        self.regular_headers = self._login(self.regular.user_name, password)

    def _cleanup(self) -> None:
        with SessionLocal() as db:
            db.query(Kind).filter(
                Kind.kind == "Model",
                Kind.user_id == 0,
                Kind.namespace == "default",
                Kind.name.like(f"{self.marker}%"),
            ).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(self.user_ids)).delete(
                synchronize_session=False
            )
            db.commit()

    def _login(self, username: str, password: str) -> dict[str, str]:
        response = self.client.post(
            "/api/auth/login",
            json={"user_name": username, "password": password},
        )
        self.assertEqual(response.status_code, 200, "Real login must succeed")
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    def _create_model(self, headers: dict[str, str], name: str) -> httpx.Response:
        return self.client.post(
            "/api/models",
            headers=headers,
            json={
                "name": name,
                "config": {
                    "env": {
                        "model": "openai",
                        "model_id": "public-model-auth-e2e",
                        "api_key": "public-model-auth-e2e-key",
                        "base_url": "http://localhost:9999/v1",
                    }
                },
            },
        )

    def test_regular_user_cannot_write_public_models(self) -> None:
        create = self._create_model(self.regular_headers, f"{self.marker}-create")
        self.assertEqual(create.status_code, 403, "Create must require admin")

        batch = self.client.post(
            "/api/models/batch",
            headers=self.regular_headers,
            json=[
                {
                    "name": f"{self.marker}-batch",
                    "env": {
                        "model": "openai",
                        "model_id": "public-model-auth-e2e",
                        "api_key": "public-model-auth-e2e-key",
                        "base_url": "https://attacker.invalid/v1",
                    },
                }
            ],
        )
        self.assertEqual(batch.status_code, 403, "Bulk upsert must require admin")

        seeded = self._create_model(self.admin_headers, f"{self.marker}-guarded")
        self.assertEqual(seeded.status_code, 201, "Admin create must succeed")
        model_id = seeded.json()["id"]

        update = self.client.put(
            f"/api/models/{model_id}",
            headers=self.regular_headers,
            json={
                "config": {
                    "env": {
                        "model": "openai",
                        "model_id": "public-model-auth-e2e",
                        "api_key": "public-model-auth-e2e-key",
                        "base_url": "https://attacker.invalid/v1",
                    }
                }
            },
        )
        self.assertEqual(update.status_code, 403, "Update must require admin")

        delete = self.client.delete(
            f"/api/models/{model_id}", headers=self.regular_headers
        )
        self.assertEqual(delete.status_code, 403, "Delete must require admin")

        with SessionLocal() as db:
            model = db.query(Kind).filter(Kind.id == model_id).one()
            self.assertTrue(model.is_active, "Regular user must not delete the model")
            self.assertEqual(
                model.json["spec"]["modelConfig"]["env"]["base_url"],
                "http://localhost:9999/v1",
                "Regular user must not redirect model traffic",
            )

    def test_admin_can_create_and_delete_public_model(self) -> None:
        created = self._create_model(self.admin_headers, f"{self.marker}-admin")
        self.assertEqual(created.status_code, 201, "Admin create must succeed")
        model_id = created.json()["id"]

        deleted = self.client.delete(
            f"/api/models/{model_id}", headers=self.admin_headers
        )
        self.assertIn(deleted.status_code, (200, 204), "Admin delete must succeed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
