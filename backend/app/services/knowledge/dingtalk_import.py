# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Live DingTalk node resolution over the existing external import lifecycle."""

from sqlalchemy.orm import Session

from app.models.user import User
from app.schemas.knowledge import ContentOrigin
from app.services.knowledge.external_document_import import (
    ExternalDocumentBatchImportResult,
    ExternalDocumentImportService,
)
from app.services.knowledge.external_document_providers import (
    DingTalkExternalDocumentProvider,
    ExternalDocumentImportError,
)
from app.services.knowledge.folder_policy import assert_document_can_be_placed_in_folder
from shared.telemetry.decorators import trace_async


class DingTalkDocumentImportService(ExternalDocumentImportService):
    """Resolve live nodes, retaining the shared creation and refresh machinery."""

    @trace_async(tracer_name="knowledge.external_import")
    async def import_node(
        self,
        db: Session,
        user: User,
        knowledge_base_id: int,
        node_id: str,
        folder_id: int = 0,
    ) -> ExternalDocumentBatchImportResult:
        provider = self._validate_direct_import_context(
            db, user, knowledge_base_id, "dingtalk"
        )
        if (
            not node_id
            or len(node_id) > 255
            or not node_id.isprintable()
            or any(character.isspace() or character in "/?#" for character in node_id)
        ):
            raise ExternalDocumentImportError("Provide a DingTalk node ID, not a URL")
        if folder_id:
            assert_document_can_be_placed_in_folder(
                db, knowledge_base_id, folder_id, content_origin=ContentOrigin.USER
            )
        assert isinstance(provider, DingTalkExternalDocumentProvider)
        result = ExternalDocumentBatchImportResult([], [], [], requested_count=1)
        existing = self._find_existing_document(
            db, knowledge_base_id, "dingtalk", node_id
        )
        if existing is not None and self._is_processing(existing):
            result.processing.append(existing)
            return result

        source_user = db.get(User, existing.user_id) if existing is not None else user
        if source_user is None or not source_user.is_active:
            raise ExternalDocumentImportError("The original importer is unavailable")
        metadata = await provider.resolve_live_importable(db, source_user, node_id)
        if existing is not None:
            refresh = self.refresh_existing_document(db, existing, metadata)
            (result.updated if refresh.started else result.processing).append(
                refresh.document
            )
        else:
            result.created = self._create_batch_documents(
                db,
                user,
                provider,
                knowledge_base_id,
                folder_id,
                [(node_id, metadata)],
                result.processing,
            )
        return result


dingtalk_document_import_service = DingTalkDocumentImportService()
