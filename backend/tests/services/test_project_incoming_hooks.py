# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Tests for unified external event normalization and parsing."""

import pytest

from app.services.external_events.adapters import normalize_external_event
from app.services.project_incoming_hooks import parse_incoming_body


@pytest.mark.parametrize(
    ("payload", "headers", "provider", "opaque_ref", "event_type", "summary"),
    [
        (
            {
                "object_kind": "merge_request",
                "object_attributes": {
                    "id": 101,
                    "iid": 7,
                    "action": "merge",
                    "url": "https://gitlab.example/acme/app/-/merge_requests/7",
                },
                "project": {"path_with_namespace": "acme/app"},
            },
            {"x-gitlab-event": "Merge Request Hook"},
            "gitlab",
            "acme/app!7",
            "merged",
            "MR !7 merged",
        ),
        (
            {
                "object_kind": "pipeline",
                "object_attributes": {"id": 456, "status": "failed"},
                "merge_request": {"iid": 7},
                "project": {
                    "path_with_namespace": "acme/app",
                    "web_url": "https://gitlab.example/acme/app",
                },
            },
            {"x-gitlab-event": "Pipeline Hook"},
            "gitlab",
            "acme/app!7",
            "ci_failed",
            "Pipeline #456 failed",
        ),
        (
            {
                "object_kind": "note",
                "object_attributes": {
                    "id": 202,
                    "noteable_type": "MergeRequest",
                    "url": "https://gitlab.example/acme/app/-/merge_requests/7#note_1",
                },
                "merge_request": {"iid": 7},
                "project": {"path_with_namespace": "acme/app"},
                "user": {"username": "alice"},
            },
            {"x-gitlab-event": "Note Hook"},
            "gitlab",
            "acme/app!7",
            "review_comment",
            "New comment by alice",
        ),
        (
            {
                "opaque_ref": "ticket-42",
                "event_type": "resolved",
                "event_id": "evt-1",
                "summary": "Ticket 42 resolved",
                "source_url": "https://crm.example/tickets/42",
            },
            {"x-event-provider": "crm"},
            "crm",
            "ticket-42",
            "resolved",
            "Ticket 42 resolved",
        ),
    ],
)
def test_normalize_external_events(
    payload: dict[str, object],
    headers: dict[str, str],
    provider: str,
    opaque_ref: str,
    event_type: str,
    summary: str,
) -> None:
    event = normalize_external_event(payload, headers)

    assert event is not None
    assert event.provider == provider
    assert event.opaque_ref == opaque_ref
    assert event.event_type == event_type
    assert event.summary == summary


def test_normalize_ignores_unrelated_gitlab_events() -> None:
    assert (
        normalize_external_event(
            {
                "object_kind": "merge_request",
                "object_attributes": {"action": "close"},
                "project": {"path_with_namespace": "acme/app"},
            },
            {},
        )
        is None
    )


def test_normalize_ignores_unstructured_payloads() -> None:
    assert normalize_external_event({"unknown": True}, {}) is None


def test_parse_incoming_body_json_and_form() -> None:
    payload = {"event_type": "merged", "opaque_ref": "acme/app!7"}
    assert parse_incoming_body(b'{"event_type":"merged","opaque_ref":"acme/app!7"}', "application/json") == payload
    form = parse_incoming_body(b"payload=%7B%22event_type%22%3A%22merged%22%7D", "application/x-www-form-urlencoded")
    assert form.get("event_type") == "merged"
