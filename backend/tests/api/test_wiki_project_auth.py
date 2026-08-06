# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for wiki project detail endpoint authentication and access control.

Guards against a security bypass where GET /api/wiki/projects/{id} skipped
authentication entirely and performed no repository-access filtering, allowing
any caller to read any project by enumerating IDs.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import get_wiki_db
from app.models.wiki import WikiProject


def _create_project(
    db: Session, source_url: str = "http://git.example.com/a/b.git"
) -> WikiProject:
    project = WikiProject(
        project_name="acme/repo",
        project_type="git",
        source_type="gitlab",
        source_url=source_url,
        source_id="12345",
        source_domain="git.example.com",
        description="",
        ext={},
        is_active=True,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@pytest.fixture
def wiki_client(test_client: TestClient, test_db: Session) -> TestClient:
    """Client whose get_wiki_db is routed to the shared test session.

    Clears the override on teardown so it cannot leak into other tests even if
    test_client ever becomes broader-scoped.
    """

    def override_get_wiki_db():
        yield test_db

    test_client.app.dependency_overrides[get_wiki_db] = override_get_wiki_db
    yield test_client
    test_client.app.dependency_overrides.pop(get_wiki_db, None)


class TestWikiProjectDetailAuth:
    def test_detail_no_auth_returns_401(
        self, wiki_client: TestClient, test_db: Session
    ) -> None:
        """Without a token the detail endpoint must reject before any DB access."""
        project = _create_project(test_db)

        response = wiki_client.get(f"/api/wiki/projects/{project.id}")

        assert response.status_code == 401

    def test_detail_missing_project_no_auth_returns_401(
        self, test_client: TestClient
    ) -> None:
        """A non-existent id without a token must still be 401, not 404.

        A 404 here would prove auth was skipped and the DB was queried.
        """
        response = test_client.get("/api/wiki/projects/999999")

        assert response.status_code == 401

    def test_detail_without_repo_access_returns_404(
        self, wiki_client: TestClient, test_db: Session, test_token: str
    ) -> None:
        """Authenticated user without repository access must not read the project."""
        project = _create_project(test_db)

        # test_user has git_info=None, so it has access to no repositories.
        response = wiki_client.get(
            f"/api/wiki/projects/{project.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404


def _create_generation(db: Session, *, project_id: int, kind_id: int = 0):
    """A finished generation with a page of text, which is what leaked."""
    from datetime import datetime

    from app.models.wiki import WikiContent, WikiGeneration

    generation = WikiGeneration(
        project_id=project_id,
        kind_id=kind_id,
        user_id=4242,
        task_id=0,
        team_id=0,
        source_snapshot={},
        status="COMPLETED",
        ext={},
        completed_at=datetime(2026, 8, 1, 9, 0, 0),
    )
    db.add(generation)
    db.flush()
    db.add(
        WikiContent(
            generation_id=generation.id,
            type="chapter",
            title="Secrets",
            content="internal architecture, in full",
            parent_id=0,
        )
    )
    db.commit()
    db.refresh(generation)
    return generation


class TestWikiGenerationAuth:
    """These endpoints selected by WIKI_DEFAULT_USER_ID, which is a configuration
    value and not a claim about the caller.

    At its default of 0 the service layer reads it as "do not filter by user", so any
    signed-in caller could walk sequential ids and read the full page text of
    anybody's wiki — including the code wikis that now live in the same table. Set
    above zero it narrowed to one account, which every signed-in caller could then
    read: a smaller hole, not a closed one.

    The project endpoints beside these have required repository access all along.
    Generations were simply never held to it.
    """

    def test_a_code_wikis_generation_is_refused_without_the_knowledge_base(
        self, wiki_client: TestClient, test_db: Session, test_token: str
    ) -> None:
        """A code wiki generation is judged by the knowledge-base ACL, not by the
        repository. kind_id 999999 is a knowledge base this caller cannot read
        because it does not exist, which is the same answer as one they may not.

        Asked through cancel, which is now the only endpoint reaching that check —
        the two per-generation reads were removed once nothing called them. The tests
        that covered them went with them rather than staying as assertions that a
        missing route answers 404, which is what they had quietly become.
        """
        project = _create_project(test_db)
        generation = _create_generation(test_db, project_id=project.id, kind_id=999999)

        response = wiki_client.post(
            f"/api/wiki/generations/{generation.id}/cancel",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_listing_requires_a_project_the_caller_may_read(
        self, wiki_client: TestClient, test_db: Session, test_token: str
    ) -> None:
        project = _create_project(test_db)
        _create_generation(test_db, project_id=project.id)

        response = wiki_client.get(
            f"/api/wiki/generations?project_id={project.id}",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_listing_without_a_project_is_refused(
        self, wiki_client: TestClient, test_token: str
    ) -> None:
        """It used to list across every project, narrowed only by configuration."""
        response = wiki_client.get(
            "/api/wiki/generations",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 422

    def test_cancelling_needs_the_same_claim_as_reading(
        self, wiki_client: TestClient, test_db: Session, test_token: str
    ) -> None:
        """Not in the review, found beside it: the account was chosen by
        configuration here too, so any signed-in caller could stop any run that
        account owned — including a code wiki's, leaving its version to be reclaimed
        hours later.
        """
        project = _create_project(test_db)
        generation = _create_generation(test_db, project_id=project.id)

        response = wiki_client.post(
            f"/api/wiki/generations/{generation.id}/cancel",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert response.status_code == 404

    def test_an_entitled_caller_can_still_cancel(
        self, wiki_client: TestClient, test_db: Session, test_token: str, monkeypatch
    ) -> None:
        """The other half, and it caught a mistake in the fix.

        Authorising and then passing user_id=0 to the service looked consistent with
        the read paths, where 0 means "no user filter". Cancelling filters on it
        strictly, so 0 asks for a generation belonging to nobody and cancels nothing
        — a refusal that the test above could not tell apart from the intended one.
        """
        from app.services import wiki_service as wiki_service_module

        project = _create_project(test_db)
        generation = _create_generation(test_db, project_id=project.id)
        monkeypatch.setattr(
            wiki_service_module.WikiService,
            "check_user_project_access",
            lambda self, project, user: True,
        )
        seen = {}
        monkeypatch.setattr(
            wiki_service_module.WikiService,
            "cancel_wiki_generation",
            lambda self, wiki_db, generation_id, user_id: seen.update(
                generation_id=generation_id, user_id=user_id
            )
            or generation,
        )

        wiki_client.post(
            f"/api/wiki/generations/{generation.id}/cancel",
            headers={"Authorization": f"Bearer {test_token}"},
        )

        assert seen == {"generation_id": generation.id, "user_id": generation.user_id}

    def test_no_token_is_refused_before_any_lookup(
        self, wiki_client: TestClient, test_db: Session
    ) -> None:
        """The two per-generation read endpoints were removed once nothing called
        them. What remains is the list and the cancel, and both must still reject an
        unauthenticated caller before touching the database.
        """
        project = _create_project(test_db)
        generation = _create_generation(test_db, project_id=project.id)

        assert (
            wiki_client.get(
                f"/api/wiki/generations?project_id={project.id}"
            ).status_code
            == 401
        )
        assert (
            wiki_client.post(
                f"/api/wiki/generations/{generation.id}/cancel"
            ).status_code
            == 401
        )
