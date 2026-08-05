# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
API endpoints for knowledge base and document management.

REST API endpoints delegate business logic to KnowledgeOrchestrator,
which provides a unified interface for both REST API and MCP tools.
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Response,
    status,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints._knowledge_multimodal import (
    multimodal_create_kwargs,
    multimodal_update_kwargs,
)
from app.api.knowledge_document_side_effects import (
    schedule_kb_summary_updates_after_deletion,
)
from app.core import security
from app.core.config import settings
from app.core.exceptions import CustomHTTPException
from app.core.wiki_config import wiki_settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge import (
    AccessibleKnowledgeResponse,
    AllGroupedKnowledgeResponse,
    BatchDocumentIds,
    BatchOperationResult,
    CodeWikiCreate,
    CodeWikiExisting,
    CodeWikiListItem,
    CodeWikiListResponse,
    CodeWikiPageNode,
    CodeWikiPageTree,
    CodeWikiResolveRequest,
    CodeWikiResolveResponse,
    CodeWikiRunCreate,
    CodeWikiRunHistory,
    CodeWikiRunRecord,
    CodeWikiRunResponse,
    CodeWikiRunStatus,
    DocumentContentUpdate,
    DocumentDetailResponse,
    DocumentMoveRequest,
    InitialMemberCreate,
    KnowledgeBaseCreate,
    KnowledgeBaseListResponse,
    KnowledgeBaseResponse,
    KnowledgeBaseType,
    KnowledgeBaseTypeUpdate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentListResponse,
    KnowledgeDocumentResponse,
    KnowledgeDocumentSortField,
    KnowledgeDocumentUpdate,
    KnowledgeFolderCreate,
    KnowledgeFolderResponse,
    KnowledgeFolderUpdate,
    PersonalKnowledgeBaseGroup,
    ResourceScope,
    SortOrder,
)
from app.schemas.knowledge_multimodal import DocumentReindexRequest
from app.schemas.knowledge_qa_history import QAHistoryResponse
from app.schemas.summary import KnowledgeBaseSummaryUpdateRequest
from app.services.knowledge import (
    KnowledgeFolderService,
    KnowledgeService,
    knowledge_base_qa_service,
)
from app.services.knowledge.code_wiki.diagnostics import diagnose
from app.services.knowledge.code_wiki.generation import (
    GenerationInFlight,
    current_run_state,
    run_history,
)
from app.services.knowledge.code_wiki.navigation import page_tree
from app.services.knowledge.code_wiki.publisher import (
    PUBLISHED_AT_KEY,
    PUBLISHED_COMMIT_KEY,
)
from app.services.knowledge.code_wiki.registry import (
    CODE_WIKI_NAMESPACE,
    claim_repository,
    existing_wiki_id,
    existing_wikis_for,
)
from app.services.knowledge.code_wiki.resolution import resolve_repository
from app.services.knowledge.code_wiki.run_mode import ChangedPath
from app.services.knowledge.code_wiki.runner import CodeWikiRunError, start_run
from app.services.knowledge.code_wiki.source import (
    SourceAccessDenied,
    SourceRepository,
    assert_user_can_read_source,
    assert_user_can_write_source,
)
from app.services.knowledge.orchestrator import (
    DEFAULT_KNOWLEDGE_LIST_LIMIT,
    MAX_DOCUMENT_READ_LIMIT,
    MAX_KNOWLEDGE_LIST_LIMIT,
    knowledge_orchestrator,
)
from shared.telemetry.decorators import (
    add_span_event,
    trace_async,
    trace_sync,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _serialize_standalone_document_detail(
    detail: DocumentDetailResponse | dict,
    *,
    include_content: bool,
    include_summary: bool,
) -> dict:
    """Preserve the standalone endpoint's pre-refactor response shape."""
    payload = detail.model_dump() if hasattr(detail, "model_dump") else dict(detail)
    response = {
        "document_id": payload["document_id"],
    }
    if include_content:
        response["content"] = payload.get("content")
        response["content_length"] = payload.get("content_length")
        response["truncated"] = payload.get("truncated")
    if include_summary:
        response["summary"] = payload.get("summary")
    return response


def _dump_retrieval_config_for_api(retrieval_config) -> dict | None:
    if retrieval_config is None:
        return None
    return retrieval_config.model_dump(exclude_unset=True)


def _raise_document_detail_http_error(error: ValueError) -> None:
    """Map orchestrator/service errors to stable HTTP responses.

    Mapping rules:
    - "not found"  -> 404
    - "access denied" or "permission" -> 403
    - anything else -> 400
    """
    if isinstance(error, CustomHTTPException):
        raise error

    error_msg = str(error)
    lower = error_msg.lower()
    if "not found" in lower:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=error_msg,
        )
    if "access denied" in lower or "permission" in lower:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=error_msg,
        )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=error_msg,
    )


def _validate_knowledge_base_access_or_raise(
    db: Session,
    *,
    knowledge_base_id: int,
    user: User,
):
    """Restore the KB-scoped endpoint's KB-level error semantics."""
    knowledge_base, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=knowledge_base_id,
        user_id=user.id,
    )
    if not knowledge_base:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )
    return knowledge_base


# ============== Knowledge Base Endpoints ==============


@router.get("", response_model=KnowledgeBaseListResponse)
@trace_sync("list_knowledge_bases", "knowledge.api")
def list_knowledge_bases(
    scope: str = Query(
        default="all",
        description="Resource scope: personal, group, organization, or all",
    ),
    group_name: Optional[str] = Query(
        default=None,
        description="Group name (required when scope is group)",
    ),
    limit: int = Query(
        default=DEFAULT_KNOWLEDGE_LIST_LIMIT,
        ge=1,
        le=MAX_KNOWLEDGE_LIST_LIMIT,
        description="Maximum number of knowledge bases to return",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Start offset for paginated knowledge base listing",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List knowledge bases based on scope.

    - **scope=personal**: Only user's own personal knowledge bases
    - **scope=group**: Knowledge bases from a specific group (requires group_name)
    - **scope=organization**: Organization knowledge bases (visible to all, admin only for management)
    - **scope=all**: All accessible knowledge bases (personal + team)
    """
    try:
        resource_scope = ResourceScope(scope)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid scope: {scope}. Must be one of: personal, group, organization, all",
        )

    if resource_scope == ResourceScope.GROUP and not group_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="group_name is required when scope is group",
        )

    # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
    return knowledge_orchestrator.list_knowledge_bases(
        db=db,
        user=current_user,
        scope=scope,
        group_name=group_name,
        limit=limit,
        offset=offset,
    )


@router.get("/accessible", response_model=AccessibleKnowledgeResponse)
@trace_sync("get_accessible_knowledge", "knowledge.api")
def get_accessible_knowledge(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get all knowledge bases accessible to the current user.

    Returns both personal and team knowledge bases organized by group.
    This endpoint is designed for AI chat integration.
    """
    return KnowledgeService.get_accessible_knowledge(
        db=db,
        user_id=current_user.id,
    )


@router.get("/personal/grouped", response_model=PersonalKnowledgeBaseGroup)
@trace_sync("get_personal_knowledge_bases_grouped", "knowledge.api")
def get_personal_knowledge_bases_grouped(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get personal knowledge bases grouped by ownership.

    Returns knowledge bases in two groups:
    - **created_by_me**: Knowledge bases created by the current user
    - **shared_with_me**: Knowledge bases shared with the current user by others
    """
    return KnowledgeService.get_personal_knowledge_bases_grouped(
        db=db,
        user_id=current_user.id,
    )


@router.get("/all-grouped", response_model=AllGroupedKnowledgeResponse)
@trace_sync("get_all_knowledge_bases_grouped", "knowledge.api")
def get_all_knowledge_bases_grouped(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get all knowledge bases accessible to the user, grouped by scope.

    This endpoint returns all knowledge bases in a single request, solving the N+1 query problem.
    The response is organized into:
    - **personal**: Knowledge bases created by the user and shared with the user
    - **groups**: Knowledge bases from team groups the user has access to
    - **organization**: Organization-level knowledge bases (visible to all)
    - **summary**: Counts for each category

    This is the recommended endpoint for the knowledge base navigation sidebar.
    """
    return KnowledgeService.get_all_knowledge_bases_grouped(
        db=db,
        user_id=current_user.id,
    )


@router.get("/config")
@trace_sync("get_knowledge_config", "knowledge.api")
def get_knowledge_config():
    """
    Get knowledge base configuration.

    Returns system-level configuration for knowledge base features.
    This is used by frontend to determine which features are enabled.
    """
    return {
        "chunk_storage_enabled": settings.CHUNK_STORAGE_ENABLED,
    }


@router.get("/organization-namespace")
@trace_sync("get_organization_namespace", "knowledge.api")
def get_organization_namespace(
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get the organization-level namespace name.

    Returns the namespace name that has level='organization'.
    This is used by frontend when creating organization knowledge bases.

    Returns:
        {"namespace": str} - The organization namespace name, or null if not configured
    """
    from app.models.namespace import Namespace
    from app.schemas.namespace import GroupLevel

    org_namespace = (
        db.query(Namespace)
        .filter(
            Namespace.level == GroupLevel.organization.value,
            Namespace.is_active == True,
        )
        .first()
    )

    return {
        "namespace": org_namespace.name if org_namespace else None,
    }


@router.get("/multimodal-default-prompts")
@trace_sync("get_multimodal_default_prompts", "knowledge.api")
def get_multimodal_default_prompts(
    current_user: User = Depends(security.get_current_user),
):
    """Return the system default multimodal analysis prompts.

    Used by the frontend to prefill the prompt editors in the KB create/edit,
    upload advanced settings, and "modify prompt & re-analyze" dialogs. The
    values are the single source of truth from ``shared.models.multimodal_prompts``
    (the same constants the converter falls back to at runtime).

    ``enabled`` mirrors the global ``KNOWLEDGE_MULTIMODAL_ENABLED`` switch so the
    frontend can hide the entire multimodal UI when the pipeline is disabled.
    """
    from shared.models.multimodal_prompts import (
        DEFAULT_IMAGE_PROMPT,
        DEFAULT_VIDEO_PROMPT,
    )

    return {
        "enabled": settings.KNOWLEDGE_MULTIMODAL_ENABLED,
        "video_prompt": DEFAULT_VIDEO_PROMPT,
        "image_prompt": DEFAULT_IMAGE_PROMPT,
    }


def _add_initial_kb_members(
    db: Session,
    kb_id: int,
    current_user: User,
    members: list[InitialMemberCreate],
) -> None:
    """Add initial members to a knowledge base after creation."""
    from app.services.share import knowledge_share_service

    members_data: list[tuple[int, BaseRole, str | None, str | None, str | None]] = []
    for member in members:
        target_user_id = 0
        entity_type = member.entity_type if member.entity_type else "user"
        entity_id = member.entity_id
        if entity_type == "user":
            try:
                target_user_id = int(entity_id)
            except (ValueError, TypeError):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid user ID: {entity_id}",
                )
            entity_id = None
        members_data.append(
            (
                target_user_id,
                member.role,
                entity_type,
                entity_id,
                member.entity_display_name,
            )
        )

    result = knowledge_share_service.batch_add_members(
        db=db,
        resource_id=kb_id,
        current_user_id=current_user.id,
        members_data=members_data,
    )

    if result.failed:
        details = ", ".join(
            f"{f.entity_id or f.user_id}: {f.error}" for f in result.failed
        )
        raise HTTPException(
            status_code=400,
            detail=f"Failed to add some members: {details}",
        )


@router.post(
    "",
    response_model=KnowledgeBaseResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync("create_knowledge_base", "knowledge.api")
def create_knowledge_base(
    data: KnowledgeBaseCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new knowledge base.

    - **namespace=default**: Personal knowledge base
    - **namespace=<group_name>**: Team knowledge base (requires Maintainer+ permission)
    - **members**: Optional initial members to add after creation
    """
    # A code wiki must be created through its own endpoint, which binds a repository
    # and checks the caller can read it. Refusing here rather than quietly ignoring
    # the field keeps this endpoint from becoming a way around that check.
    if data.kb_type == KnowledgeBaseType.CODE_WIKI:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Use POST /knowledge-bases/code-wikis to create a "
                "'code_wiki' knowledge base"
            ),
        )

    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        result = knowledge_orchestrator.create_knowledge_base(
            db=db,
            user=current_user,
            name=data.name,
            description=data.description,
            namespace=data.namespace or "default",
            direct_access_requirement=data.direct_access_requirement,
            kb_type=data.kb_type or "notebook",
            summary_enabled=data.summary_enabled,
            rag_config_mode=data.rag_config_mode,
            retrieval_config=_dump_retrieval_config_for_api(data.retrieval_config),
            summary_model_ref=data.summary_model_ref,
            **multimodal_create_kwargs(data),
        )

        # Add initial members if provided
        if data.members:
            _add_initial_kb_members(db, result.id, current_user, data.members)

        add_span_event(
            "knowledge.base.created",
            {
                "kb_id": str(result.id),
                "name": data.name,
                "namespace": data.namespace or "default",
                "user_id": str(current_user.id),
            },
        )
        return result
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Knowledge base with name '{data.name}' already exists in this namespace",
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.post("/code-wikis/resolve", response_model=CodeWikiResolveResponse)
@trace_sync("resolve_code_wiki_source", "knowledge.api")
def resolve_code_wiki_source(
    data: CodeWikiResolveRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Describe a repository before a wiki is bound to it.

    Registered above ``/{knowledge_base_id}`` routes by being declared here: a
    literal path segment must not be reachable only when it fails to parse as an id.

    Answers 200 with ``exists: false`` rather than 404 for a repository the caller
    cannot read. This is a form assisting input, not an assertion that something is
    missing, and the two cases are indistinguishable on purpose.
    """
    try:
        source = SourceRepository.from_url(data.source_type, data.source_url)
    except SourceAccessDenied as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e

    resolved = resolve_repository(db, current_user.id, source)
    return CodeWikiResolveResponse(
        exists=resolved.exists,
        visibility=resolved.visibility,
        default_branch=resolved.default_branch,
        name=resolved.name,
        description=resolved.description,
        access=resolved.access,
        # Listed even when the caller cannot read the repository: what is disclosed
        # is that a colleague documented it, to somebody who asked about it by name.
        existing_wikis=[
            CodeWikiExisting(**wiki.__dict__)
            for wiki in existing_wikis_for(
                db, source.source_url, viewer_id=current_user.id
            )
        ],
    )


@router.post("/code-wikis/diagnose")
@trace_sync("diagnose_code_wiki_source", "knowledge.api")
def diagnose_code_wiki_source(
    data: CodeWikiResolveRequest,
    current_user: User = Depends(security.get_admin_user),
    db: Session = Depends(get_db),
):
    """Run every provider call a code wiki makes, and time each one.

    For working out why reading a repository is slow or refused: the four causes —
    a wrong credential, an unreachable host, a proxy that is or is not bypassed for
    internal names, a provider that answers past the connect timeout — all surface
    to a normal request as "it took a while and then said no".

    Admin only, and it never returns a token: only whether one was found and whether
    it decrypted. It is a read of what the server can already do, so it changes
    nothing, but it does name internal hosts and repositories.
    """
    try:
        source = SourceRepository.from_url(data.source_type, data.source_url)
    except SourceAccessDenied as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e

    return diagnose(db, current_user.id, source)


@router.get("/code-wikis", response_model=CodeWikiListResponse)
@trace_sync("list_code_wikis", "knowledge.api")
def list_code_wikis(
    page: int = Query(1, ge=1, description="Page number"),
    limit: int = Query(20, ge=1, le=100, description="Items per page"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Code wikis the caller may read, judged by the ordinary knowledge-base ACL.

    A code wiki belongs to whoever created it, so this is the same visibility every
    other knowledge base has. The endpoint stays separate only because its list items
    carry repository fields; it grants nothing the general list would not.
    """
    visible = [
        kind
        for kind in KnowledgeService.list_knowledge_bases(
            db, current_user.id, scope=ResourceScope.ALL
        )
        if (kind.json or {}).get("spec", {}).get("kbType")
        == KnowledgeBaseType.CODE_WIKI.value
    ]

    window = visible[(page - 1) * limit : page * limit]
    # One grouped query for the whole page rather than a COUNT per wiki.
    counts = KnowledgeService.get_document_counts(db, [kind.id for kind in window])

    return CodeWikiListResponse(
        items=[_code_wiki_list_item(kind, counts.get(kind.id, 0)) for kind in window],
        total=len(visible),
    )


def _code_wiki_list_item(kind: Kind, document_count: int) -> CodeWikiListItem:
    spec = (kind.json or {}).get("spec", {})
    source = spec.get("source") or {}
    return CodeWikiListItem(
        id=kind.id,
        name=spec.get("name", kind.name),
        description=spec.get("description"),
        project_name=str(source.get("projectName", "") or ""),
        source_url=str(source.get("sourceUrl", "") or ""),
        last_published_at=spec.get(PUBLISHED_AT_KEY),
        last_published_commit=str(spec.get(PUBLISHED_COMMIT_KEY, "") or ""),
        document_count=document_count,
        created_at=kind.created_at,
        updated_at=kind.updated_at,
    )


@router.post(
    "/code-wikis",
    response_model=KnowledgeBaseResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync("create_code_wiki", "knowledge.api")
def create_code_wiki(
    data: CodeWikiCreate,
    response: Response,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Create a code wiki bound to a source repository, or return the existing one.

    The requester must be able to read the repository, so that a wiki cannot be built
    for one they have no access to. That is checked once, here. After it, the wiki is
    an ordinary knowledge base owned by whoever created it: who may read it is decided
    by knowledge-base ACLs like any other, and the repository is not consulted again.

    A repository may have several wikis, one per creator. Asking for one the caller
    already has returns it — they wanted that repository's wiki, not the act of
    creating it — and the response is 200 rather than 201 to say which happened.
    """
    # Enforced here rather than only in the client, which cannot stop a direct call.
    # Creation only: existing wikis stay readable and stay able to regenerate, so
    # turning the rollout down stops it spreading without breaking what it produced.
    if not wiki_settings.CODE_WIKI_ENABLED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Code wikis are not enabled on this deployment",
        )

    try:
        source = SourceRepository.from_url(data.source_type, data.source_url)
        assert_user_can_read_source(db, current_user.id, source)
    except SourceAccessDenied as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from e

    existing_id = existing_wiki_id(db, source, owner_id=current_user.id)
    if existing_id:
        response.status_code = status.HTTP_200_OK
        return KnowledgeBaseResponse.from_kind(
            KnowledgeService._get_knowledge_base_record(db, existing_id),
            KnowledgeService.get_document_count(db, existing_id),
        )

    # A blank name means "use the repository's". The client sends what it already
    # resolved for the form, so this does not probe the provider again -- it has
    # already been asked once by the gate above. Falling back to the URL keeps a
    # caller that skipped the probe, or called the API directly, from creating a
    # knowledge base with no name at all.
    name = data.name.strip() or source.project_name

    try:
        result = knowledge_orchestrator.create_knowledge_base(
            db=db,
            user=current_user,
            name=name[:100],
            description=data.description,
            namespace=data.namespace or CODE_WIKI_NAMESPACE,
            kb_type=KnowledgeBaseType.CODE_WIKI.value,
            source=source,
            language=data.language,
            show_generation_task=data.show_generation_task,
            # A code wiki is an ordinary knowledge base with a repository attached,
            # so every one of these applies to it. Listing only the ones it "needs"
            # is what silently dropped the summary settings and left the retrieval
            # config to be auto-resolved rather than taken from the form.
            direct_access_requirement=data.direct_access_requirement,
            summary_enabled=data.summary_enabled,
            summary_model_ref=data.summary_model_ref,
            retrieval_config=(
                data.retrieval_config.model_dump() if data.retrieval_config else None
            ),
            rag_config_mode=data.rag_config_mode,
            multimodal_analysis_enabled=data.multimodal_analysis_enabled,
            multimodal_analysis_model_ref=data.multimodal_analysis_model_ref,
            multimodal_analysis_video_prompt=data.multimodal_analysis_video_prompt,
            multimodal_analysis_image_prompt=data.multimodal_analysis_image_prompt,
        )
        claim_repository(db, source, result.id)
        db.commit()
        add_span_event(
            "knowledge.code_wiki.created",
            {
                "kb_id": str(result.id),
                "project_name": source.project_name,
                "owner_id": str(current_user.id),
            },
        )
        # Queued rather than awaited: starting a run reads the repository's HEAD,
        # which is a network call that can take the full connect timeout when the
        # host is slow. Blocking the response on it makes creating a wiki appear to
        # hang, and then to have failed, when the knowledge base is already saved.
        background_tasks.add_task(_start_the_first_run, current_user.id, result.id)
        return result
    except IntegrityError as e:
        # The same caller asking twice at once. UNIQUE (source_url, kind_id) settles
        # it at the database rather than in a check-then-insert window; the loser
        # returns the winner's wiki, since that is what it asked for.
        db.rollback()
        settled = existing_wiki_id(db, source, owner_id=current_user.id)
        if settled:
            response.status_code = status.HTTP_200_OK
            return KnowledgeBaseResponse.from_kind(
                KnowledgeService._get_knowledge_base_record(db, settled),
                KnowledgeService.get_document_count(db, settled),
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Knowledge base with name '{data.name}' already exists",
        ) from e
    except ValueError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e


@router.get("/{knowledge_base_id}/code-wiki/pages", response_model=CodeWikiPageTree)
@trace_sync("get_code_wiki_pages", "knowledge.api")
def get_code_wiki_pages(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """The navigation for a code wiki: every published page, nested and ordered.

    Access is the repository's, not the knowledge base's — a code wiki belongs to the
    wiki account, so its ACL grants nobody else anything.
    """
    knowledge_base = _readable_code_wiki(db, current_user, knowledge_base_id)
    return CodeWikiPageTree(
        pages=[_as_page_node(node) for node in page_tree(db, knowledge_base)]
    )


def _as_page_node(node) -> CodeWikiPageNode:
    return CodeWikiPageNode(
        path=node.path,
        title=node.title,
        document_id=node.document_id,
        has_content=node.has_content,
        children=[_as_page_node(child) for child in node.children],
    )


def _readable_code_wiki(db: Session, user: User, knowledge_base_id: int) -> Kind:
    """Load a code wiki the caller may read, or refuse.

    The ordinary knowledge-base ACL decides, the same as for any other knowledge
    base. Refusal is 404 rather than 403 so that the reply does not confirm the
    existence of a wiki the caller cannot see.
    """
    knowledge_base, has_access = KnowledgeService.get_knowledge_base(
        db=db, knowledge_base_id=knowledge_base_id, user_id=user.id
    )
    if knowledge_base is None or not has_access:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Code wiki not found"
        )
    return knowledge_base


def _start_the_first_run(user_id: int, knowledge_base_id: int) -> None:
    """Begin generating the wiki that was just created.

    Without this a new wiki is empty until somebody finds the regenerate button,
    which is not a flow anyone would guess.

    Runs after the response, on its own session: the request's session is closed by
    then, and reading the repository's HEAD can take the full connect timeout, which
    is not something the caller should wait through. Failures are logged rather than
    raised — the knowledge base is already saved, the reader shows an empty state,
    and its own button starts a run.
    """
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        knowledge_base = KnowledgeService._get_knowledge_base_record(
            db, knowledge_base_id
        )
        user = db.query(User).filter(User.id == user_id).first()
        if knowledge_base is None or user is None:  # pragma: no cover - just committed
            return
        start_run(db, knowledge_base=knowledge_base, user=user)
    except (CodeWikiRunError, GenerationInFlight) as e:
        logger.warning(
            "[code_wiki] first run not started for kb %s: %s", knowledge_base_id, e
        )
    except Exception:  # pragma: no cover - defensive
        db.rollback()
        logger.exception(
            "[code_wiki] first run not started for kb %s", knowledge_base_id
        )
    finally:
        db.close()


def _assert_caller_may_regenerate(
    db: Session, user: User, knowledge_base: Kind
) -> None:
    """Refuse a caller who may read the wiki but not change its repository.

    A knowledge base that is not a code wiki, or one with no repository recorded,
    is left to ``start_run`` to reject: it already says which of the two it is, and
    answering "you lack write access" for something with nothing to write to would
    be a worse account of the refusal.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    if spec.get("kbType") != KnowledgeBaseType.CODE_WIKI.value:
        return
    source = SourceRepository.from_spec(spec.get("source"))
    if source is None or not source.project_name:
        return
    try:
        assert_user_can_write_source(db, user.id, source)
    except SourceAccessDenied as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e)) from e


@router.get("/{knowledge_base_id}/code-wiki/status", response_model=CodeWikiRunStatus)
@trace_sync("get_code_wiki_status", "knowledge.api")
def get_code_wiki_status(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Whether anything is being done to this wiki, and what came of it last time.

    Reading is enough: this says whether the wiki is busy, which anyone who can read
    it needs in order to be told why regenerating is unavailable rather than being
    handed an opaque conflict.
    """
    knowledge_base = _readable_code_wiki(db, current_user, knowledge_base_id)
    state = current_run_state(db, knowledge_base)
    spec = (knowledge_base.json or {}).get("spec", {})
    return CodeWikiRunStatus(
        status=state.status,
        generation_id=state.generation_id,
        started_at=state.started_at,
        error_message=state.error_message,
        failure_code=state.failure_code,
        is_stale=state.is_stale,
        last_published_at=spec.get(PUBLISHED_AT_KEY),
        last_published_commit=str(spec.get(PUBLISHED_COMMIT_KEY, "") or ""),
    )


@router.get(
    "/{knowledge_base_id}/code-wiki/generations", response_model=CodeWikiRunHistory
)
@trace_sync("get_code_wiki_history", "knowledge.api")
def get_code_wiki_history(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """What has been attempted on this wiki, newest first.

    Reading is enough, as with the status this sits beside: a reader looking at a
    wiki with no pages, or one that has not moved in a week, is asking why — and
    refusing them the answer leaves them with a broken page and no explanation.

    Nothing here reveals more than the wiki already does. The commits are the ones
    its pages document, and the failure reasons come from a repository the reader can
    already see the contents of.
    """
    knowledge_base = _readable_code_wiki(db, current_user, knowledge_base_id)
    return CodeWikiRunHistory(
        runs=[
            CodeWikiRunRecord(
                generation_id=record.generation_id,
                status=record.status,
                mode=record.mode,
                started_at=record.started_at,
                completed_at=record.completed_at,
                commit=record.commit,
                error_message=record.error_message,
                failure_code=record.failure_code,
                published=record.published,
                task_id=record.task_id,
            )
            for record in run_history(db, knowledge_base)
        ]
    )


@router.post(
    "/{knowledge_base_id}/code-wiki/generations",
    response_model=CodeWikiRunResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@trace_sync("start_code_wiki_run", "knowledge.api")
def start_code_wiki_run(
    knowledge_base_id: int,
    data: CodeWikiRunCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Regenerate a code wiki now, without waiting for its schedule.

    **Write access to the repository is required**, not merely the ability to read
    the wiki. A run rewrites every page, so it is closer to changing the repository
    than to reading its documentation — and a wiki shared with a reader would
    otherwise let them spend a generation on somebody else's knowledge base.

    Answers 202 even when no run was needed. "The repository has not changed since the
    published version" is a successful outcome, not a failure, and the response says
    which it was.
    """
    knowledge_base = _readable_code_wiki(db, current_user, knowledge_base_id)
    _assert_caller_may_regenerate(db, current_user, knowledge_base)

    try:
        started = start_run(
            db,
            knowledge_base=knowledge_base,
            user=current_user,
            head_commit=data.head_commit,
            changed_paths=(
                None
                if data.changed_paths is None
                else [
                    ChangedPath(path=item.path, status=item.change_type)
                    for item in data.changed_paths
                ]
            ),
        )
    except GenerationInFlight as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e)) from e
    except CodeWikiRunError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e

    add_span_event(
        "knowledge.code_wiki.run_requested",
        {
            "kb_id": str(knowledge_base_id),
            "started": str(started.started),
            "mode": started.mode,
            "user_id": str(current_user.id),
        },
    )
    return CodeWikiRunResponse(
        started=started.started,
        mode=started.mode,
        reason=started.reason,
        generation_id=started.generation.id if started.generation else 0,
        task_id=started.task_id,
    )


@router.get("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
@trace_sync("get_knowledge_base", "knowledge.api")
def get_knowledge_base(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Get a knowledge base by ID."""
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        return knowledge_orchestrator.get_knowledge_base(
            db=db,
            user=current_user,
            knowledge_base_id=knowledge_base_id,
        )
    except ValueError as e:
        error_msg = str(e)
        if "access denied" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Access denied",
            )
        elif "not found" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found",
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_msg,
            )


@router.put("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
@trace_sync("update_knowledge_base", "knowledge.api")
def update_knowledge_base(
    knowledge_base_id: int,
    data: KnowledgeBaseUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update a knowledge base."""
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        result = knowledge_orchestrator.update_knowledge_base(
            db=db,
            user=current_user,
            knowledge_base_id=knowledge_base_id,
            name=data.name,
            description=data.description,
            direct_access_requirement=data.direct_access_requirement,
            retrieval_config=_dump_retrieval_config_for_api(data.retrieval_config),
            summary_enabled=data.summary_enabled,
            summary_model_ref=data.summary_model_ref,
            guided_questions=data.guided_questions,
            max_calls_per_conversation=data.max_calls_per_conversation,
            exempt_calls_before_check=data.exempt_calls_before_check,
            multimodal_update_fields=multimodal_update_kwargs(data),
        )
        add_span_event(
            "knowledge.base.updated",
            {
                "kb_id": str(knowledge_base_id),
                "user_id": str(current_user.id),
            },
        )
        return result
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


@router.delete("/{knowledge_base_id}", status_code=status.HTTP_204_NO_CONTENT)
@trace_sync("delete_knowledge_base", "knowledge.api")
def delete_knowledge_base(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a knowledge base and all its documents."""
    try:
        deleted = KnowledgeService.delete_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
        )

        if not deleted:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found or access denied",
            )

        add_span_event(
            "knowledge.base.deleted",
            {
                "kb_id": str(knowledge_base_id),
                "user_id": str(current_user.id),
            },
        )
        return None
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@router.patch("/{knowledge_base_id}/type", response_model=KnowledgeBaseResponse)
@trace_sync("update_knowledge_base_type", "knowledge.api")
def update_knowledge_base_type(
    knowledge_base_id: int,
    data: KnowledgeBaseTypeUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Update the default opening view for the knowledge base.

    - 'notebook': Open Notebook view by default when the URL does not specify a view
    - 'classic': Open document view by default when the URL does not specify a view
    """
    try:
        knowledge_base = KnowledgeService.update_knowledge_base_type(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            new_type=data.kb_type,
        )

        if not knowledge_base:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found or access denied",
            )

        return KnowledgeBaseResponse.from_kind(
            knowledge_base,
            KnowledgeService.get_document_count(db, knowledge_base.id),
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


# ============== Knowledge Document Endpoints ==============


@router.get(
    "/{knowledge_base_id}/documents",
    response_model=KnowledgeDocumentListResponse,
)
@trace_sync("list_documents", "knowledge.api")
def list_documents(
    knowledge_base_id: int,
    folder_id: Optional[int] = Query(
        default=None, ge=0, description="Filter documents by folder (None = all)"
    ),
    include_subfolders: bool = Query(
        default=False,
        description="Whether folder_id includes descendant folders",
    ),
    keyword: Optional[str] = Query(
        default=None,
        description="Search keyword for document names",
    ),
    sort_by: KnowledgeDocumentSortField = Query(
        default=KnowledgeDocumentSortField.CREATED_AT,
        description="Document sort field",
    ),
    sort_order: SortOrder = Query(
        default=SortOrder.DESC,
        description="Document sort order",
    ),
    limit: int = Query(
        default=DEFAULT_KNOWLEDGE_LIST_LIMIT,
        ge=1,
        le=MAX_KNOWLEDGE_LIST_LIMIT,
        description="Maximum number of documents to return",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="Start offset for paginated document listing",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """List documents in a knowledge base. Optionally filter by folder_id."""
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        return knowledge_orchestrator.list_documents(
            db=db,
            user=current_user,
            knowledge_base_id=knowledge_base_id,
            folder_id=folder_id,
            limit=limit,
            offset=offset,
            include_subfolders=include_subfolders,
            keyword=keyword,
            sort_by=sort_by.value,
            sort_order=sort_order.value,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(e),
        )


@router.post(
    "/{knowledge_base_id}/documents",
    response_model=KnowledgeDocumentResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_async("create_document", "knowledge.api")
async def create_document(
    knowledge_base_id: int,
    data: KnowledgeDocumentCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a new document in a knowledge base.

    The attachment_id should reference an already uploaded attachment
    via /api/attachments/upload endpoint.

    After creating the document, automatically triggers RAG indexing via Celery
    if the knowledge base has retrieval_config configured.
    """
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        result = knowledge_orchestrator.create_document_from_attachment(
            db=db,
            user=current_user,
            knowledge_base_id=knowledge_base_id,
            data=data,
            trigger_indexing=True,
            trigger_summary=True,
        )

        add_span_event(
            "knowledge.document.created",
            {
                "document_id": str(result.id),
                "knowledge_base_id": str(knowledge_base_id),
                "user_id": str(current_user.id),
            },
        )

        return result

    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        )


# Document-specific endpoints (without knowledge_base_id in path)
document_router = APIRouter()


@document_router.get("/{document_id}", response_model=KnowledgeDocumentResponse)
@trace_sync("get_document", "knowledge.api")
def get_document(
    document_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> KnowledgeDocumentResponse:
    """Get current document metadata and processing state by ID."""
    try:
        return knowledge_orchestrator.get_document(
            db=db,
            user=current_user,
            document_id=document_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc


@document_router.put("/{document_id}", response_model=KnowledgeDocumentResponse)
@trace_sync("update_document", "knowledge.api")
def update_document(
    document_id: int,
    data: KnowledgeDocumentUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Update a document (enable/disable status)."""
    try:
        document = KnowledgeService.update_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
            data=data,
        )

        if not document:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        return KnowledgeDocumentResponse.model_validate(document)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@document_router.post("/{document_id}/reindex")
@trace_async("reindex_document", "knowledge.api")
async def reindex_document(
    document_id: int,
    payload: Optional[DocumentReindexRequest] = None,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """
    Trigger re-indexing for a document via Celery.

    Re-indexes the document using the knowledge base's configured retriever
    and embedding model. Only works for documents in knowledge bases with
    RAG configured.

    An optional body may carry ``multimodal_analysis_prompt``: when present it
    is written into the document's ``source_config`` (overriding the KB default)
    before re-dispatch, enabling the "modify prompt & re-analyze" flow to reuse
    this endpoint. A blank value clears the document override (revert to the
    KB default). Absent body / field = leave the stored prompt unchanged.

    Returns:
        Success message indicating reindex has started
    """
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic).
        # The optional multimodal prompt override is forwarded to the orchestrator, which persists
        # it into the document's source_config AFTER the access check — so an unauthorized caller
        # cannot poison the stored prompt. None = leave unchanged; "" = clear (revert to KB default).
        result = knowledge_orchestrator.reindex_document(
            db=db,
            user=current_user,
            document_id=document_id,
            trigger_summary=False,  # Don't re-generate summary on reindex
            multimodal_prompt_override=(
                payload.multimodal_analysis_prompt if payload else None
            ),
        )
        add_span_event(
            "knowledge.document.reindex.scheduled",
            {
                "document_id": str(document_id),
                "user_id": str(current_user.id),
            },
        )
        return result
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=error_msg,
            )
        elif "access denied" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=error_msg,
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=error_msg,
            )


@document_router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
@trace_sync("delete_document", "knowledge.api")
def delete_document(
    document_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Delete a document from the knowledge base."""
    try:
        result = KnowledgeService.delete_document(
            db=db,
            document_id=document_id,
            user_id=current_user.id,
        )

        if not result.success:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Document not found or access denied",
            )

        add_span_event(
            "knowledge.document.deleted",
            {
                "document_id": str(document_id),
                "kb_id": str(result.kb_id) if result.kb_id else "unknown",
                "user_id": str(current_user.id),
            },
        )

        # Trigger KB summary update in background after successful deletion
        if result.kb_id is not None:
            logger.info(
                f"[KnowledgeAPI] Scheduling KB summary update after deletion: "
                f"kb_id={result.kb_id}, document_id={document_id}"
            )
            schedule_kb_summary_updates_after_deletion(
                background_tasks,
                kb_ids=[result.kb_id],
                user_id=current_user.id,
                user_name=current_user.user_name,
            )

        return None
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(e),
        )


@document_router.put("/{document_id}/content")
@trace_async("update_document_content", "knowledge.api")
async def update_document_content(
    document_id: int,
    data: DocumentContentUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """
    Update document content for text documents and editable plain-text files.

    Overwrites the underlying attachment content and triggers RAG re-indexing
    via Celery. Only Owner or Maintainer of the knowledge base can update
    documents.

    Returns:
        Success message with document_id
    """
    try:
        # Use Orchestrator for unified business logic (REST API and MCP tools share the same logic)
        result = knowledge_orchestrator.update_document_content(
            db=db,
            user=current_user,
            document_id=document_id,
            content=data.content,
            trigger_reindex=True,
        )

        add_span_event(
            "knowledge.document.content_updated",
            {
                "document_id": str(document_id),
                "user_id": str(current_user.id),
            },
        )

        return result

    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower() or "access denied" in error_msg.lower():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=error_msg,
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error_msg,
        )


# ============== Batch Document Operations ==============


@document_router.get("/{document_id}/detail")
@trace_async("get_document_detail_standalone", "knowledge.api")
async def get_document_detail_standalone(
    document_id: int,
    include_content: bool = Query(True, description="Include document content"),
    include_summary: bool = Query(True, description="Include document summary"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document detail (content and/or summary) without requiring knowledge base ID.

    This is a convenience endpoint for getting document content when the kb_id
    is not readily available (e.g., in citation tooltips).
    """
    try:
        detail = await knowledge_orchestrator.get_document_detail(
            db=db,
            user=current_user,
            document_id=document_id,
            include_content=include_content,
            include_summary=include_summary,
            offset=0,
            limit=MAX_DOCUMENT_READ_LIMIT,
        )
        return _serialize_standalone_document_detail(
            detail,
            include_content=include_content,
            include_summary=include_summary,
        )
    except ValueError as error:
        _raise_document_detail_http_error(error)


@document_router.post("/batch/delete", response_model=BatchOperationResult)
@trace_sync("batch_delete_documents", "knowledge.api")
def batch_delete_documents(
    data: BatchDocumentIds,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch delete multiple documents.

    Deletes all specified documents that the user has permission to delete.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    batch_result = KnowledgeService.batch_delete_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )

    result = batch_result.result
    kb_ids = batch_result.kb_ids

    add_span_event(
        "knowledge.documents.batch_deleted",
        {
            "success_count": str(result.success_count),
            "failed_count": str(result.failed_count),
            "kb_ids": str(list(kb_ids)) if kb_ids else "[]",
            "user_id": str(current_user.id),
        },
    )

    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can delete documents from this knowledge base",
        )

    # Trigger KB summary update ONCE for each affected KB after all deletions complete
    if kb_ids:
        logger.info(
            f"[KnowledgeAPI] Scheduling KB summary updates after batch deletion: "
            f"kb_ids={kb_ids}, deleted_count={result.success_count}"
        )
        schedule_kb_summary_updates_after_deletion(
            background_tasks,
            kb_ids=kb_ids,
            user_id=current_user.id,
            user_name=current_user.user_name,
        )

    return result


# ============== Knowledge Folder Endpoints ==============


@router.post(
    "/{knowledge_base_id}/folders",
    response_model=KnowledgeFolderResponse,
    status_code=status.HTTP_201_CREATED,
)
@trace_sync("create_folder", "knowledge.api")
def create_folder(
    knowledge_base_id: int,
    data: KnowledgeFolderCreate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> KnowledgeFolderResponse:
    """Create a new folder in a knowledge base."""
    try:
        return KnowledgeFolderService.create_folder(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
            data=data,
        )
    except ValueError as e:
        _raise_document_detail_http_error(e)


@router.get(
    "/{knowledge_base_id}/folders",
    response_model=list[KnowledgeFolderResponse],
)
@trace_sync("get_folder_tree", "knowledge.api")
def get_folder_tree(
    knowledge_base_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> List[KnowledgeFolderResponse]:
    """Get the full folder tree for a knowledge base."""
    try:
        return KnowledgeFolderService.get_folder_tree(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=current_user.id,
        )
    except ValueError as e:
        _raise_document_detail_http_error(e)


@router.put(
    "/{knowledge_base_id}/folders/{folder_id}",
    response_model=KnowledgeFolderResponse,
)
def update_folder(
    knowledge_base_id: int,
    folder_id: int,
    data: KnowledgeFolderUpdate,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> KnowledgeFolderResponse:
    """Update a folder (rename and/or move)."""
    try:
        return KnowledgeFolderService.update_folder(
            db=db,
            folder_id=folder_id,
            user_id=current_user.id,
            data=data,
            knowledge_base_id=knowledge_base_id,
        )
    except ValueError as e:
        _raise_document_detail_http_error(e)


@router.delete(
    "/{knowledge_base_id}/folders/{folder_id}",
)
@trace_sync("delete_folder", "knowledge.api")
def delete_folder(
    knowledge_base_id: int,
    folder_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> Dict:
    """Delete a folder and move its documents to root level."""
    try:
        result = KnowledgeFolderService.delete_folder(
            db=db,
            folder_id=folder_id,
            user_id=current_user.id,
            knowledge_base_id=knowledge_base_id,
        )
        return result
    except ValueError as e:
        _raise_document_detail_http_error(e)


# ============== Document Move Endpoint ==============


@document_router.put(
    "/{document_id}/move",
    response_model=KnowledgeDocumentResponse,
)
@trace_sync("move_document", "knowledge.api")
def move_document(
    document_id: int,
    data: DocumentMoveRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
) -> KnowledgeDocumentResponse:
    """Move a document to a different folder (0 = root level)."""
    try:
        doc = KnowledgeFolderService.move_document(
            db=db,
            document_id=document_id,
            folder_id=data.folder_id,
            user_id=current_user.id,
        )
        return KnowledgeDocumentResponse.model_validate(doc)
    except ValueError as e:
        _raise_document_detail_http_error(e)


@document_router.post("/batch/enable", response_model=BatchOperationResult)
@trace_sync("batch_enable_documents", "knowledge.api")
def batch_enable_documents(
    data: BatchDocumentIds,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch enable multiple documents.

    Enables all specified documents that the user has permission to update.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    result = KnowledgeService.batch_enable_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )
    add_span_event(
        "knowledge.documents.batch_enabled",
        {
            "success_count": str(result.success_count),
            "failed_count": str(result.failed_count),
            "user_id": str(current_user.id),
        },
    )
    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can update documents in this knowledge base",
        )
    return result


@document_router.post("/batch/disable", response_model=BatchOperationResult)
@trace_sync("batch_disable_documents", "knowledge.api")
def batch_disable_documents(
    data: BatchDocumentIds,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Batch disable multiple documents.

    Disables all specified documents that the user has permission to update.
    Returns a summary of successful and failed operations.
    Raises 403 if all operations fail due to permission issues.
    """
    result = KnowledgeService.batch_disable_documents(
        db=db,
        document_ids=data.document_ids,
        user_id=current_user.id,
    )
    add_span_event(
        "knowledge.documents.batch_disabled",
        {
            "success_count": str(result.success_count),
            "failed_count": str(result.failed_count),
            "user_id": str(current_user.id),
        },
    )
    # If all operations failed, raise an error
    if result.success_count == 0 and result.failed_count > 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only Owner or Maintainer can update documents in this knowledge base",
        )
    return result


# ============== QA History Endpoints ==============


qa_history_router = APIRouter()


@qa_history_router.get("", response_model=QAHistoryResponse)
@trace_sync("get_qa_history", "knowledge.api")
def get_qa_history(
    start_time: datetime = Query(
        ...,
        description="Query start time (ISO 8601 format)",
    ),
    end_time: datetime = Query(
        ...,
        description="Query end time (ISO 8601 format)",
    ),
    user_id: Optional[int] = Query(
        default=None,
        description="Filter by user ID (admin only, ignored for non-admin users)",
    ),
    page: int = Query(
        default=1,
        ge=1,
        description="Page number (default: 1)",
    ),
    page_size: int = Query(
        default=20,
        ge=1,
        le=100,
        description="Number of items per page (default: 20, max: 100)",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Query knowledge base QA history based on time range.

    Returns user questions, assistant answers, vector search results,
    and knowledge base configuration information.

    - **start_time**: Query start time (ISO 8601 format, required)
    - **end_time**: Query end time (ISO 8601 format, required)
    - **user_id**: Filter by user ID (admin only; non-admin users can only query their own history)
    - **page**: Page number (default: 1)
    - **page_size**: Items per page (default: 20, max: 100)

    Note: Maximum query time range is 30 days.

    Authorization:
    - Admin users can query any user's history by specifying user_id,
      or query all users' history when user_id is None.
    - Non-admin users can only query their own history (user_id parameter is ignored).
    """
    # Enforce authorization: non-admin users can only query their own history
    if current_user.role != "admin":
        effective_user_id = current_user.id
    else:
        # Admin can query specific user or all users (when user_id is None)
        effective_user_id = user_id

    try:
        return knowledge_base_qa_service.get_qa_history(
            db=db,
            start_time=start_time,
            end_time=end_time,
            user_id=effective_user_id,
            page=page,
            page_size=page_size,
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e),
        ) from e


# ============== Summary Endpoints ==============

summary_router = APIRouter()


@summary_router.get("/{kb_id}/summary")
@trace_async("get_kb_summary", "knowledge.api")
async def get_kb_summary(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get knowledge base summary.

    Returns the summary information for a knowledge base including:
    - short_summary: Brief overview (50-100 characters)
    - long_summary: Detailed description (up to 500 characters)
    - topics: List of core topic tags
    - status: Summary generation status
    """
    from app.schemas.summary import KnowledgeBaseSummaryResponse
    from app.services.knowledge import get_summary_service

    # Validate KB access permission
    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.get_kb_summary(kb_id)
    return KnowledgeBaseSummaryResponse(kb_id=kb_id, summary=summary)


@summary_router.put("/{kb_id}/summary")
@trace_async("update_kb_summary", "knowledge.api")
async def update_kb_summary(
    kb_id: int,
    data: KnowledgeBaseSummaryUpdateRequest,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Manually update knowledge base summary."""
    from app.schemas.summary import KnowledgeBaseSummaryResponse
    from app.services.knowledge import get_summary_service

    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )
    if not KnowledgeService.can_manage_knowledge_base(db, kb_id, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to update knowledge base summary",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.update_kb_manual_summary(
        kb_id=kb_id,
        user_id=current_user.id,
        user_name=current_user.user_name,
        content=data.long_summary,
    )
    return KnowledgeBaseSummaryResponse(kb_id=kb_id, summary=summary)


@summary_router.post("/{kb_id}/summary/reset")
@trace_async("reset_kb_summary", "knowledge.api")
async def reset_kb_summary(
    kb_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Reset manual knowledge base summary and fall back to AI summary."""
    from app.schemas.summary import KnowledgeBaseSummaryResponse
    from app.services.knowledge import get_summary_service

    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )
    if not KnowledgeService.can_manage_knowledge_base(db, kb_id, current_user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to reset knowledge base summary",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.reset_kb_manual_summary(kb_id)
    return KnowledgeBaseSummaryResponse(kb_id=kb_id, summary=summary)


@summary_router.post("/{kb_id}/summary/refresh")
@trace_async("refresh_kb_summary", "knowledge.api")
async def refresh_kb_summary(
    kb_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Manually refresh knowledge base summary.

    Triggers regeneration of the knowledge base summary based on
    aggregated document summaries. Runs in background.
    """
    from app.schemas.summary import SummaryRefreshResponse

    # Validate KB access permission
    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )

    kb_spec = (kb.json or {}).get("spec", {})
    if not kb_spec.get("summaryEnabled"):
        return SummaryRefreshResponse(
            message="Summary generation is disabled",
            status="skipped",
        )

    # Run in background, return immediately
    background_tasks.add_task(
        _run_kb_summary_refresh, kb_id, current_user.id, current_user.user_name
    )

    return SummaryRefreshResponse(
        message="Summary refresh started",
        status="generating",
    )


@summary_router.get(
    "/{kb_id}/documents/{doc_id}/detail", response_model=DocumentDetailResponse
)
@trace_async("get_document_detail", "knowledge.api")
async def get_document_detail(
    kb_id: int,
    doc_id: int,
    include_content: bool = Query(
        default=True, description="Include document content in response"
    ),
    include_summary: bool = Query(
        default=True, description="Include document summary in response"
    ),
    offset: int = Query(
        default=0, ge=0, description="Content read offset (for pagination)"
    ),
    limit: int = Query(
        default=MAX_DOCUMENT_READ_LIMIT,
        ge=1,
        le=MAX_DOCUMENT_READ_LIMIT,
        description=f"Content read limit (max: {MAX_DOCUMENT_READ_LIMIT})",
    ),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document detail including content and summary.

    Query parameters:
    - include_content: Whether to include extracted text content (default: true)
    - include_summary: Whether to include AI-generated summary (default: true)
    - offset: Content read offset for pagination (default: 0)
    - limit: Maximum characters to return (default: 100000, max: 100000)

    Returns:
    - document_id: Document ID
    - content: Extracted text content (if include_content=true)
    - content_length: Total length of content in characters (if include_content=true)
    - truncated: Whether more content is available (if include_content=true)
    - summary: Document summary object (if include_summary=true)
    """
    from app.models.knowledge import KnowledgeDocument

    _validate_knowledge_base_access_or_raise(
        db,
        knowledge_base_id=kb_id,
        user=current_user,
    )

    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    try:
        return await knowledge_orchestrator.get_document_detail(
            db=db,
            user=current_user,
            document_id=doc_id,
            include_content=include_content,
            include_summary=include_summary,
            offset=offset,
            limit=limit,
        )
    except ValueError as error:
        _raise_document_detail_http_error(error)


@summary_router.get("/{kb_id}/documents/{doc_id}/summary")
@trace_async("get_document_summary", "knowledge.api")
async def get_document_summary(
    kb_id: int,
    doc_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get document summary.

    Returns the summary information for a document including:
    - short_summary: Brief overview (50-100 characters)
    - long_summary: Detailed description (up to 500 characters)
    - topics: List of topic tags
    - meta_info: Extracted metadata
    - status: Summary generation status
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.summary import DocumentSummaryResponse
    from app.services.knowledge import get_summary_service

    # Validate KB access permission first
    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )

    # Validate document belongs to the specified knowledge base
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    summary_service = get_summary_service(db)
    summary = await summary_service.get_document_summary(doc_id)
    return DocumentSummaryResponse(document_id=doc_id, summary=summary)


@summary_router.post("/{kb_id}/documents/{doc_id}/summary/refresh")
@trace_async("refresh_document_summary", "knowledge.api")
async def refresh_document_summary(
    kb_id: int,
    doc_id: int,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Manually refresh document summary.

    Triggers regeneration of the document summary. Runs in background.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.summary import SummaryRefreshResponse

    # Validate KB access permission first
    kb, has_access = KnowledgeService.get_knowledge_base(db, kb_id, current_user.id)
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this knowledge base",
        )

    # Validate document belongs to the specified knowledge base
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == doc_id,
            KnowledgeDocument.kind_id == kb_id,
        )
        .first()
    )
    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found in the specified knowledge base",
        )

    # Run in background, return immediately
    background_tasks.add_task(
        _run_document_summary_refresh, doc_id, current_user.id, current_user.user_name
    )

    return SummaryRefreshResponse(
        message="Summary refresh started",
        status="generating",
    )


# ============== Background Tasks ==============


@trace_async("kb_summary_refresh_background", "knowledge.worker")
async def _run_kb_summary_refresh(kb_id: int, user_id: int, user_name: str):
    """Background task wrapper for KB summary refresh."""
    from app.services.knowledge import get_summary_service

    add_span_event(
        "kb.summary.refresh.started",
        {
            "kb_id": str(kb_id),
            "user_id": str(user_id),
        },
    )

    # Create new session for background task
    new_db = SessionLocal()
    try:
        summary_service = get_summary_service(new_db)
        await summary_service.refresh_kb_summary(kb_id, user_id, user_name)
        add_span_event(
            "kb.summary.refresh.completed",
            {
                "kb_id": str(kb_id),
            },
        )
    except Exception as e:
        logger.exception(f"Failed to refresh KB summary for kb_id={kb_id}")
        add_span_event(
            "kb.summary.refresh.failed",
            {
                "kb_id": str(kb_id),
                "error": str(e),
            },
        )
    finally:
        new_db.close()


@trace_async("document_summary_refresh_background", "knowledge.worker")
async def _run_document_summary_refresh(doc_id: int, user_id: int, user_name: str):
    """Background task wrapper for document summary refresh."""
    from app.services.knowledge import get_summary_service

    add_span_event(
        "document.summary.refresh.started",
        {
            "doc_id": str(doc_id),
            "user_id": str(user_id),
        },
    )

    # Create new session for background task
    new_db = SessionLocal()
    try:
        summary_service = get_summary_service(new_db)
        await summary_service.refresh_document_summary(doc_id, user_id, user_name)
        add_span_event(
            "document.summary.refresh.completed",
            {
                "doc_id": str(doc_id),
            },
        )
    except Exception as e:
        logger.exception(f"Failed to refresh document summary for doc_id={doc_id}")
        add_span_event(
            "document.summary.refresh.failed",
            {
                "doc_id": str(doc_id),
                "error": str(e),
            },
        )
    finally:
        new_db.close()


# ============== Chunk Management Endpoints ==============


@document_router.get("/{document_id}/chunks")
@trace_sync("list_document_chunks", "knowledge.api")
def list_document_chunks(
    document_id: int,
    page: int = Query(1, ge=1, description="Page number"),
    page_size: int = Query(20, ge=1, le=100, description="Page size"),
    search: Optional[str] = Query(None, description="Search keyword"),
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    List chunks for a document with pagination and optional search.

    Returns paginated chunk list with content and metadata.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.knowledge import ChunkItem, ChunkListResponse

    # Get document with access check
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    # Check access permission via knowledge base
    kb, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=current_user.id,
    )
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this document",
        )

    # Get chunks from document
    chunks_data = document.chunks or {}
    all_items = chunks_data.get("items", [])

    # Apply search filter if provided
    if search:
        search_lower = search.lower()
        all_items = [
            item
            for item in all_items
            if search_lower in item.get("content", "").lower()
        ]

    # Pagination
    total = len(all_items)
    start = (page - 1) * page_size
    end = start + page_size
    paginated_items = all_items[start:end]

    return ChunkListResponse(
        total=total,
        page=page,
        page_size=page_size,
        items=[ChunkItem(**item) for item in paginated_items],
        splitter_type=chunks_data.get("splitter_type"),
        splitter_subtype=chunks_data.get("splitter_subtype"),
        qa_pair_count=chunks_data.get("qa_pair_count", 0),
    )


@document_router.get("/{document_id}/chunks/{chunk_index}")
@trace_sync("get_document_chunk", "knowledge.api")
def get_document_chunk(
    document_id: int,
    chunk_index: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """
    Get a single chunk by index.

    Returns full chunk content for citation hover display.
    """
    from app.models.knowledge import KnowledgeDocument
    from app.schemas.knowledge import ChunkResponse

    # Get document
    document = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document_id).first()
    )

    if not document:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Document not found",
        )

    # Check access permission via knowledge base
    kb, has_access = KnowledgeService.get_knowledge_base(
        db=db,
        knowledge_base_id=document.kind_id,
        user_id=current_user.id,
    )
    if not kb:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Knowledge base not found",
        )
    if not has_access:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to this document",
        )

    # Get chunk by index
    chunks_data = document.chunks or {}
    items = chunks_data.get("items", [])

    # Find chunk by index
    chunk = None
    for item in items:
        if item.get("index") == chunk_index:
            chunk = item
            break

    if not chunk:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Chunk with index {chunk_index} not found",
        )

    return ChunkResponse(
        index=chunk.get("index", chunk_index),
        content=chunk.get("content", ""),
        token_count=chunk.get("token_count", 0),
        document_name=document.name,
        document_id=document.id,
        kb_id=document.kind_id,
    )
