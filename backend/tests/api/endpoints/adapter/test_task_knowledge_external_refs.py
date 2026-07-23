# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.api.endpoints.adapter.task_knowledge_bases import (
    BindExternalKnowledgeRefsRequest,
    bind_external_knowledge_refs,
    get_bound_external_knowledge_refs,
)
from app.models.task import TaskResource
from app.schemas.external_knowledge import ExternalKnowledgeRef


def _user():
    user = Mock()
    user.id = 7
    return user


def _task():
    task = Mock(spec=TaskResource)
    task.id = 101
    task.json = {
        "spec": {
            "teamRef": {"name": "shared-agent", "user_id": 99},
            "externalKnowledgeRefs": [
                {
                    "provider": "demo-source",
                    "mode": "explicit",
                    "id": "kb-1",
                    "name": "Demo source",
                }
            ],
            "contextWarnings": [
                {
                    "type": "external_knowledge",
                    "reason": "not_configured",
                    "provider": "demo-source",
                    "id": "kb-2",
                    "message": "External knowledge source is not configured for the current user.",
                }
            ],
        }
    }
    return task


def test_get_bound_external_knowledge_refs_returns_context_warnings():
    task = _task()

    with patch(
        "app.api.endpoints.adapter.task_knowledge_bases._get_accessible_task_or_404",
        return_value=task,
    ):
        response = get_bound_external_knowledge_refs(
            task_id=101,
            current_user=_user(),
            db=Mock(),
        )

    assert response.total == 1
    assert response.context_warnings[0].reason == "not_configured"


def test_bind_external_knowledge_refs_materializes_valid_refs_and_warnings():
    task = _task()
    valid_ref = {
        "provider": "demo-source",
        "mode": "explicit",
        "id": "kb-valid",
        "name": "Valid source",
    }
    warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "provider": "demo-source",
        "id": "kb-denied",
        "message": "External knowledge source is not available for the current user.",
    }
    db = Mock()

    with (
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases._get_accessible_task_or_404",
            return_value=task,
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.filter_valid_external_knowledge_refs",
            return_value=([valid_ref], [warning]),
        ) as filter_refs,
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=Mock(id=99),
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.replace_task_context_warnings"
        ) as replace_warnings,
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.lock_task_for_knowledge_update",
            return_value=task,
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.sync_task_external_knowledge_refs",
            return_value=[valid_ref],
        ) as sync_refs,
    ):
        response = bind_external_knowledge_refs(
            task_id=101,
            request=BindExternalKnowledgeRefsRequest(
                refs=[
                    ExternalKnowledgeRef(
                        provider="demo-source",
                        mode="explicit",
                        id="kb-valid",
                    )
                ]
            ),
            current_user=_user(),
            db=db,
        )

    assert filter_refs.call_args.kwargs["actor_user_id"] == 99
    replace_warnings.assert_called_once()
    sync_refs.assert_called_once_with(db, task, [valid_ref])
    db.commit.assert_called_once()
    assert response.total == 1
    assert response.items[0].id == "kb-valid"


def test_bind_external_knowledge_refs_persists_warning_when_all_refs_are_invalid():
    task = _task()
    warning = {
        "type": "external_knowledge",
        "reason": "access_denied",
        "provider": "demo-source",
        "id": "kb-denied",
        "message": "External knowledge source is not available for the current user.",
    }
    db = Mock()

    with (
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases._get_accessible_task_or_404",
            return_value=task,
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.filter_valid_external_knowledge_refs",
            return_value=([], [warning]),
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases."
            "KnowledgeBindingResolver.resolve_task_owner_user",
            return_value=Mock(id=99),
        ),
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.replace_task_context_warnings"
        ) as replace_warnings,
        patch(
            "app.api.endpoints.adapter.task_knowledge_bases.lock_task_for_knowledge_update",
            return_value=task,
        ),
    ):
        with pytest.raises(HTTPException) as exc_info:
            bind_external_knowledge_refs(
                task_id=101,
                request=BindExternalKnowledgeRefsRequest(
                    refs=[
                        ExternalKnowledgeRef(
                            provider="demo-source",
                            mode="explicit",
                            id="kb-denied",
                        )
                    ]
                ),
                current_user=_user(),
                db=db,
            )

    assert exc_info.value.status_code == 400
    replace_warnings.assert_called_once()
    db.commit.assert_called_once()
    db.rollback.assert_not_called()
