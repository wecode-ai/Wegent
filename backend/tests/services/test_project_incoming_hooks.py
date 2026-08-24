# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for deterministic incoming hook payload normalization."""

import json

import pytest

from app.services.project_incoming_hooks import (
    normalize_incoming_payload,
    parse_incoming_body,
)


@pytest.mark.parametrize(
    ("payload", "headers", "provider", "title", "external_id"),
    [
        (
            {
                "action": "opened",
                "issue": {
                    "id": 100,
                    "number": 12,
                    "title": "GitHub issue",
                    "body": "Details",
                    "html_url": "https://github.example/acme/app/issues/12",
                },
                "repository": {"full_name": "acme/app"},
            },
            {"x-github-event": "issues"},
            "github",
            "GitHub issue",
            "acme/app#12",
        ),
        (
            {
                "object_kind": "issue",
                "object_attributes": {
                    "id": 200,
                    "iid": 8,
                    "action": "open",
                    "title": "GitLab issue",
                    "description": "Details",
                    "url": "https://gitlab.example/acme/app/-/issues/8",
                },
                "project": {"path_with_namespace": "acme/app"},
            },
            {"x-gitlab-event": "Issue Hook"},
            "gitlab",
            "GitLab issue",
            "acme/app#8",
        ),
        (
            {
                "action": "created",
                "data": {
                    "issue": {
                        "id": "sentry-1",
                        "title": "Unhandled exception",
                        "culprit": "checkout",
                        "web_url": "https://sentry.example/issues/1",
                    }
                },
            },
            {"sentry-hook-resource": "issue"},
            "sentry",
            "Unhandled exception",
            "sentry-1",
        ),
        (
            {
                "status": "firing",
                "title": "High latency",
                "message": "p95 exceeded",
                "alerts": [
                    {
                        "fingerprint": "alert-1",
                        "generatorURL": "https://grafana.example/alerting/1",
                    }
                ],
            },
            {},
            "grafana",
            "High latency",
            "alert-1",
        ),
        (
            {
                "eventId": "custom-1",
                "summary": "Customer escalation",
                "details": "Account requires attention",
                "url": "https://crm.example/tickets/1",
            },
            {},
            "generic",
            "Customer escalation",
            "custom-1",
        ),
    ],
)
def test_normalize_supported_payloads(
    payload: dict[str, object],
    headers: dict[str, str],
    provider: str,
    title: str,
    external_id: str,
) -> None:
    decision = normalize_incoming_payload(payload, headers)

    assert decision.provider == provider
    assert decision.candidate is not None
    assert decision.candidate.title == title
    assert decision.candidate.external_id == external_id


def test_normalize_ignores_resolved_grafana_alert() -> None:
    decision = normalize_incoming_payload(
        {"status": "resolved", "title": "Recovered", "alerts": []},
        {},
    )

    assert decision.provider == "grafana"
    assert decision.candidate is None
    assert decision.reason == "resolved state: resolved"


def test_generic_payload_requires_a_known_title_field() -> None:
    decision = normalize_incoming_payload({"unexpected": {"value": 1}}, {})

    assert decision.candidate is None
    assert decision.reason == "no deterministic title field found"


def test_parse_urlencoded_embedded_json() -> None:
    raw = b"payload=%7B%22title%22%3A%22Created+from+form%22%7D"

    assert parse_incoming_body(raw, "application/x-www-form-urlencoded") == {
        "title": "Created from form"
    }


def test_parse_plain_text_uses_first_line_as_title() -> None:
    payload = parse_incoming_body(b"Build failed\nSee logs", "text/plain")

    assert payload == {
        "title": "Build failed",
        "description": "Build failed\nSee logs",
    }


def test_parse_rejects_non_object_json() -> None:
    with pytest.raises(ValueError, match="must be an object"):
        parse_incoming_body(
            json.dumps(["not", "an", "object"]).encode(), "application/json"
        )
