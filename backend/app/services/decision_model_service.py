# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connection probe for decision-model providers."""

from typing import Any

import httpx

from app.schemas.decision import DecisionRequest
from app.services.decision_protocol import (
    build_decision_payload,
    normalize_decision_response,
)
from shared.utils.decision_model import decision_endpoint


class DecisionError(Exception):
    """A static, client-safe error, never a provider body or credential."""

    def __init__(
        self, status: int, code: str, message: str, retryable: bool = False
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable


def _upstream_headers(config: dict[str, Any], request_id: str) -> dict[str, str]:
    protected = {
        "authorization",
        "content-type",
        "accept",
        "host",
        "content-length",
        "connection",
        "cookie",
        "proxy-authorization",
        "x-request-id",
    }
    headers = {
        name: value
        for name, value in (config.get("default_headers") or {}).items()
        if isinstance(name, str)
        and isinstance(value, str)
        and name.lower() not in protected
    }
    return {
        **headers,
        "Authorization": f"Bearer {config['api_key']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Request-Id": request_id,
    }


def check_decision_upstream_status(status: int) -> None:
    if status == 429:
        raise DecisionError(
            429, "upstream_rate_limited", "Decision upstream is rate limited", True
        )
    if status >= 500:
        raise DecisionError(
            502, "upstream_rejected", "Decision upstream is unavailable", True
        )
    if not 200 <= status < 300:
        raise DecisionError(
            502, "upstream_rejected", "Decision upstream rejected the request"
        )


def test_decision_connection(
    protocol: str, model_id: str, api_key: str, base_url: str, custom_headers: dict
) -> dict[str, Any]:
    """Exercise the declared decision endpoint instead of a chat/model-list API."""
    try:
        endpoint = decision_endpoint(base_url, protocol)
        request = DecisionRequest(
            model="connection-test",
            state="Connection test",
            questions={
                "connected": {
                    "type": "noul",
                    "instructions": "Is this a connection test?",
                }
            },
        )
        config = {"api_key": api_key, "default_headers": custom_headers}
        with httpx.Client(timeout=30, follow_redirects=False) as client:
            response = client.post(
                endpoint,
                json=build_decision_payload(request, protocol, model_id),
                headers=_upstream_headers(config, "decision_connection_test"),
            )
        check_decision_upstream_status(response.status_code)
        normalize_decision_response(response.json(), request, protocol)
        return {"success": True, "message": "Decision connection successful"}
    except (DecisionError, httpx.HTTPError, ValueError, TypeError, KeyError):
        return {"success": False, "message": "Decision connection failed"}
