# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Decision Model CRD validation shared by management and execution."""

import re
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

DECISION_PROTOCOLS = {"systemone": "systemone", "openai": "decisions"}


def decision_endpoint(base_url: str, protocol: str) -> str:
    """Accept an HTTPS API base or the exact endpoint for the declared protocol."""
    endpoint = DECISION_PROTOCOLS.get(protocol)
    if endpoint is None:
        raise ValueError("Decision protocol must be systemone or openai")
    try:
        parsed = urlsplit(base_url.strip())
        _ = parsed.port
    except ValueError:
        raise ValueError("Decision base_url must be a valid HTTPS URL") from None
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or "?" in base_url
        or "#" in base_url
    ):
        raise ValueError("Decision base_url must be a plain HTTPS URL")
    segments = parsed.path.rstrip("/").split("/")
    if segments[-1] in DECISION_PROTOCOLS.values():
        if segments[-1] != endpoint:
            raise ValueError("Decision endpoint does not match protocol")
    elif segments[-1] == "v1":
        segments.append(endpoint)
    elif not parsed.path.rstrip("/"):
        segments = ["", "v1", endpoint]
    else:
        raise ValueError("Decision base_url must end in /v1 or the protocol endpoint")
    return urlunsplit(parsed._replace(path="/".join(segments)))


def validate_decision_model_spec(spec: Mapping[str, Any]) -> None:
    """Validate only decision declarations, leaving other model types unchanged."""
    from shared.utils.model_category import resolve_model_category

    if resolve_model_category(spec) != "decision":
        return
    protocol = spec.get("protocol")
    if not isinstance(protocol, str) or protocol not in DECISION_PROTOCOLS:
        raise ValueError("Decision protocol must be systemone or openai")
    if spec.get("apiFormat") is not None:
        raise ValueError("Decision models must not declare a chat apiFormat")
    config = spec.get("modelConfig")
    env = config.get("env") if isinstance(config, Mapping) else None
    if not isinstance(env, Mapping):
        raise ValueError("Decision modelConfig.env is required")
    for field in ("model_id", "base_url", "api_key"):
        value = env.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"Decision modelConfig.env.{field} is required")
    if (
        len(env["model_id"]) > 128
        or re.fullmatch(r"[A-Za-z0-9._/:-]+", env["model_id"]) is None
    ):
        raise ValueError("Decision model_id must be a valid model identifier")
    headers = env.get("custom_headers")
    if headers is not None and (
        not isinstance(headers, Mapping)
        or any(not isinstance(value, str) for value in headers.values())
    ):
        raise ValueError("Decision custom_headers must contain string values")
    decision_endpoint(env["base_url"], protocol)
