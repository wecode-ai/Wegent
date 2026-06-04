"""HTTP client for Wegent Backend APIs."""

from typing import Any, Optional, cast

import requests

from .config import get_api_key, get_server, get_token
from .errors import EXIT_API_ERROR, EXIT_AUTH_ERROR, EXIT_NETWORK_ERROR, CliError

VALID_KINDS = ["ghost", "model", "shell", "bot", "team", "workspace", "task", "skill"]

KIND_TO_PATH = {
    "ghost": "ghosts",
    "model": "models",
    "shell": "shells",
    "bot": "bots",
    "team": "teams",
    "workspace": "workspaces",
    "task": "tasks",
    "skill": "skills",
}

KIND_ALIASES = {
    "gh": "ghost",
    "mo": "model",
    "sh": "shell",
    "bo": "bot",
    "te": "team",
    "ws": "workspace",
    "ta": "task",
    "sk": "skill",
}

_OMITTED = object()


class APIError(Exception):
    """Legacy API error kept for command modules pending replacement."""

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"API Error {status_code}: {message}")


class WegentClient:
    """Authenticated client for Wegent Backend APIs."""

    def __init__(
        self,
        server: Optional[str] = None,
        token: Optional[str] | object = _OMITTED,
        api_key: Optional[str] | object = _OMITTED,
        timeout: int = 30,
        session: Optional[requests.Session] = None,
    ):
        self.server = (server or get_server()).rstrip("/")
        self.token = get_token() if token is _OMITTED else cast(Optional[str], token)
        self.api_key = (
            get_api_key() if api_key is _OMITTED else cast(Optional[str], api_key)
        )
        self.timeout = timeout
        self.session = session or requests.Session()

    def headers(self) -> dict[str, str]:
        """Build request headers."""
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        elif self.api_key:
            headers["X-API-Key"] = self.api_key
        return headers

    def request(
        self,
        method: str,
        path: str,
        data: Optional[dict[str, Any] | list[Any]] = None,
    ) -> Any:
        """Make an HTTP request against `/api` and normalize failures."""
        url = f"{self.server}/api{path}"
        try:
            response = self.session.request(
                method,
                url,
                json=data,
                headers=self.headers(),
                timeout=self.timeout,
            )
        except requests.exceptions.Timeout as exc:
            raise CliError(
                "network_error",
                "Request timed out",
                {"server": self.server},
                EXIT_NETWORK_ERROR,
            ) from exc
        except requests.exceptions.ConnectionError as exc:
            raise CliError(
                "network_error",
                f"Failed to connect to server: {self.server}",
                {"server": self.server},
                EXIT_NETWORK_ERROR,
            ) from exc

        if response.status_code >= 400:
            message = self._extract_error_message(response)
            exit_code = (
                EXIT_AUTH_ERROR
                if response.status_code in {401, 403}
                else EXIT_API_ERROR
            )
            code = "auth_error" if exit_code == EXIT_AUTH_ERROR else "api_error"
            raise CliError(
                code,
                message,
                {"status_code": response.status_code, "url": url},
                exit_code,
            )

        if response.status_code == 204:
            return {}

        try:
            return response.json()
        except ValueError:
            return {}

    @staticmethod
    def _extract_error_message(response: requests.Response) -> str:
        try:
            payload = response.json()
        except ValueError:
            return response.text or response.reason

        if isinstance(payload, dict):
            detail = payload.get("detail")
            if isinstance(detail, str):
                return detail
            if detail is not None:
                return str(detail)
        return response.text or response.reason

    @staticmethod
    def normalize_kind(kind: str) -> str:
        """Normalize singular, plural, alias, and case variants."""
        normalized = kind.lower()
        normalized = KIND_ALIASES.get(normalized, normalized)
        if normalized.endswith("s") and normalized[:-1] in VALID_KINDS:
            normalized = normalized[:-1]
        if normalized not in VALID_KINDS:
            raise CliError(
                "invalid_kind",
                f"Invalid kind: {kind}. Valid kinds: {', '.join(VALID_KINDS)}",
                {"kind": kind, "valid_kinds": VALID_KINDS},
            )
        return normalized

    def kind_path(self, kind: str) -> str:
        """Return Backend plural path segment for a kind."""
        return KIND_TO_PATH[self.normalize_kind(kind)]

    def list_kind(self, kind: str, namespace: str) -> Any:
        return self.request("GET", f"/v1/namespaces/{namespace}/{self.kind_path(kind)}")

    def get_kind(self, kind: str, namespace: str, name: str) -> Any:
        return self.request(
            "GET", f"/v1/namespaces/{namespace}/{self.kind_path(kind)}/{name}"
        )

    def apply_kinds(self, namespace: str, resources: list[dict[str, Any]]) -> Any:
        return self.request("POST", f"/v1/namespaces/{namespace}/apply", resources)

    def delete_kind(self, kind: str, namespace: str, name: str) -> Any:
        return self.request(
            "DELETE", f"/v1/namespaces/{namespace}/{self.kind_path(kind)}/{name}"
        )

    def delete_kinds(self, namespace: str, resources: list[dict[str, Any]]) -> Any:
        return self.request("POST", f"/v1/namespaces/{namespace}/delete", resources)

    def get_default_teams(self) -> Any:
        return self.request("GET", "/users/default-teams")

    def create_task(self, payload: dict[str, Any]) -> Any:
        return self.request("POST", "/tasks/create", payload)

    def get_task(self, task_id: int) -> Any:
        return self.request("GET", f"/tasks/{task_id}")

    def get_task_runtime(self, task_id: int) -> Any:
        return self.request("GET", f"/tasks/{task_id}/runtime-check")

    def cancel_task(self, task_id: int) -> Any:
        return self.request("POST", f"/tasks/{task_id}/cancel")

    def create_response(self, payload: dict[str, Any]) -> Any:
        return self.request("POST", "/v1/responses", payload)

    def get_response(self, response_id: str) -> Any:
        return self.request("GET", f"/v1/responses/{response_id}")

    def cancel_response(self, response_id: str) -> Any:
        return self.request("POST", f"/v1/responses/{response_id}/cancel")

    def delete_response(self, response_id: str) -> Any:
        return self.request("DELETE", f"/v1/responses/{response_id}")

    @staticmethod
    def _to_api_error(error: CliError) -> APIError:
        status_code = int(error.details.get("status_code") or 0)
        return APIError(status_code, error.message)

    def list_resources(
        self, kind: str, namespace: str, name_filter: Optional[str] = None
    ) -> list[dict[str, Any]]:
        try:
            result = self.list_kind(kind, namespace)
        except CliError as exc:
            raise self._to_api_error(exc) from exc

        items = result.get("items", []) if isinstance(result, dict) else result
        if name_filter and items:
            items = [
                item
                for item in items
                if name_filter.lower()
                in item.get("metadata", {}).get("name", "").lower()
            ]
        return items

    def get_resource(self, kind: str, namespace: str, name: str) -> Any:
        try:
            return self.get_kind(kind, namespace, name)
        except CliError as exc:
            raise self._to_api_error(exc) from exc

    def create_resource(self, namespace: str, resource: dict[str, Any]) -> Any:
        try:
            path = self.kind_path(resource.get("kind", ""))
            return self.request("POST", f"/v1/namespaces/{namespace}/{path}", resource)
        except CliError as exc:
            raise self._to_api_error(exc) from exc

    def update_resource(
        self, kind: str, namespace: str, name: str, resource: dict[str, Any]
    ) -> Any:
        try:
            return self.request(
                "PUT",
                f"/v1/namespaces/{namespace}/{self.kind_path(kind)}/{name}",
                resource,
            )
        except CliError as exc:
            raise self._to_api_error(exc) from exc

    def delete_resource(self, kind: str, namespace: str, name: str) -> Any:
        try:
            return self.delete_kind(kind, namespace, name)
        except CliError as exc:
            raise self._to_api_error(exc) from exc

    def apply_resources(self, namespace: str, resources: list[dict[str, Any]]) -> Any:
        try:
            return self.apply_kinds(namespace, resources)
        except CliError as exc:
            raise self._to_api_error(exc) from exc

    def delete_resources(self, namespace: str, resources: list[dict[str, Any]]) -> Any:
        try:
            return self.delete_kinds(namespace, resources)
        except CliError as exc:
            raise self._to_api_error(exc) from exc
