# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.schemas.template import TemplateCreate, TemplateResources, TemplateUpdate
from app.services.template_service import template_service


def test_create_template_accepts_precise_ghost_skill_refs_only(mocker):
    db = mocker.Mock()
    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = None
    db.query.return_value = query
    mocker.patch.object(
        template_service, "_to_response", return_value=SimpleNamespace()
    )

    data = TemplateCreate(
        name="wiki-template",
        displayName="Wiki 模板",
        resources=TemplateResources.model_validate(
            {
                "ghost": {
                    "systemPrompt": "You are a helper.",
                    "skillRefs": [
                        {
                            "name": "wegent-knowledge",
                            "namespace": "default",
                            "user_id": 0,
                        }
                    ],
                    "preloadSkillRefs": [
                        {
                            "name": "wegent-knowledge",
                            "namespace": "default",
                            "user_id": 0,
                        }
                    ],
                },
                "queue": {"visibility": "private"},
            }
        ),
    )

    template_service.create_template(db, data)

    stored_template = db.add.call_args[0][0]
    assert stored_template.json["spec"]["resources"]["ghost"] == {
        "systemPrompt": "You are a helper.",
        "mcpServers": None,
        "skillRefs": [
            {"name": "wegent-knowledge", "namespace": "default", "user_id": 0}
        ],
        "preloadSkillRefs": [
            {"name": "wegent-knowledge", "namespace": "default", "user_id": 0}
        ],
    }


@pytest.mark.parametrize("template_cls", [TemplateCreate, TemplateUpdate])
def test_template_write_rejects_legacy_bot_model_namespace_field(mocker, template_cls):
    db = mocker.Mock()
    mocker.patch.object(
        template_service, "_to_response", return_value=SimpleNamespace()
    )
    query = mocker.Mock()
    query.filter.return_value = query
    query.first.return_value = None
    db.query.return_value = query

    resources = TemplateResources.model_validate(
        {
            "bot": {
                "shellName": "Chat",
                "agentConfig": {
                    "bind_model": "gpt-4.1",
                    "bind_model_type": "public",
                    "namespace": "default",
                },
            },
            "queue": {"visibility": "private"},
        }
    )

    if template_cls is TemplateCreate:
        data = template_cls(
            name="model-template",
            displayName="模型模板",
            resources=resources,
        )
        with pytest.raises(HTTPException) as exc_info:
            template_service.create_template(db, data)
    else:
        template = SimpleNamespace(
            id=1,
            name="legacy-template",
            kind="Template",
            is_active=True,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
            json={
                "spec": {
                    "displayName": "Legacy",
                    "category": "inbox",
                    "resources": {"queue": {"visibility": "private"}},
                }
            },
        )
        query.first.return_value = template
        data = template_cls(resources=resources)
        with pytest.raises(HTTPException) as exc_info:
            template_service.update_template(db, template.id, data)

    assert exc_info.value.status_code == 400
    assert "bind_model_namespace" in exc_info.value.detail
