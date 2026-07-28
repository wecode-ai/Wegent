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
