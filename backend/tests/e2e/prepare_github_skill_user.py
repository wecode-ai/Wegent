# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Seed real GitHub archive authentication in the disposable platform E2E DB.

The Actions installation token is kept outside Playwright requests and traces.
This prepares fixture data only; scans and imports still use the real Backend,
encrypted user integration settings and GitHub API without mocked providers.
"""

import os
import uuid

from sqlalchemy.engine import make_url

from app.core.config import settings
from app.core.security import get_password_hash
from app.db.session import SessionLocal
from app.models.user import User
from shared.utils.crypto import encrypt_git_token


def prepare_user() -> None:
    database = make_url(settings.DATABASE_URL)
    if database.get_backend_name() != "mysql" or database.database != "wegent_test":
        raise RuntimeError(
            "GitHub E2E credentials require the disposable wegent_test DB"
        )
    token = os.environ["GITHUB_TOKEN"]
    if not token:
        raise RuntimeError("GitHub E2E authentication requires the Actions token")
    name = os.environ.get("E2E_REGULAR_USER", "e2e-user")
    password = os.environ.get("E2E_REGULAR_PASSWORD", "Test@12345")
    with SessionLocal() as db:
        user = db.query(User).filter(User.user_name == name).one_or_none()
        if user is None:
            user = User(
                user_name=name,
                password_hash=get_password_hash(password),
                role="user",
                auth_source="password",
                is_active=True,
            )
            db.add(user)
        user.git_info = [
            {
                "id": str(uuid.uuid4()),
                "type": "github",
                "git_domain": "github.com",
                "git_token": encrypt_git_token(token),
            }
        ]
        db.commit()


if __name__ == "__main__":
    prepare_user()
