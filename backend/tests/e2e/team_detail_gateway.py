# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Team details through the real hybrid gateway, authentication and MySQL.

Run directly with uv, outside pytest's service-mocking conftest. The existing
platform E2E job supplies the running Rust/Python Backend, MySQL and Redis.
Only isolated fixture rows are prepared directly; every observed API operation
uses the public gateway. No product service is replaced or mocked.
"""

from __future__ import annotations

import copy
import os
import secrets
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
from app.models.resource_member import ResourceMember
from app.models.user import User
from shared.utils.crypto import encrypt_git_token


class TeamDetailGateway(unittest.TestCase):
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
        cls.python_log = Path(os.environ["E2E_PYTHON_LOG"])
        assert cls.python_log.is_file(), "Python process log is required"
        cls.client = httpx.Client(base_url=base_url, timeout=30, trust_env=False)
        cls.addClassCleanup(cls.client.close)

    def setUp(self) -> None:
        self.marker = f"team-detail-{uuid.uuid4().hex[:12]}"
        self.teams: list[tuple[int, int]] = []
        password = secrets.token_urlsafe(24)
        with SessionLocal() as db:
            users = [
                User(
                    user_name=f"{self.marker}-{role}",
                    password_hash=get_password_hash(password),
                    role="user",
                    auth_source="password",
                    is_active=True,
                    git_info=[],
                )
                for role in ("owner", "reader", "outsider")
            ]
            db.add_all(users)
            db.commit()
            self.user_ids = [user.id for user in users]
            names = [user.user_name for user in users]
        self.addCleanup(self._cleanup)
        self.headers = []
        for name in names:
            login = self.client.post(
                "/api/auth/login", json={"user_name": name, "password": password}
            )
            self.assertEqual(login.status_code, 200, "Real login must succeed")
            self.headers.append(
                {"Authorization": f"Bearer {login.json()['access_token']}"}
            )

    def _cleanup(self) -> None:
        with SessionLocal() as db:
            for team_id, owner_id in self.teams:
                db.query(ResourceMember).filter_by(
                    resource_type="Team", resource_id=team_id
                ).delete(synchronize_session=False)
                db.query(Kind).filter_by(
                    id=team_id,
                    kind="Team",
                    user_id=owner_id,
                    namespace="default",
                    name=self.marker,
                ).delete(synchronize_session=False)
            db.query(User).filter(User.id.in_(self.user_ids)).delete(
                synchronize_session=False
            )
            db.commit()

    def _create_team(self, owner_id: int) -> int:
        with SessionLocal() as db:
            team = Kind(
                user_id=owner_id,
                kind="Team",
                namespace="default",
                name=self.marker,
                is_active=True,
                json={
                    "apiVersion": "agent.wecode.io/v1",
                    "kind": "Team",
                    "metadata": {"name": self.marker, "namespace": "default"},
                    "spec": {"members": [], "collaborationModel": "solo"},
                    "status": {"state": "Available"},
                },
            )
            db.add(team)
            db.commit()
            team_id = team.id
        self.teams.append((team_id, owner_id))
        return team_id

    def _detail(self, team_id: int, user_index: int, status: int = 200) -> dict:
        response = self.client.get(
            f"/api/teams/{team_id}", headers=self.headers[user_index]
        )
        self.assertEqual(response.status_code, status, "Team detail HTTP status")
        self.assertIn(
            f"GET /api/teams/{team_id}",
            self.python_log.read_text(),
            "The public gateway must forward team details to the real Python handler",
        )
        return response.json()

    def test_system_team_without_author_returns_null_user(self) -> None:
        with SessionLocal() as db:
            self.assertIsNone(db.get(User, 0), "System owner must have no User row")
        team_id = self._create_team(0)

        detail = self._detail(team_id, 1)

        self.assertEqual(detail["id"], team_id)
        self.assertEqual(detail["name"], self.marker)
        self.assertEqual(detail["share_status"], 2)
        self.assertIsNone(detail["user"])

    def test_shared_team_preserves_credentials_and_survives_deleted_author(
        self,
    ) -> None:
        owner_id, reader_id, _ = self.user_ids
        team_id = self._create_team(owner_id)
        with SessionLocal() as db:
            owner = db.get(User, owner_id)
            owner.git_info = [
                {
                    "id": "team-detail-fixture",
                    "type": "personal",
                    "git_domain": "github.com",
                    "git_token": encrypt_git_token("team-detail-e2e-fixture-token"),
                }
            ]
            db.add(
                ResourceMember(
                    resource_type="Team",
                    resource_id=team_id,
                    entity_type="user",
                    entity_id=str(reader_id),
                    user_id=reader_id,
                    role="Reporter",
                    status="approved",
                )
            )
            db.commit()
            credentials = copy.deepcopy(owner.git_info)

        owner_detail = self._detail(team_id, 0)
        self.assertEqual(owner_detail["share_status"], 0)
        self.assertEqual(owner_detail["user"]["id"], owner_id)
        self.assertEqual(len(owner_detail["user"]["git_info"]), 1)
        shared = self._detail(team_id, 1)
        self.assertEqual(shared["user"]["id"], owner_id)
        self.assertEqual(shared["user"]["git_info"], [])
        self._detail(team_id, 2, 404)
        with SessionLocal() as db:
            owner = db.get(User, owner_id)
            self.assertEqual(owner.git_info, credentials)
            db.delete(owner)
            db.commit()

        detail = self._detail(team_id, 1)

        self.assertEqual(detail["id"], team_id)
        self.assertEqual(detail["share_status"], 2)
        self.assertIsNone(detail["user"])
        self._detail(team_id, 2, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
