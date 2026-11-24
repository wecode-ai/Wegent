# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Create a Code Wiki fixture without starting a generation job."""

import sys

from sqlalchemy.engine import make_url

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.user import User
from app.services.knowledge.code_wiki.source import SourceRepository
from app.services.knowledge.orchestrator import knowledge_orchestrator


def prepare_wiki(owner_name: str, name: str) -> int:
    database = make_url(settings.DATABASE_URL)
    # The existing local E2E runner uses the development Compose database.
    local_runner = (
        settings.ENVIRONMENT == "development"
        and database.host == "127.0.0.1"
        and database.database == "task_manager"
    )
    if database.get_backend_name() != "mysql" or not (
        database.database == "wegent_test" or local_runner
    ):
        raise RuntimeError("Code Wiki fixtures require the CI or local E2E database")

    with SessionLocal() as db:
        owner = db.query(User).filter(User.user_name == owner_name).one()
        wiki = knowledge_orchestrator.create_code_wiki(
            db,
            owner,
            name,
            source=SourceRepository.from_url(
                "github", f"https://github.com/example/{name}"
            ),
            rag_config_mode="disabled",
        )
        return wiki.id


if __name__ == "__main__":
    print(prepare_wiki(*sys.argv[1:]))
