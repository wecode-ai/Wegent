"""HTTP client for Wegent API."""

from typing import Any, Dict, List, Optional

import requests

from .config import get_server, get_token

# Valid resource kinds
VALID_KINDS = ["ghost", "model", "shell", "bot", "team", "workspace", "task", "skill"]

# Kind to API path mapping (plural form)
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

# Short aliases
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


class APIError(Exception):
    """API error with status code and message."""

    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        self.message = message
        super().__init__(f"API Error {status_code}: {message}")


class WegentClient:
    """Client for Wegent API."""

    def __init__(self, server: Optional[str] = None, token: Optional[str] = None):
        self.server = (server or get_server()).rstrip("/")
        self.token = token or get_token()

    def _headers(self) -> Dict[str, str]:
        """Build request headers."""
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _request(
        self, method: str, path: str, data: Optional[Dict] = None
    ) -> Dict[str, Any]:
        """Make HTTP request to API."""
        url = f"{self.server}/api{path}"
        try:
            response = requests.request(
                method, url, json=data, headers=self._headers(), timeout=30
            )
        except requests.exceptions.ConnectionError:
            raise APIError(0, f"Failed to connect to server: {self.server}")
        except requests.exceptions.Timeout:
            raise APIError(0, "Request timeout")

        if response.status_code >= 400:
            try:
                error = response.json()
                message = error.get("detail", str(error))
            except Exception:
                message = response.text or response.reason
            raise APIError(response.status_code, message)

        if response.status_code == 204:
            return {}

        try:
            return response.json()
        except Exception:
            return {}

    @staticmethod
    def normalize_kind(kind: str) -> str:
        """Normalize kind name (handle aliases and case)."""
        kind = kind.lower()
        # Handle aliases
        if kind in KIND_ALIASES:
            kind = KIND_ALIASES[kind]
        # Handle plural forms
        if kind.endswith("s") and kind[:-1] in VALID_KINDS:
            kind = kind[:-1]
        if kind not in VALID_KINDS:
            raise ValueError(
                f"Invalid kind: {kind}. Valid kinds: {', '.join(VALID_KINDS)}"
            )
        return kind

    def list_resources(
        self, kind: str, namespace: str, name_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """List resources of a kind in namespace."""
        kind = self.normalize_kind(kind)
        path = KIND_TO_PATH[kind]
        result = self._request("GET", f"/v1/namespaces/{namespace}/{path}")
        items = result.get("items", []) if isinstance(result, dict) else result

        # Filter by name if provided
        if name_filter and items:
            items = [
                item for item in items
                if name_filter.lower() in item.get("metadata", {}).get("name", "").lower()
            ]
        return items

    def get_resource(self, kind: str, namespace: str, name: str) -> Dict[str, Any]:
        """Get a specific resource."""
        kind = self.normalize_kind(kind)
        path = KIND_TO_PATH[kind]
        return self._request("GET", f"/v1/namespaces/{namespace}/{path}/{name}")

    def create_resource(self, namespace: str, resource: Dict[str, Any]) -> Dict[str, Any]:
        """Create a resource."""
        kind = resource.get("kind", "").lower()
        kind = self.normalize_kind(kind)
        path = KIND_TO_PATH[kind]
        return self._request("POST", f"/v1/namespaces/{namespace}/{path}", resource)

    def update_resource(
        self, kind: str, namespace: str, name: str, resource: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Update a resource."""
        kind = self.normalize_kind(kind)
        path = KIND_TO_PATH[kind]
        return self._request(
            "PUT", f"/v1/namespaces/{namespace}/{path}/{name}", resource
        )

    def delete_resource(self, kind: str, namespace: str, name: str) -> Dict[str, Any]:
        """Delete a resource."""
        kind = self.normalize_kind(kind)
        path = KIND_TO_PATH[kind]
        return self._request("DELETE", f"/v1/namespaces/{namespace}/{path}/{name}")

    def apply_resources(
        self, namespace: str, resources: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Batch apply resources."""
        return self._request("POST", f"/v1/namespaces/{namespace}/apply", resources)

    def delete_resources(
        self, namespace: str, resources: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Batch delete resources."""
        return self._request("POST", f"/v1/namespaces/{namespace}/delete", resources)
