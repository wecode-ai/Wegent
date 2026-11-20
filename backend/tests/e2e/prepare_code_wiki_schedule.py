# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Seed a stopped Wiki and a disabled plan in the disposable browser test DB."""

import os
import sys

from sqlalchemy.engine import make_url

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge import (
    CodeWikiScheduledUpdateRequest,
    KnowledgeBaseCreate,
)
from app.services.knowledge.code_wiki.registry import claim_repository
from app.services.knowledge.code_wiki.scheduled_update import configure_scheduled_update
from app.services.knowledge.code_wiki.source import SourceRepository
from app.services.knowledge.knowledge_service import KnowledgeService


def prepare_wiki(owner_name: str, name: str) -> int:
    database = make_url(settings.DATABASE_URL)
    local_e2e = (
        os.environ.get("WEGENT_LOCAL_E2E") == "1"
        and database.host == "127.0.0.1"
        and database.database == "task_manager"
    )
    if database.get_backend_name() != "mysql" or not (
        database.database == "wegent_test" or local_e2e
    ):
        raise RuntimeError(
            "Code Wiki browser fixtures require the CI or local E2E database"
        )

    with SessionLocal() as db:
        owner = db.query(User).filter(User.user_name == owner_name).one()
        missing_runner_id = 2**31 - 1
        if db.get(User, missing_runner_id) is not None:
            raise RuntimeError("Code Wiki test runner must be absent")
        source = SourceRepository.from_url(
            "github", f"https://github.com/example/{name}"
        )
        wiki_id = KnowledgeService.create_knowledge_base(
            db,
            owner.id,
            KnowledgeBaseCreate(
                name=name, kb_type="code_wiki", source=source.to_spec()
            ),
        )
        claim_repository(db, source, wiki_id)
        wiki = db.get(Kind, wiki_id)
        assert wiki is not None
        configure_scheduled_update(
            db,
            knowledge_base=wiki,
            data=CodeWikiScheduledUpdateRequest(
                enabled=False,
                hour=9,
                minute=0,
                execution_principal_user_id=missing_runner_id,
            ),
        )
        return wiki_id


if __name__ == "__main__":
    print(prepare_wiki(*sys.argv[1:]))
