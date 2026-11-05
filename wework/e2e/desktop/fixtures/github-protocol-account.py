"""Seed synthetic account data; device synchronization uses the real API and CLI."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "backend"))

from app.db.session import SessionLocal  # noqa: E402
from app.models.user import User  # noqa: E402
from shared.utils.crypto import encrypt_git_token  # noqa: E402

with SessionLocal() as db:
    user = db.get(User, int(sys.argv[1]))
    assert user is not None
    assert not user.git_info or all(
        item.get("id") == "github-protocol-e2e" for item in user.git_info
    ), "Never replace unrelated accounts"
    user.git_info = (
        [
            {
                "id": "github-protocol-e2e",
                "type": "github",
                "git_domain": "github.com",
                "git_login": "wegent-e2e-synced",
                "git_email": "github-protocol@example.test",
                "git_token": encrypt_git_token("wegent-e2e-synced-protocol-token"),
            }
        ]
        if sys.argv[2] == "set"
        else []
    )
    db.commit()
