# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the conversion completion callback endpoint.

Covers the staleness race fixed in this change: a late callback from a
superseded generation must not create an orphan Markdown attachment nor point
converted_attachment_id at stale content (which DocumentReadService would then
prefer over the original).
"""

import base64
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from app.api.endpoints.internal.conversion_callback import (
    conversion_completed_callback,
)
from app.schemas.conversion_callback import ConversionCompletedRequest


def _make_request(
    *,
    document_id: int = 1,
    generation: int = 5,
    attachment_id: int = 20,
    markdown: bytes = b"# Converted title",
) -> ConversionCompletedRequest:
    """Build a valid ConversionCompletedRequest for tests."""
    return ConversionCompletedRequest(
        document_id=document_id,
        generation=generation,
        converted_name="doc.md",
        converted_extension="md",
        file_size=100,
        markdown_bytes=base64.b64encode(markdown).decode(),
        index_dispatch_payload={
            "attachment_id": attachment_id,
            "knowledge_base_id": 10,
            "document_id": document_id,
        },
    )


def _build_db_chain(*query_results: MagicMock) -> MagicMock:
    """Wire up a mock db whose successive db.query(...) calls return each result."""
    db = MagicMock()
    db.query.side_effect = list(query_results)
    return db


def _query_first(value) -> MagicMock:
    q = MagicMock()
    q.filter.return_value.first.return_value = value
    return q


def _query_count(value: int) -> MagicMock:
    q = MagicMock()
    q.filter.return_value.count.return_value = value
    return q


@pytest.mark.unit
class TestConversionCompletedCallback:
    def test_creates_converted_attachment_and_dispatches_index(self) -> None:
        """Happy path: pre-check passes -> create attachment -> dispatch indexing."""
        doc = SimpleNamespace(
            id=1,
            attachment_id=20,
            kind_id=10,
            converted_attachment_id=None,
            user_id=42,
        )
        original_attachment = SimpleNamespace(id=20, user_id=42)
        converted_context = SimpleNamespace(id=30)

        db = _build_db_chain(
            _query_first(doc),
            _query_first(original_attachment),
            _query_count(1),  # pre-check: current generation
        )
        request = _make_request()

        with (
            patch(
                "app.api.endpoints.internal.conversion_callback.context_service"
            ) as mock_ctx,
            patch(
                "app.api.endpoints.internal.conversion_callback.mark_document_conversion_succeeded",
                return_value=True,
            ) as mock_succeeded,
            patch(
                "app.api.endpoints.internal.conversion_callback.index_document_task"
            ) as mock_task,
        ):
            mock_ctx.upload_attachment.return_value = (converted_context, None)
            mock_task.delay.return_value = SimpleNamespace(id="celery-task-1")

            response = conversion_completed_callback(request=request, db=db)

        assert response.ok is True
        assert response.skipped is False
        assert response.index_task_id == "celery-task-1"
        # converted_attachment_id now points at the new attachment
        assert doc.converted_attachment_id == 30
        # indexing dispatched with the converted attachment id, not the original
        mock_task.delay.assert_called_once()
        assert mock_task.delay.call_args.kwargs["attachment_id"] == 30
        mock_ctx.upload_attachment.assert_called_once()
        mock_succeeded.assert_called_once()

    def test_stale_precheck_skips_without_side_effects(self) -> None:
        """A superseded generation must create no attachment and dispatch nothing."""
        doc = SimpleNamespace(
            id=1,
            attachment_id=20,
            kind_id=10,
            converted_attachment_id=None,
            user_id=42,
        )
        original_attachment = SimpleNamespace(id=20, user_id=42)

        db = _build_db_chain(
            _query_first(doc),
            _query_first(original_attachment),
            _query_count(0),  # pre-check: stale generation
        )
        request = _make_request(generation=3)  # older generation

        with (
            patch(
                "app.api.endpoints.internal.conversion_callback.context_service"
            ) as mock_ctx,
            patch(
                "app.api.endpoints.internal.conversion_callback.mark_document_conversion_succeeded"
            ) as mock_succeeded,
            patch(
                "app.api.endpoints.internal.conversion_callback.index_document_task"
            ) as mock_task,
        ):
            response = conversion_completed_callback(request=request, db=db)

        assert response.ok is True
        assert response.skipped is True
        assert response.skip_reason == "stale_conversion"
        # No mutation happened at all
        assert doc.converted_attachment_id is None
        mock_ctx.upload_attachment.assert_not_called()
        mock_ctx.delete_context.assert_not_called()
        mock_task.delay.assert_not_called()
        mock_succeeded.assert_not_called()

    def test_stale_race_window_rolls_back_attachment(self) -> None:
        """Staleness detected only at the transition must roll back the attachment."""
        doc = SimpleNamespace(
            id=1,
            attachment_id=20,
            kind_id=10,
            converted_attachment_id=999,  # previous reference, must be restored
            user_id=42,
        )
        original_attachment = SimpleNamespace(id=20, user_id=42)
        converted_context = SimpleNamespace(id=30)

        db = _build_db_chain(
            _query_first(doc),
            _query_first(original_attachment),
            _query_count(1),  # pre-check passes...
        )
        request = _make_request(generation=3)

        with (
            patch(
                "app.api.endpoints.internal.conversion_callback.context_service"
            ) as mock_ctx,
            patch(
                "app.api.endpoints.internal.conversion_callback.mark_document_conversion_succeeded",
                return_value=False,  # ...but a newer generation won the race
            ) as mock_succeeded,
            patch(
                "app.api.endpoints.internal.conversion_callback.index_document_task"
            ) as mock_task,
        ):
            mock_ctx.upload_attachment.return_value = (converted_context, None)

            response = conversion_completed_callback(request=request, db=db)

        assert response.skipped is True
        assert response.skip_reason == "stale_conversion"
        # Rollback: orphan attachment deleted, reference restored to previous value
        mock_ctx.delete_context.assert_called_once_with(
            db=db, context_id=30, user_id=42
        )
        assert doc.converted_attachment_id == 999
        mock_task.delay.assert_not_called()
        mock_succeeded.assert_called_once()

    def test_attachment_id_mismatch_returns_400(self) -> None:
        """Payload attachment_id must match the document's attachment_id."""
        doc = SimpleNamespace(id=1, attachment_id=20, kind_id=10, user_id=42)
        db = _build_db_chain(_query_first(doc))
        request = _make_request(attachment_id=999)  # mismatch

        with pytest.raises(HTTPException) as exc:
            conversion_completed_callback(request=request, db=db)

        assert exc.value.status_code == 400

    def test_invalid_base64_returns_400(self) -> None:
        """Malformed base64 must fail before any DB mutation."""
        db = MagicMock()
        request = ConversionCompletedRequest(
            document_id=1,
            generation=5,
            converted_name="doc.md",
            converted_extension="md",
            file_size=100,
            markdown_bytes="@@@not-base64@@@",
            index_dispatch_payload={"attachment_id": 20},
        )

        with pytest.raises(HTTPException) as exc:
            conversion_completed_callback(request=request, db=db)

        assert exc.value.status_code == 400
        db.query.assert_not_called()

    def test_missing_document_returns_400(self) -> None:
        """Unknown document_id is rejected before any mutation."""
        db = _build_db_chain(_query_first(None))
        request = _make_request()

        with pytest.raises(HTTPException) as exc:
            conversion_completed_callback(request=request, db=db)

        assert exc.value.status_code == 400
