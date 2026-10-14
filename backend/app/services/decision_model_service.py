# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authorized Model CRD catalog and execution for the decision workbench."""

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

import httpx
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.decision import DecisionRequest
from app.schemas.kind import ModelSpec
from app.services.capability_reference_service import get_referenced_capability
from app.services.chat.config.model_resolver import extract_and_process_model_config
from app.services.decision_protocol import (
    build_decision_payload,
    normalize_decision_response,
)
from app.services.model_aggregation_service import model_aggregation_service
from shared.telemetry.decorators import trace_async
from shared.utils.decision_model import decision_endpoint

logger = logging.getLogger(__name__)
MAX_DECISION_BYTES = 1024 * 1024


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


def _model_key(model: dict[str, Any]) -> str:
    identity = [
        model["type"],
        model.get("namespace", "default"),
        model.get("resourceUserId"),
        model["name"],
    ]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


def _available_models(db: Session, user: User) -> list[dict[str, Any]]:
    return model_aggregation_service.list_available_models(
        db,
        user,
        scope="all",
        model_category_type="decision",
        client_origin="wework",
    )


def decision_model_catalog(db: Session, user: User) -> dict[str, Any]:
    models = [
        {
            "id": _model_key(model),
            "displayName": model.get("displayName") or model["name"],
            "modelId": model.get("modelId"),
            "protocol": model["config"]["protocol"],
            "type": model["type"],
            "namespace": model.get("namespace", "default"),
        }
        for model in _available_models(db, user)
    ]
    return {
        "protocolVersion": 1,
        "defaultModel": models[0]["id"] if models else "",
        "models": models,
    }


def _resolve_model(
    db: Session, user: User, model_id: str
) -> tuple[str, dict[str, Any]]:
    model = next(
        (item for item in _available_models(db, user) if _model_key(item) == model_id),
        None,
    )
    if model is None:
        raise DecisionError(404, "model_not_found", "Decision model is not available")
    if model.get("isReference"):
        resource = get_referenced_capability(
            db,
            kind="Model",
            name=model["name"],
            user_id=user.id,
            namespace=model["namespace"],
        )
        if resource and resource.user_id != model.get("resourceUserId"):
            resource = None
    else:
        resource = (
            db.query(Kind)
            .filter_by(
                kind="Model",
                user_id=model["resourceUserId"],
                namespace=model["namespace"],
                name=model["name"],
                is_active=True,
            )
            .first()
        )
    if resource is None:
        raise DecisionError(404, "model_not_found", "Decision model is not available")
    try:
        spec = ModelSpec.model_validate(resource.json["spec"])
        config = extract_and_process_model_config(
            spec.model_dump(mode="json"), user.id, user.user_name or ""
        )
        if not config.get("api_key") or "${" in config["api_key"]:
            raise ValueError("Unresolved decision credential")
        return spec.protocol, config
    except (ValueError, KeyError, TypeError):
        raise DecisionError(
            503, "invalid_model_config", "Decision model configuration is unusable"
        ) from None


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


@trace_async("execute_decision", "backend.decisions")
async def execute_decision(
    db: Session, user: User, request: DecisionRequest, request_id: str
) -> dict[str, Any]:
    protocol, config = await run_in_threadpool(_resolve_model, db, user, request.model)
    endpoint = decision_endpoint(config["base_url"], protocol)
    payload = build_decision_payload(request, protocol, config["model_id"])
    started = time.monotonic()
    try:
        async with (
            asyncio.timeout(30),
            httpx.AsyncClient(timeout=30, follow_redirects=False) as client,
        ):
            async with client.stream(
                "POST",
                endpoint,
                json=payload,
                headers=_upstream_headers(config, request_id),
            ) as response:
                check_decision_upstream_status(response.status_code)
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > MAX_DECISION_BYTES:
                        raise ValueError("Decision response exceeds the limit")
        result = normalize_decision_response(json.loads(body), request, protocol)
    except (TimeoutError, httpx.TimeoutException):
        raise DecisionError(
            504, "upstream_timeout", "Decision upstream timed out", True
        ) from None
    except httpx.RequestError:
        raise DecisionError(
            502, "upstream_rejected", "Decision upstream is unavailable", True
        ) from None
    except (ValueError, TypeError, KeyError):
        raise DecisionError(
            502, "upstream_invalid_response", "Decision upstream response is unusable"
        ) from None
    result["request_id"] = request_id
    result["latency_ms"] = round((time.monotonic() - started) * 1000)
    logger.info(
        "Decision completed request_id=%s user_id=%s model=%s protocol=%s questions=%s",
        request_id,
        user.id,
        request.model,
        protocol,
        len(request.questions),
    )
    return result


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
