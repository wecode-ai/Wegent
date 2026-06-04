from unittest.mock import Mock

import pytest
import requests

from wegent.client import APIError, WegentClient
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


def test_auth_headers_omitted_token_defaults_from_config_when_api_key_explicit(
    monkeypatch,
):
    monkeypatch.setattr("wegent.client.get_token", lambda: "configured-token")
    monkeypatch.setattr("wegent.client.get_api_key", lambda: "configured-api-key")
    client = WegentClient(
        server="http://backend",
        api_key="explicit-key",
        session=DummySession(make_response()),
    )

    assert client.headers()["Authorization"] == "Bearer configured-token"
    assert "X-API-Key" not in client.headers()


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


def test_normalize_kind_rejects_generic_skill_kind():
    client = WegentClient(server="http://backend")

    with pytest.raises(CliError) as exc_info:
        client.normalize_kind("skill")

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


def test_request_maps_403_to_auth_error():
    session = DummySession(
        make_response(status_code=403, payload={"detail": "forbidden"})
    )
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


def test_request_maps_timeout_error():
    session = DummySession(side_effect=requests.exceptions.Timeout())
    client = WegentClient(server="http://backend", session=session)

    with pytest.raises(CliError) as exc_info:
        client.request("GET", "/tasks/1")

    assert exc_info.value.code == "network_error"
    assert exc_info.value.exit_code == EXIT_NETWORK_ERROR


def test_request_maps_generic_request_error():
    session = DummySession(side_effect=requests.exceptions.RequestException("boom"))
    client = WegentClient(server="http://backend", session=session)

    with pytest.raises(CliError) as exc_info:
        client.request("GET", "/tasks/1")

    assert exc_info.value.code == "network_error"
    assert exc_info.value.exit_code == EXIT_NETWORK_ERROR
    assert exc_info.value.details["server"] == "http://backend"


def test_request_returns_empty_dict_for_204_success():
    session = DummySession(make_response(status_code=204))
    client = WegentClient(server="http://backend", session=session)

    assert client.request("DELETE", "/tasks/1") == {}


def test_request_returns_empty_dict_for_non_json_success():
    response = make_response(status_code=200, text="not json")
    response.json.side_effect = ValueError()
    session = DummySession(response)
    client = WegentClient(server="http://backend", session=session)

    assert client.request("GET", "/tasks/1") == {}


def test_api_error_export_is_preserved_for_legacy_command_imports():
    assert issubclass(APIError, Exception)


def test_api_methods_use_expected_paths():
    session = DummySession(make_response(payload={"items": []}))
    client = WegentClient(server="http://backend", session=session)

    client.list_kind("ghost", "default")
    client.get_kind("team", "default", "chat-team")
    client.apply_kinds("default", [{"kind": "Ghost"}])
    client.delete_kind("ghost", "default", "chat-ghost")
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

    assert [(call["method"], call["url"]) for call in session.calls] == [
        ("GET", "http://backend/api/v1/namespaces/default/ghosts"),
        ("GET", "http://backend/api/v1/namespaces/default/teams/chat-team"),
        ("POST", "http://backend/api/v1/namespaces/default/apply"),
        ("DELETE", "http://backend/api/v1/namespaces/default/ghosts/chat-ghost"),
        ("POST", "http://backend/api/v1/namespaces/default/delete"),
        ("GET", "http://backend/api/users/default-teams"),
        ("POST", "http://backend/api/tasks/create"),
        ("GET", "http://backend/api/tasks/7"),
        ("GET", "http://backend/api/tasks/7/runtime-check"),
        ("POST", "http://backend/api/tasks/7/cancel"),
        ("POST", "http://backend/api/v1/responses"),
        ("GET", "http://backend/api/v1/responses/resp_7"),
        ("POST", "http://backend/api/v1/responses/resp_7/cancel"),
        ("DELETE", "http://backend/api/v1/responses/resp_7"),
    ]
