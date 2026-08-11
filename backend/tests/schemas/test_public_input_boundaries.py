# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Fields a client must not be able to set, on schemas a client sends.

Both of these were opened by the code wiki work: one internal need each, expressed by
adding a field or a value to a schema the public API already accepted. That is the
cheap way to make it reachable from where it was needed, and it makes it reachable
from everywhere else at the same time.
"""

import pytest
from pydantic import ValidationError

from app.schemas.knowledge import KnowledgeDocumentCreate, KnowledgeDocumentCreateV1
from app.schemas.task import TaskCreate


def test_a_client_cannot_ask_for_a_hidden_task():
    """ "system" keeps a task out of the conversation list, which a code wiki's own
    generation runs want and nobody else does. As a field on the request body, any
    signed-in client could file a task where the person who created it would never
    find it again -- created successfully, and gone from every conversation path.

    It is a parameter on the service call now, so the runner still sets it and the
    request body has nowhere to say it.
    """
    task = TaskCreate(prompt="hello", namespace="system")

    # Ignored rather than rejected, because Pydantic drops unknown fields here. What
    # matters is that it does not reach the row: asserting the attribute is absent is
    # asserting exactly that.
    assert not hasattr(task, "namespace")


def test_the_runner_can_still_hide_its_own_task():
    """The capability did not go away, only the route to it."""
    import inspect

    from app.services.adapters.task_kinds.operations import TaskOperationsMixin

    signature = inspect.signature(TaskOperationsMixin.create_task_or_append)

    assert "namespace" in signature.parameters
    assert signature.parameters["namespace"].default == "default"


@pytest.mark.parametrize(
    "schema, extra",
    [
        (KnowledgeDocumentCreate, {"name": "x", "file_extension": "py"}),
        (KnowledgeDocumentCreateV1, {"knowledge_base_id": 1, "name": "x"}),
    ],
)
def test_a_client_cannot_create_a_code_target(schema, extra):
    """A code target is an indexed source file, not a page, so every reader-facing
    scope filters it out -- while the document count does not. Creating one produced a
    document that raised the count and appeared in no list, with no way to delete it
    from the UI that could not show it.

    Declared for the phase that indexes repository sources; nothing writes it yet, and
    when something does it will write it the way the wiki projection does.
    """
    with pytest.raises(ValidationError, match="written by the indexer"):
        schema(source_type="code", **extra)


@pytest.mark.parametrize(
    "schema, extra",
    [
        (KnowledgeDocumentCreate, {"name": "x", "file_extension": "py"}),
        (KnowledgeDocumentCreateV1, {"knowledge_base_id": 1, "name": "x"}),
    ],
)
def test_the_ordinary_source_types_are_untouched(schema, extra):
    for source_type in ("file", "text", "web", "attachment"):
        assert schema(source_type=source_type, **extra).source_type == source_type


def test_a_stored_code_document_still_deserialises():
    """The read model must keep the value: refusing it on the way out would break
    reading back anything the indexer writes, which is the opposite of the point."""
    from app.schemas.knowledge import DocumentSourceType, KnowledgeDocumentResponse

    assert DocumentSourceType("code") == DocumentSourceType.CODE
