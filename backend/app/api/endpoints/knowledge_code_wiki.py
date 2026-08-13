# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API endpoints for code wikis.

A code wiki is a knowledge base whose documents are written by an agent reading a
repository, so these routes are about repositories and runs rather than about
documents: resolving a repository, claiming it, starting a run, and reading what the
last one produced. Documents themselves are served by the ordinary knowledge routes,
which is the point of storing a wiki as a knowledge base at all.

Registered on the knowledge router rather than mounted on its own prefix, because
these paths live under it. Route order matters and is why the registration sits
directly under the router it extends: ``/code-wikis`` has to be matched before
``/{knowledge_base_id}``, which would otherwise swallow it and try to read
"code-wikis" as an id.
"""

import logging

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
from app.core import security
from app.core.wiki_config import wiki_settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.knowledge import (
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
    KnowledgeBaseResponse,
    KnowledgeBaseType,
    ResourceScope,
)
from app.services.knowledge import KnowledgeService
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
    existing_wiki_id,
    existing_wikis_for,
)
from app.services.knowledge.code_wiki.resolution import resolve_repository
from app.services.knowledge.code_wiki.run_mode import ChangedPath
from app.services.knowledge.code_wiki.runner import (
    CodeWikiRunError,
    republish_generation,
    start_first_run,
    start_run,
)
from app.services.knowledge.code_wiki.source import (
    SourceAccessDenied,
    SourceRepository,
    assert_user_can_read_source,
)
from app.services.knowledge.orchestrator import knowledge_orchestrator
from shared.telemetry.decorators import add_span_event, trace_sync

logger = logging.getLogger(__name__)

router = APIRouter()


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
        # Registering the repository is part of this call, in its transaction: a code
        # wiki without a registry row is one no run can start and no list can show.
        result = knowledge_orchestrator.create_code_wiki(
            db=db,
            user=current_user,
            name=name[:100],
            source=source,
            description=data.description,
            namespace=data.namespace or CODE_WIKI_NAMESPACE,
            language=data.language,
            show_generation_task=data.show_generation_task,
            # A code wiki is an ordinary knowledge base with a repository attached,
            # so every one of these applies to it. Listing only the ones it "needs"
            # is what silently dropped the summary settings and left the retrieval
            # config to be auto-resolved rather than taken from the form.
            direct_access_requirement=data.direct_access_requirement,
            summary_enabled=data.summary_enabled,
            summary_model_ref=data.summary_model_ref,
            execution_model_ref=data.execution_model_ref,
            retrieval_config=(
                data.retrieval_config.model_dump() if data.retrieval_config else None
            ),
            rag_config_mode=data.rag_config_mode,
            multimodal_analysis_enabled=data.multimodal_analysis_enabled,
            multimodal_analysis_model_ref=data.multimodal_analysis_model_ref,
            multimodal_analysis_video_prompt=data.multimodal_analysis_video_prompt,
            multimodal_analysis_image_prompt=data.multimodal_analysis_image_prompt,
        )
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
        background_tasks.add_task(start_first_run, current_user.id, result.id)
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

        # Reaching here means the constraint that failed was not the one this
        # handler is about, so the database's own account of it is the only thing
        # that can say what went wrong. It used to be discarded in favour of
        # "already exists" -- a cause nobody had checked, and one that sent two
        # separate investigations looking for a duplicate name that did not exist.
        logger.exception(
            "[code_wiki] create failed for %s (owner %s): unexpected constraint",
            source.source_url,
            current_user.id,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not create the code wiki; see the server log",
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


def _assert_caller_may_regenerate(
    db: Session, user: User, knowledge_base: Kind
) -> None:
    """Refuse a caller who may read the wiki but cannot manage it.

    A knowledge base that is not a code wiki is left to ``start_run`` to reject, so
    this permission message does not mask the more useful resource error.
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    if spec.get("kbType") != KnowledgeBaseType.CODE_WIKI.value:
        return
    if not KnowledgeService.can_manage_knowledge_base(db, knowledge_base.id, user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Knowledge Base manage permission is required to regenerate",
        )


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
                task_status=record.task_status,
            )
            for record in run_history(db, knowledge_base)
        ]
    )


@router.post(
    "/{knowledge_base_id}/code-wiki/generations/{generation_id}/publish",
    response_model=CodeWikiRunResponse,
)
@trace_sync("republish_code_wiki_version", "knowledge.api")
def republish_code_wiki_version(
    knowledge_base_id: int,
    generation_id: int,
    current_user: User = Depends(security.get_current_user),
    db: Session = Depends(get_db),
):
    """Make an earlier version the one readers see again.

    Requires Knowledge Base manage permission, the same as regenerating. This changes
    what everybody reads, so read access alone is insufficient.

    It restores content and structure, not identity. The pages that were deleted on
    the way here took their document ids with them, so anything that cited one is not
    repaired by coming back.
    """
    knowledge_base = _readable_code_wiki(db, current_user, knowledge_base_id)
    _assert_caller_may_regenerate(db, current_user, knowledge_base)

    try:
        result = republish_generation(
            db,
            knowledge_base=knowledge_base,
            generation_id=generation_id,
        )
    except CodeWikiRunError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e

    if not result.published:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=result.reason or "the publish gate refused this version",
        )

    db.commit()
    return CodeWikiRunResponse(
        started=False,
        mode="republish",
        reason=f"version {generation_id} is published again",
        generation_id=generation_id,
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

    Requires Knowledge Base manage permission, not merely the ability to read the
    wiki. A run rewrites every page, and must follow the same ACL as other mutations
    of that knowledge resource.

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
