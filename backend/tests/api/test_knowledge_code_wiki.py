# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for creating a code wiki."""

from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.security import create_access_token
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseType
from app.services.knowledge.code_wiki.source import SourceAccessDenied

CREATE_URL = "/api/knowledge-bases/code-wikis"

PAYLOAD = {
    "name": "Wegent Wiki",
    "namespace": "default",
    "source_type": "github",
    "source_url": "https://github.com/wecode-ai/Wegent.git",
}


@pytest.fixture(autouse=True)
def code_wikis_are_enabled(monkeypatch: pytest.MonkeyPatch):
    """Turn the rollout gate on for everything except the tests about the gate.

    It ships off, so a deployment opts in rather than having to remember to opt out
    everywhere but the pilot group. These tests are about what creating a wiki does,
    not about whether it is allowed, so they say so once here.
    """
    from app.core.wiki_config import wiki_settings

    monkeypatch.setattr(wiki_settings, "CODE_WIKI_ENABLED", True)


@pytest.fixture
def auth_headers(test_user: User) -> dict[str, str]:
    token = create_access_token(data={"sub": test_user.user_name})
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def kind_services_use_test_db(test_db: Session, monkeypatch: pytest.MonkeyPatch):
    """Point ``KindBaseService``'s own session at the test database.

    Creating a knowledge base resolves a default embedding model, which reaches
    ``KindBaseService.list_resources``. That opens its own ``SessionLocal`` instead of
    using the request's session, so the FastAPI dependency override does not reach it
    and it connects to whatever database is configured. On a developer machine with
    MySQL running the test then passes for the wrong reason; in CI there is no MySQL
    and it fails.
    """
    factory = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=test_db.get_bind(),
        expire_on_commit=False,
    )
    monkeypatch.setattr("app.services.kind_base.SessionLocal", factory)


def test_creating_a_code_wiki_records_its_type_and_source(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["kb_type"] == KnowledgeBaseType.CODE_WIKI.value
    assert body["name"] == "Wegent Wiki"


def test_creation_is_refused_without_repository_access(
    test_client: TestClient, auth_headers: dict[str, str]
):
    """A wiki must not be built for a repository the requester cannot read."""
    from app.services.knowledge.code_wiki.source import SourceAccessDenied

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        side_effect=SourceAccessDenied("You do not have read access to 'x/y'."),
    ):
        response = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)

    assert response.status_code == 403
    assert "read access" in response.json()["detail"]


def test_creation_requires_authentication(test_client: TestClient):
    response = test_client.post(CREATE_URL, json=PAYLOAD)

    assert response.status_code in (401, 403)


def test_unsupported_source_type_is_rejected_by_validation(
    test_client: TestClient, auth_headers: dict[str, str]
):
    payload = {**PAYLOAD, "source_type": "svn"}

    response = test_client.post(CREATE_URL, json=payload, headers=auth_headers)

    assert response.status_code == 422


def test_the_general_endpoint_refuses_to_create_a_code_wiki(
    test_client: TestClient, auth_headers: dict[str, str]
):
    """Only the code wiki endpoint may create one, because only it checks the repo."""
    response = test_client.post(
        "/api/knowledge-bases",
        json={"name": "sneaky", "kb_type": "code_wiki"},
        headers=auth_headers,
    )

    assert response.status_code == 400
    assert "code-wikis" in response.json()["detail"]


def test_ordinary_knowledge_bases_are_still_created_as_notebooks(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    response = test_client.post(
        "/api/knowledge-bases", json={"name": "plain notes"}, headers=auth_headers
    )

    assert response.status_code == 201, response.text
    assert response.json()["kb_type"] == KnowledgeBaseType.NOTEBOOK.value


# --- triggering a run -------------------------------------------------------


def _create_wiki(test_client: TestClient, auth_headers: dict[str, str]) -> int:
    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def _run_url(knowledge_base_id: int) -> str:
    return f"/api/knowledge-bases/{knowledge_base_id}/code-wiki/generations"


@pytest.fixture
def caller_can_write():
    """Grant repository write access for tests that are about something else."""
    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_write_source",
        return_value={"has_access": True, "access_level": 30},
    ):
        yield


def test_a_run_can_be_triggered_without_waiting_for_a_schedule(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
    caller_can_write,
):
    kb_id = _create_wiki(test_client, auth_headers)

    with patch("app.api.endpoints.knowledge_code_wiki.start_run") as start:
        start.return_value.started = True
        start.return_value.mode = "full"
        start.return_value.reason = "first run for this repository"
        start.return_value.generation.id = 7
        start.return_value.task_id = 42

        response = test_client.post(
            _run_url(kb_id), json={"head_commit": "abc1234"}, headers=auth_headers
        )

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["started"] is True
    assert body["generation_id"] == 7
    assert body["task_id"] == 42


def test_a_run_that_was_not_needed_is_a_success_not_a_failure(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
    caller_can_write,
):
    """ "Nothing changed" is the answer the caller asked for, not an error."""
    kb_id = _create_wiki(test_client, auth_headers)

    with patch("app.api.endpoints.knowledge_code_wiki.start_run") as start:
        start.return_value.started = False
        start.return_value.mode = "skip"
        start.return_value.reason = "repository unchanged since last run"
        start.return_value.generation = None
        start.return_value.task_id = 0

        response = test_client.post(_run_url(kb_id), json={}, headers=auth_headers)

    assert response.status_code == 202, response.text
    body = response.json()
    assert body["started"] is False
    assert body["mode"] == "skip"
    assert body["generation_id"] == 0


def test_a_second_run_while_one_is_live_is_a_conflict(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
    caller_can_write,
):
    from app.services.knowledge.code_wiki.generation import GenerationInFlight

    kb_id = _create_wiki(test_client, auth_headers)

    with patch(
        "app.api.endpoints.knowledge_code_wiki.start_run",
        side_effect=GenerationInFlight("generation 3 is already running"),
    ):
        response = test_client.post(_run_url(kb_id), json={}, headers=auth_headers)

    assert response.status_code == 409
    assert "already running" in response.json()["detail"]


def test_a_knowledge_base_that_is_not_a_code_wiki_cannot_be_generated(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    response = test_client.post(
        "/api/knowledge-bases", json={"name": "plain notes"}, headers=auth_headers
    )
    notebook_id = response.json()["id"]

    response = test_client.post(_run_url(notebook_id), json={}, headers=auth_headers)

    assert response.status_code == 400
    assert "not a code wiki" in response.json()["detail"]


def test_a_missing_knowledge_base_is_not_found(
    test_client: TestClient, auth_headers: dict[str, str]
):
    response = test_client.post(_run_url(999999), json={}, headers=auth_headers)

    assert response.status_code == 404


def test_triggering_a_run_requires_authentication(test_client: TestClient):
    response = test_client.post(_run_url(1), json={})

    assert response.status_code in (401, 403)


# --- who owns a code wiki, and how many there are ---------------------------


# --- ownership and listing --------------------------------------------------


LIST_URL = "/api/knowledge-bases/code-wikis"


def test_a_code_wiki_belongs_to_whoever_created_it(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    test_user: User,
    kind_services_use_test_db,
):
    """Ownership is what makes the ordinary ACL apply. Filing it under a shared wiki
    account instead left the knowledge base visible to nobody, which forced a second
    authorisation rule that only the newly written endpoints ever consulted."""
    from app.models.kind import Kind

    kb_id = _create_wiki(test_client, auth_headers)

    kind = test_db.get(Kind, kb_id)
    assert kind.user_id == test_user.id


def test_the_creator_can_read_the_wiki_they_just_created(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The failure this pins is not hypothetical: under the previous owner the
    creator was refused their own wiki's navigation immediately after creating it."""
    kb_id = _create_wiki(test_client, auth_headers)

    response = test_client.get(
        f"/api/knowledge-bases/{kb_id}/code-wiki/pages", headers=auth_headers
    )

    assert response.status_code == 200, response.text


def test_a_code_wiki_appears_in_the_general_knowledge_base_list(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """It is a knowledge base. Excluding it from the general list would also take it
    out of chat citation and the MCP tool, where being citable is the point."""
    kb_id = _create_wiki(test_client, auth_headers)

    grouped = test_client.get(
        "/api/knowledge-bases/all-grouped", headers=auth_headers
    ).json()

    listed = [
        kb["id"]
        for bucket in (
            grouped["personal"]["created_by_me"],
            grouped["personal"]["shared_with_me"],
        )
        for kb in bucket
    ]
    assert kb_id in listed


def test_the_list_shows_a_wiki_the_caller_owns(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    kb_id = _create_wiki(test_client, auth_headers)

    response = test_client.get(LIST_URL, headers=auth_headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert [item["id"] for item in body["items"]] == [kb_id]
    assert body["items"][0]["project_name"] == "wecode-ai/Wegent"


def test_the_list_hides_another_user_s_wiki(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Nothing special to code wikis — this is the knowledge-base ACL doing its job,
    and the point of the change is that it is the only rule in play."""
    from app.core.security import create_access_token, get_password_hash

    _create_wiki(test_client, auth_headers)
    stranger = User(
        user_name="stranger",
        password_hash=get_password_hash("irrelevant"),
        email="stranger@example.com",
        is_active=True,
    )
    test_db.add(stranger)
    test_db.commit()
    token = create_access_token(data={"sub": stranger.user_name})

    response = test_client.get(LIST_URL, headers={"Authorization": f"Bearer {token}"})

    assert response.json() == {"items": [], "total": 0}


def test_the_repository_is_registered_against_the_wiki_that_documents_it(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """One row per (repository, wiki). The composite UNIQUE is what settles two
    requests racing for the same pair, which a check on a JSON field could not."""
    from app.models.wiki import WikiProject

    kb_id = _create_wiki(test_client, auth_headers)

    project = test_db.query(WikiProject).one()
    assert project.kind_id == kb_id
    assert project.source_url == "https://github.com/wecode-ai/Wegent.git"


def test_asking_twice_for_the_same_repository_returns_the_caller_s_own_wiki(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """Answering with the existing one, 200 rather than 201, says which happened."""
    first_id = _create_wiki(test_client, auth_headers)

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        again = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)

    assert again.status_code == 200, again.text
    assert again.json()["id"] == first_id


def test_another_user_may_build_their_own_wiki_of_the_same_repository(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """The first wiki is invisible to the second caller under its owner's ACL, so
    refusing them one of their own would take it away on a first-come basis."""
    from app.core.security import create_access_token, get_password_hash

    first_id = _create_wiki(test_client, auth_headers)
    other = User(
        user_name="colleague",
        password_hash=get_password_hash("irrelevant"),
        email="colleague@example.com",
        is_active=True,
    )
    test_db.add(other)
    test_db.commit()
    token = create_access_token(data={"sub": other.user_name})

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL, json=PAYLOAD, headers={"Authorization": f"Bearer {token}"}
        )

    assert response.status_code == 201, response.text
    assert response.json()["id"] != first_id


# --- who may trigger a run --------------------------------------------------


def test_regenerating_requires_write_access_to_the_repository(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """A run rewrites every page, so reading the wiki is not enough. Without this a
    wiki shared with a reader lets them spend a generation on somebody else's
    knowledge base."""
    kb_id = _create_wiki(test_client, auth_headers)

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_write_source",
        side_effect=SourceAccessDenied("read access but not write access"),
    ):
        response = test_client.post(_run_url(kb_id), json={}, headers=auth_headers)

    assert response.status_code == 403
    assert "write access" in response.json()["detail"]


def test_a_reader_of_the_repository_cannot_regenerate(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The threshold, not just the presence of a gate: read access reports an access
    level below Developer, and that has to be refused rather than rounded up."""
    from app.services.knowledge.code_wiki import source as source_module

    kb_id = _create_wiki(test_client, auth_headers)

    with patch.object(
        source_module,
        "assert_user_can_read_source",
        return_value={"has_access": True, "access_level": 10},
    ):
        response = test_client.post(_run_url(kb_id), json={}, headers=auth_headers)

    assert response.status_code == 403


def test_creating_a_wiki_starts_its_first_run(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """Otherwise a new wiki sits empty until somebody finds the regenerate button,
    which is not a flow anyone would guess. TestClient runs background tasks before
    returning, so the call is observable here."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run") as start:
        kb_id = _create_wiki(test_client, auth_headers)

    start.assert_called_once()
    assert start.call_args.args[1] == kb_id


def test_the_first_run_does_not_block_the_response(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """Starting a run reads the repository's HEAD over the network, which can take
    the full connect timeout. Awaited inline that makes creating a wiki appear to
    hang and then to have failed, when the knowledge base is already saved."""
    import inspect

    from app.api.endpoints import knowledge_code_wiki as endpoint

    # The queued function takes ids, not the request's session and user: it runs
    # after the response, by which time that session is closed.
    parameters = list(inspect.signature(endpoint._start_the_first_run).parameters)
    assert parameters == ["user_id", "knowledge_base_id"]


def test_a_first_run_that_cannot_start_still_leaves_the_wiki_created(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The knowledge base is already committed. Reporting the creation as failed
    would be untrue, and the reader's own button still starts a run."""
    from app.services.knowledge.code_wiki.runner import CodeWikiRunError

    with patch(
        "app.api.endpoints.knowledge_code_wiki.start_run",
        side_effect=CodeWikiRunError("no team configured"),
    ):
        kb_id = _create_wiki(test_client, auth_headers)

    assert kb_id > 0
    assert (
        test_client.get(
            f"/api/knowledge-bases/{kb_id}/code-wiki/pages", headers=auth_headers
        ).status_code
        == 200
    )


# --- resolving a repository before binding ----------------------------------


RESOLVE_URL = "/api/knowledge-bases/code-wikis/resolve"
RESOLVE_PAYLOAD = {
    "source_type": "github",
    "source_url": "https://github.com/wecode-ai/Wegent.git",
}


def test_resolving_answers_with_what_the_create_form_needs(
    test_client: TestClient, auth_headers: dict[str, str]
):
    from app.services.knowledge.code_wiki.resolution import ResolvedRepository

    with patch(
        "app.api.endpoints.knowledge_code_wiki.resolve_repository",
        return_value=ResolvedRepository(
            exists=True,
            visibility="public",
            default_branch="main",
            name="wecode-ai/Wegent",
            description="An agent operating system",
            access="public",
        ),
    ):
        response = test_client.post(
            RESOLVE_URL, json=RESOLVE_PAYLOAD, headers=auth_headers
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["default_branch"] == "main"
    assert body["access"] == "public"
    assert body["name"] == "wecode-ai/Wegent"


def test_an_unreadable_repository_resolves_to_200_not_404(
    test_client: TestClient, auth_headers: dict[str, str]
):
    """This assists a form; it does not assert that something is missing. 404 would
    also make private and absent distinguishable, which they must not be."""
    from app.services.knowledge.code_wiki.resolution import UNREADABLE

    with patch(
        "app.api.endpoints.knowledge_code_wiki.resolve_repository",
        return_value=UNREADABLE,
    ):
        response = test_client.post(
            RESOLVE_URL, json=RESOLVE_PAYLOAD, headers=auth_headers
        )

    assert response.status_code == 200
    assert response.json()["exists"] is False


def test_resolving_names_the_wikis_that_already_exist(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """A count is not actionable: asking for a share needs somebody to ask. One the
    caller can already open is reported as accessible, so the client links to it
    instead."""
    from app.services.knowledge.code_wiki.resolution import UNREADABLE

    kb_id = _create_wiki(test_client, auth_headers)

    with patch(
        "app.api.endpoints.knowledge_code_wiki.resolve_repository",
        return_value=UNREADABLE,
    ):
        response = test_client.post(
            RESOLVE_URL, json=RESOLVE_PAYLOAD, headers=auth_headers
        )

    (existing,) = response.json()["existing_wikis"]
    assert existing["id"] == kb_id
    assert existing["accessible"] is True
    assert existing["owner_name"] == "testuser"


def test_another_user_s_wiki_is_named_with_its_owner(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """The owner is the whole point of naming it: the caller cannot open this one,
    so the useful action is to ask."""
    from app.core.security import create_access_token, get_password_hash
    from app.services.knowledge.code_wiki.resolution import UNREADABLE

    _create_wiki(test_client, auth_headers)
    stranger = User(
        user_name="stranger",
        password_hash=get_password_hash("irrelevant"),
        email="stranger@example.com",
        is_active=True,
    )
    test_db.add(stranger)
    test_db.commit()
    token = create_access_token(data={"sub": stranger.user_name})

    with patch(
        "app.api.endpoints.knowledge_code_wiki.resolve_repository",
        return_value=UNREADABLE,
    ):
        response = test_client.post(
            RESOLVE_URL,
            json=RESOLVE_PAYLOAD,
            headers={"Authorization": f"Bearer {token}"},
        )

    (existing,) = response.json()["existing_wikis"]
    assert existing["accessible"] is False
    assert existing["owner_name"] == "testuser"


def test_a_code_wiki_can_be_created_without_a_name(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Left blank, the repository's name is used. The client sends what the form
    already resolved, so this does not ask the provider a second time — the access
    gate has asked it once already."""
    from app.models.kind import Kind

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL,
            # Deliberately not what the URL parses to: the provider is the authority
            # on what a repository is called, renames included.
            json={**PAYLOAD, "name": "wecode-ai/Wegent-Renamed"},
            headers=auth_headers,
        )

    assert response.status_code == 201, response.text
    kind = test_db.get(Kind, response.json()["id"])
    assert kind.json["spec"]["name"] == "wecode-ai/Wegent-Renamed"


def test_an_unnamed_wiki_falls_back_to_the_url(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """A caller that skipped the probe, or called the API directly, would otherwise
    create a knowledge base with no name at all, which no listing can render."""
    from app.models.kind import Kind

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL, json={**PAYLOAD, "name": ""}, headers=auth_headers
        )

    assert response.status_code == 201, response.text
    kind = test_db.get(Kind, response.json()["id"])
    assert kind.json["spec"]["name"] == "wecode-ai/Wegent"


def test_creating_does_not_describe_the_repository_again(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The access gate already asked the provider. Resolving again here worked only
    because the form had just warmed the cache — an implicit coupling that fails
    whenever it has not."""
    with (
        patch(
            "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
            return_value={"has_access": True},
        ),
        patch("app.api.endpoints.knowledge_code_wiki.resolve_repository") as resolve,
    ):
        test_client.post(CREATE_URL, json={**PAYLOAD, "name": ""}, headers=auth_headers)

    resolve.assert_not_called()


def test_resolving_a_malformed_url_is_a_bad_request(
    test_client: TestClient, auth_headers: dict[str, str]
):
    response = test_client.post(
        RESOLVE_URL,
        json={"source_type": "github", "source_url": "not-a-url"},
        headers=auth_headers,
    )

    assert response.status_code == 400


def test_resolving_requires_authentication(test_client: TestClient):
    assert test_client.post(RESOLVE_URL, json=RESOLVE_PAYLOAD).status_code == 401


def test_a_code_wiki_keeps_the_summary_settings_it_was_created_with(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """The create form collects these for every kind of knowledge base. Dropping
    them on the way to the code wiki endpoint silently ignored what was filled in,
    and the edit dialog then showed defaults the user had not chosen."""
    from app.models.kind import Kind

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL,
            json={
                **PAYLOAD,
                "summary_enabled": True,
                "summary_model_ref": {"name": "gpt", "namespace": "default"},
            },
            headers=auth_headers,
        )

    assert response.status_code == 201, response.text
    spec = test_db.get(Kind, response.json()["id"]).json["spec"]
    assert spec["summaryEnabled"] is True
    assert spec["summaryModelRef"]["name"] == "gpt"


def test_a_code_wiki_records_the_language_its_pages_are_written_in(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Chosen per wiki rather than per deployment: one instance documents both
    Chinese and English repositories."""
    from app.models.kind import Kind

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL, json={**PAYLOAD, "language": "zh"}, headers=auth_headers
        )

    assert test_db.get(Kind, response.json()["id"]).json["spec"]["language"] == "zh"


def test_a_wiki_without_a_language_follows_the_deployment_default(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    kind_services_use_test_db,
):
    """Storing the default at creation would freeze it: changing the deployment's
    language would then leave every existing wiki on the old one. Pinned by moving
    the default and watching the wiki follow, rather than by naming a language —
    which would only assert what this machine's .env happens to say."""
    from app.core.wiki_config import wiki_settings
    from app.models.kind import Kind
    from app.services.knowledge.code_wiki.runner import _language_of

    kb_id = _create_wiki(test_client, auth_headers)
    kind = test_db.get(Kind, kb_id)
    assert not kind.json["spec"].get("language")

    monkeypatch.setattr(wiki_settings, "DEFAULT_LANGUAGE", "en")
    assert _language_of(kind) == "English"
    monkeypatch.setattr(wiki_settings, "DEFAULT_LANGUAGE", "zh")
    assert _language_of(kind) == "Chinese (Simplified)"


def test_the_response_carries_the_repository_so_a_list_can_render_it(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The merged list shows a repository on a code wiki's card and links to the
    reader. Without this it would need a second request per row to tell which rows
    are code wikis at all."""
    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)

    body = response.json()
    assert body["kb_type"] == "code_wiki"
    assert body["source"]["projectName"] == "wecode-ai/Wegent"


def test_a_code_wiki_keeps_the_retrieval_config_it_was_created_with(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """A code wiki is an ordinary knowledge base with a repository attached, so the
    whole create payload applies to it. Listing only the fields it "needs" left this
    one to be auto-resolved, which looked like it worked — a config was stored, just
    not the one the form collected."""
    from app.models.kind import Kind

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value={"has_access": True},
    ):
        response = test_client.post(
            CREATE_URL,
            json={
                **PAYLOAD,
                "retrieval_config": {
                    "retriever_name": "chosen-by-the-user",
                    "retriever_namespace": "default",
                    "embedding_config": {
                        "model_name": "chosen-embedding",
                        "model_namespace": "default",
                    },
                    "top_k": 9,
                    "score_threshold": 0.8,
                },
            },
            headers=auth_headers,
        )

    assert response.status_code == 201, response.text
    stored = test_db.get(Kind, response.json()["id"]).json["spec"]["retrievalConfig"]
    assert stored["retriever_name"] == "chosen-by-the-user"
    assert stored["top_k"] == 9


def test_the_create_payload_is_not_a_hand_picked_subset(
    test_client: TestClient, auth_headers: dict[str, str]
):
    """The subset is the defect, not any one missing field: each time a field was
    added to knowledge base creation it had to be remembered here too, and twice it
    was not. Inheriting makes forgetting impossible rather than unlikely."""
    from app.schemas.knowledge import CodeWikiCreate, KnowledgeBaseCreate

    missing = set(KnowledgeBaseCreate.model_fields) - set(CodeWikiCreate.model_fields)

    assert not missing, f"a code wiki cannot be created with: {sorted(missing)}"


# --- what is being done to this wiki right now ------------------------------


def _status_url(knowledge_base_id: int) -> str:
    return f"/api/knowledge-bases/{knowledge_base_id}/code-wiki/status"


def test_a_wiki_that_has_never_run_says_so(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """The reader offers to generate; it needs to know there is nothing to wait
    for rather than inferring it from an empty page tree."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    body = test_client.get(_status_url(kb_id), headers=auth_headers).json()

    assert body["status"] == "never"
    assert body["is_stale"] is False


def _record_a_running_generation(test_db, kb_id: int, *, quiet_for_hours: int = 0):
    """Put a version in flight without starting one.

    Starting a real run needs the execution team, which these tests do not set up —
    and this is about what the status endpoint reports, not about starting runs.
    """
    from datetime import datetime, timedelta

    from app.models.wiki import WikiGeneration

    generation = WikiGeneration(
        project_id=1,
        kind_id=kb_id,
        user_id=1,
        task_id=4242,
        team_id=1,
        source_snapshot={},
        status="RUNNING",
        ext={},
        completed_at=datetime(1970, 1, 1),
    )
    test_db.add(generation)
    test_db.flush()
    if quiet_for_hours:
        generation.updated_at = datetime.utcnow() - timedelta(hours=quiet_for_hours)
    test_db.commit()
    return generation


def test_a_running_wiki_reports_the_run_rather_than_looking_idle(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Until this existed the regenerate button was only disabled for the duration
    of its own request, so reloading the page made a running wiki look idle and the
    next click came back as an unexplained conflict."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    generation = _record_a_running_generation(test_db, kb_id)

    body = test_client.get(_status_url(kb_id), headers=auth_headers).json()

    assert body["status"] == "running"
    assert body["generation_id"] == generation.id
    assert body["is_stale"] is False


def test_a_run_whose_worker_went_quiet_is_reported_as_stale(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Stale is not busy: triggering again reclaims it and starts afresh. Reported
    separately so the client can offer that instead of saying the wiki is busy."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    _record_a_running_generation(test_db, kb_id, quiet_for_hours=7)

    body = test_client.get(_status_url(kb_id), headers=auth_headers).json()

    assert body["status"] == "running"
    assert body["is_stale"] is True


def test_reading_the_status_needs_only_read_access(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """Whether the wiki is busy is what explains why regenerating is unavailable.
    Requiring write access to learn it would leave a reader with an opaque button."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    # No repository write access is granted anywhere in this test.
    assert test_client.get(_status_url(kb_id), headers=auth_headers).status_code == 200


# --- what has been attempted on this wiki -----------------------------------


def _history_url(knowledge_base_id: int) -> str:
    return f"/api/knowledge-bases/{knowledge_base_id}/code-wiki/generations"


def _record_a_finished_generation(
    test_db,
    kb_id: int,
    *,
    status: str,
    mode: str = "full",
    commit: str = "",
    error: str = "",
    task_id: int = 0,
):
    """Record an ended run directly, for the same reason the running one is."""
    from datetime import datetime

    from app.models.wiki import WikiGeneration
    from app.services.knowledge.code_wiki.generation import FAILURE_REASON_EXT_KEY

    generation = WikiGeneration(
        project_id=1,
        kind_id=kb_id,
        user_id=1,
        task_id=task_id,
        team_id=1,
        generation_type=mode,
        source_snapshot={"commit": commit} if commit else {},
        status=status,
        ext={FAILURE_REASON_EXT_KEY: error} if error else {},
        completed_at=datetime(2026, 8, 1, 9, 0, 0),
    )
    test_db.add(generation)
    test_db.commit()
    return generation


def test_the_history_explains_why_a_wiki_has_no_pages(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """The screen this exists for: every run failed, so the reader sees an empty
    wiki and the only useful answer is in a run that already ended."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    _record_a_finished_generation(
        test_db,
        kb_id,
        status="FAILED",
        error="git clone failed: could not read Username",
        task_id=99,
    )

    body = test_client.get(_history_url(kb_id), headers=auth_headers).json()

    assert len(body["runs"]) == 1
    run = body["runs"][0]
    assert run["status"] == "failed"
    assert run["error_message"] == "git clone failed: could not read Username"
    assert run["task_id"] == 99


def test_the_history_is_newest_first(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    first = _record_a_finished_generation(test_db, kb_id, status="COMPLETED")
    second = _record_a_finished_generation(test_db, kb_id, status="FAILED")

    runs = test_client.get(_history_url(kb_id), headers=auth_headers).json()["runs"]

    assert [run["generation_id"] for run in runs] == [second.id, first.id]


def test_the_published_version_is_marked_in_the_history(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """Two runs can both have completed while only one is what readers see. Without
    this the history says "completed" twice and answers nothing."""
    from app.models.kind import Kind
    from app.services.knowledge.code_wiki.publisher import PUBLISHED_GENERATION_KEY

    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    published = _record_a_finished_generation(test_db, kb_id, status="COMPLETED")
    later = _record_a_finished_generation(test_db, kb_id, status="COMPLETED")

    knowledge_base = test_db.get(Kind, kb_id)
    payload = dict(knowledge_base.json or {})
    spec = dict(payload.get("spec", {}))
    spec[PUBLISHED_GENERATION_KEY] = published.id
    payload["spec"] = spec
    knowledge_base.json = payload
    test_db.commit()

    runs = test_client.get(_history_url(kb_id), headers=auth_headers).json()["runs"]

    by_id = {run["generation_id"]: run for run in runs}
    assert by_id[published.id]["published"] is True
    assert by_id[later.id]["published"] is False


def test_a_run_still_going_reports_no_finish_time(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """completed_at defaults to the epoch rather than NULL, so reporting it raw
    would have every in-flight run claim it finished in 1970."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    _record_a_running_generation(test_db, kb_id)

    run = test_client.get(_history_url(kb_id), headers=auth_headers).json()["runs"][0]

    assert run["status"] == "running"
    assert run["completed_at"] is None


def test_reading_the_history_needs_only_read_access(
    test_client: TestClient,
    auth_headers: dict[str, str],
    kind_services_use_test_db,
):
    """Same reasoning as the status beside it: a reader denied the explanation is
    left with a broken page and nothing to act on."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    assert test_client.get(_history_url(kb_id), headers=auth_headers).status_code == 200


# --- the rollout gate --------------------------------------------------------


def test_creating_a_code_wiki_is_refused_when_the_rollout_is_off(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    kind_services_use_test_db,
):
    """Enforced on the server, not only in the dialog. Hiding the option keeps the
    product tidy; it does not stop a direct call, and a gated rollout that a POST
    walks straight past is not gated.
    """
    from app.core.wiki_config import wiki_settings

    monkeypatch.setattr(wiki_settings, "CODE_WIKI_ENABLED", False)

    with patch(
        "app.api.endpoints.knowledge_code_wiki.assert_user_can_read_source",
        return_value=None,
    ):
        response = test_client.post(CREATE_URL, json=PAYLOAD, headers=auth_headers)

    assert response.status_code == 403


def test_an_existing_wiki_stays_readable_when_the_rollout_is_off(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    kind_services_use_test_db,
):
    """Turning a rollout down should stop it spreading, not break what it produced.
    A wiki built while it was on keeps its pages, its status and its history.
    """
    from app.core.wiki_config import wiki_settings

    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    monkeypatch.setattr(wiki_settings, "CODE_WIKI_ENABLED", False)

    for url in (
        f"/api/knowledge-bases/{kb_id}/code-wiki/pages",
        _status_url(kb_id),
        _history_url(kb_id),
    ):
        assert test_client.get(url, headers=auth_headers).status_code == 200, url


def test_an_existing_wiki_can_still_regenerate_when_the_rollout_is_off(
    test_client: TestClient,
    auth_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
    kind_services_use_test_db,
):
    """A wiki frozen at whatever commit the rollout was paused on is worse than no
    wiki: it documents a repository that has since moved and says nothing about it.
    So the gate is on creation, and regenerating is not creation.
    """
    from app.core.wiki_config import wiki_settings

    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    monkeypatch.setattr(wiki_settings, "CODE_WIKI_ENABLED", False)

    with (
        patch(
            "app.api.endpoints.knowledge_code_wiki.assert_user_can_write_source",
            return_value=None,
        ),
        patch("app.api.endpoints.knowledge_code_wiki.start_run") as start,
    ):
        start.return_value = SimpleNamespace(
            started=False, mode="skip", reason="unchanged", generation=None, task_id=0
        )
        response = test_client.post(
            f"/api/knowledge-bases/{kb_id}/code-wiki/generations",
            json={},
            headers=auth_headers,
        )

    assert response.status_code == 202


def test_the_history_reports_a_failed_task_beside_a_completed_version(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """These are two facts about one run and they can honestly differ: an agent that
    submitted its pages and concluded the run leaves a published version behind even
    if its container then died afterwards.

    Showing only the version made them look as though they contradicted each other,
    with nothing to say there were two.
    """
    from app.models.task import TaskResource

    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)

    test_db.add(
        TaskResource(
            id=8801,
            user_id=1,
            kind="Task",
            name="task-8801",
            namespace="system",
            json={"status": {"status": "FAILED"}},
            is_active=TaskResource.STATE_ACTIVE,
        )
    )
    test_db.commit()
    _record_a_finished_generation(test_db, kb_id, status="COMPLETED", task_id=8801)

    run = test_client.get(_history_url(kb_id), headers=auth_headers).json()["runs"][0]

    assert run["status"] == "completed"
    assert run["task_status"] == "FAILED"


def test_a_run_with_no_task_reports_no_task_status(
    test_client: TestClient,
    auth_headers: dict[str, str],
    test_db: Session,
    kind_services_use_test_db,
):
    """A run whose task could not be created has nothing to report, and must not be
    made to look as though its task succeeded."""
    with patch("app.api.endpoints.knowledge_code_wiki._start_the_first_run"):
        kb_id = _create_wiki(test_client, auth_headers)
    _record_a_finished_generation(test_db, kb_id, status="FAILED", task_id=0)

    run = test_client.get(_history_url(kb_id), headers=auth_headers).json()["runs"][0]

    assert run["task_status"] == ""


def test_the_code_wiki_routes_are_matched_before_the_by_id_route():
    """`/code-wikis` and `/{knowledge_base_id}` share a prefix, and FastAPI matches in
    registration order. The code wiki routes live in their own module now, so keeping
    them ahead of the by-id route is a line of wiring rather than a consequence of
    where the functions sit in a file — and getting it wrong makes every code wiki
    request try to read "code-wikis" as an id, which reads as a client bug.
    """
    from app.api.endpoints.knowledge import router

    paths = [route.path for route in router.routes]

    assert paths.index("/code-wikis") < paths.index("/{knowledge_base_id}")
