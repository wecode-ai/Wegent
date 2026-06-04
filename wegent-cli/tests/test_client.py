from unittest.mock import Mock

import pytest
import requests

from wegent.client import KIND_ALIASES, KIND_TO_PATH, VALID_KINDS, WegentClient
from wegent.errors import EXIT_API_ERROR, EXIT_AUTH_ERROR, EXIT_NETWORK_ERROR, CliError


class DummySession:
    def __init__(self, response=None, side_effect=None):
        self.response = response
        self.side_effect = side_effect
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.side_effect:
            raise self.side_effect
        return self.response


def make_response(status_code=200, payload=None, text=""):
    response = Mock()
    response.status_code = status_code
    response.text = text
    response.reason = "Reason"
    response.json.return_value = payload if payload is not None else {}
    return response


def test_auth_headers_prefer_bearer_token_over_api_key():
    client = WegentClient(
        server="http://backend",
        token="token-1",
        api_key="api-key-1",
        session=DummySession(make_response()),
    )

    assert client.headers()["Authorization"] == "Bearer token-1"
    assert "X-API-Key" not in client.headers()


def test_auth_headers_use_api_key_when_token_missing():
    client = WegentClient(
        server="http://backend",
        token=None,
        api_key="api-key-1",
        session=DummySession(make_response()),
    )

    assert client.headers()["X-API-Key"] == "api-key-1"
    assert "Authorization" not in client.headers()


def test_normalize_kind_accepts_aliases_and_plurals():
    client = WegentClient(server="http://backend")

    assert client.normalize_kind("gh") == "ghost"
    assert client.normalize_kind("ghosts") == "ghost"
    assert client.normalize_kind("Team") == "team"


def test_normalize_kind_rejects_invalid_kind():
    client = WegentClient(server="http://backend")

    with pytest.raises(CliError) as exc_info:
        client.normalize_kind("invalid")

    assert exc_info.value.code == "invalid_kind"


def test_request_builds_api_url_and_json_body():
    session = DummySession(make_response(payload={"ok": True}))
    client = WegentClient(server="http://backend/", token="token", session=session)

    result = client.request("POST", "/v1/responses", data={"input": "hello"})

    assert result == {"ok": True}
    assert session.calls[0]["url"] == "http://backend/api/v1/responses"
    assert session.calls[0]["json"] == {"input": "hello"}
    assert session.calls[0]["headers"]["Authorization"] == "Bearer token"


def test_request_maps_401_to_auth_error():
    session = DummySession(make_response(status_code=401, payload={"detail": "bad token"}))
    client = WegentClient(server="http://backend", session=session)

    with pytest.raises(CliError) as exc_info:
        client.request("GET", "/tasks/1")

    assert exc_info.value.code == "auth_error"
    assert exc_info.value.exit_code == EXIT_AUTH_ERROR


def test_request_maps_backend_error():
    session = DummySession(make_response(status_code=500, payload={"detail": "boom"}))
    client = WegentClient(server="http://backend", session=session)

    with pytest.raises(CliError) as exc_info:
        client.request("GET", "/tasks/1")

    assert exc_info.value.code == "api_error"
    assert exc_info.value.exit_code == EXIT_API_ERROR
    assert exc_info.value.details["status_code"] == 500


def test_request_maps_connection_error():
    session = DummySession(side_effect=requests.exceptions.ConnectionError())
    client = WegentClient(server="http://backend", session=session)

    with pytest.raises(CliError) as exc_info:
        client.request("GET", "/tasks/1")

    assert exc_info.value.code == "network_error"
    assert exc_info.value.exit_code == EXIT_NETWORK_ERROR


def test_api_methods_use_expected_paths():
    session = DummySession(make_response(payload={"items": []}))
    client = WegentClient(server="http://backend", session=session)

    client.list_kind("ghost", "default")
    client.get_kind("team", "default", "chat-team")
    client.apply_kinds("default", [{"kind": "Ghost"}])
    client.delete_kinds("default", [{"kind": "Ghost"}])
    client.get_default_teams()
    client.create_task({"prompt": "hello"})
    client.get_task(7)
    client.get_task_runtime(7)
    client.cancel_task(7)
    client.create_response({"model": "default#team", "input": "hello"})
    client.get_response("resp_7")
    client.cancel_response("resp_7")
    client.delete_response("resp_7")

    assert [call["url"] for call in session.calls] == [
        "http://backend/api/v1/namespaces/default/ghosts",
        "http://backend/api/v1/namespaces/default/teams/chat-team",
        "http://backend/api/v1/namespaces/default/apply",
        "http://backend/api/v1/namespaces/default/delete",
        "http://backend/api/users/default-teams",
        "http://backend/api/tasks/create",
        "http://backend/api/tasks/7",
        "http://backend/api/tasks/7/runtime-check",
        "http://backend/api/tasks/7/cancel",
        "http://backend/api/v1/responses",
        "http://backend/api/v1/responses/resp_7",
        "http://backend/api/v1/responses/resp_7/cancel",
        "http://backend/api/v1/responses/resp_7",
    ]
