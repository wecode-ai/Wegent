# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Writing what a generating agent submits into a wiki version.

All that is left of the wiki service, and all a version needs: pages arrive one call
at a time, are matched to what the version already holds, and the run is concluded on
the call that reports a status. Everything about *starting* a run -- teams, tokens,
repository access, prompts -- went with the legacy wiki, which had its own agent and
its own configuration; a code wiki starts its runs through
``services/knowledge/code_wiki``.
"""

import logging
from datetime import datetime
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy.orm import Session, defer
from sqlalchemy.sql import func

from app.core.wiki_config import wiki_settings
from app.models.wiki import WikiContent, WikiGeneration, WikiGenerationStatus
from app.schemas.wiki import (
    WikiContentSummary,
    WikiContentWriteRequest,
    WikiPageRead,
)
from app.services.knowledge.code_wiki.page_path import (
    InvalidPagePath,
    assert_unique_within_version,
    collation_key,
    normalize_page_path,
)
from app.services.knowledge.code_wiki.publisher import PublishResult
from app.services.knowledge.code_wiki.runner import finish_run, is_code_wiki_generation
from app.services.knowledge.code_wiki.version_store import (
    page_path_of,
    remove_page,
    set_page_path,
)

logger = logging.getLogger(__name__)


class WikiService:
    """Writes and concludes wiki versions."""

    def save_generation_contents(
        self,
        wiki_db: Session,
        payload: WikiContentWriteRequest,
    ) -> Optional[PublishResult]:
        """
        Persist wiki generation contents with incremental write support.

        This method is intended for internal agent usage and therefore performs:
        - Strict validation on payload schema and size
        - Incremental upsert behaviour (update existing sections, insert new ones)
        - Summary-aware status transitions and metadata bookkeeping with support for retries
        - Resilient writes regardless of current generation status so reruns can overwrite results

        Returns:
            What the publish attempt did, when a code wiki run concluded. ``None``
            otherwise, including for every ordinary page write.
        """
        has_sections = bool(payload.sections)
        if not has_sections and not payload.summary and not payload.removed_paths:
            raise HTTPException(
                status_code=400,
                detail="No sections, removals or summary provided",
            )

        total_payload_size = (
            sum(len(section.content.encode("utf-8")) for section in payload.sections)
            if has_sections
            else 0
        )
        if total_payload_size > wiki_settings.MAX_CONTENT_SIZE:
            raise HTTPException(
                status_code=400,
                detail="Content payload exceeds maximum allowed size",
            )

        generation = (
            wiki_db.query(WikiGeneration)
            .filter(WikiGeneration.id == payload.generation_id)
            .with_for_update()
            .first()
        )
        if not generation:
            raise HTTPException(status_code=404, detail="Generation not found")

        now = datetime.utcnow()
        created_sections = 0
        updated_sections = 0
        titles: List[str] = []
        existing_contents: List[WikiContent] = []

        if has_sections:
            # Pages are identified by path when one is given. Normalising up front
            # means a malformed path fails this write rather than the publish of the
            # whole version, and keeps two spellings of one path from becoming two
            # pages that the projection could not both honour.
            normalized_paths: Dict[int, str] = {}
            try:
                for index, section in enumerate(payload.sections):
                    if section.path:
                        normalized_paths[index] = normalize_page_path(section.path)
                assert_unique_within_version(normalized_paths.values())
            except InvalidPagePath as exc:
                # The generation row is held with_for_update; release it before
                # raising, as the other failure branches in this method do.
                wiki_db.rollback()
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            titles = [section.title for section in payload.sections]
            # Every row in the generation is loaded, not just the titles being
            # written: a page whose title changed has to be found by its path.
            #
            # Without its body, though. The agent submits one page at a time, so the
            # Nth submission was reading back the full text of the N-1 pages already
            # written — quadratic in bytes over a run, and the pages are the largest
            # thing in the table. Nothing below reads `content`; it is only assigned,
            # and assigning a deferred column does not fetch the old value first.
            existing_contents = (
                wiki_db.query(WikiContent)
                .filter(WikiContent.generation_id == generation.id)
                .options(defer(WikiContent.content))
                .with_for_update()
                .all()
            )

            existing_by_path: Dict[str, WikiContent] = {}
            path_less: List[WikiContent] = []
            for content in existing_contents:
                content_path = page_path_of(content)
                if content_path:
                    existing_by_path[collation_key(content_path)] = content
                else:
                    path_less.append(content)

            # The title-based indices deliberately exclude anything that already has a
            # page path. Moving a page keeps its title, so a title can name several
            # path-identified pages; a legacy write resolving through it would pick one
            # of them by query order rather than by any rule, and overwrite it.
            existing_by_key: Dict[Tuple[str, str], WikiContent] = {
                (content.type, content.title): content for content in path_less
            }
            existing_by_title: Dict[str, WikiContent] = {
                content.title: content
                for content in path_less
                if content.title in titles
            }

            for index, section in enumerate(payload.sections):
                path = normalized_paths.get(index)
                if path:
                    content_item = existing_by_path.get(collation_key(path))
                else:
                    # Legacy write path: no page identity was supplied, so fall back
                    # to matching on the title as this API originally did.
                    content_item = existing_by_key.get(
                        (section.type, section.title)
                    ) or existing_by_title.get(section.title)

                if content_item:
                    content_item.type = section.type
                    content_item.title = section.title
                    content_item.content = section.content
                    content_item.ext = section.ext or None
                    if path:
                        set_page_path(content_item, path)
                    content_item.updated_at = now
                    updated_sections += 1
                else:
                    content_record = WikiContent(
                        generation_id=generation.id,
                        type=section.type,
                        title=section.title,
                        content=section.content,
                        parent_id=(
                            section.parent_id if section.parent_id is not None else 0
                        ),
                        ext=section.ext or None,
                        created_at=now,
                        updated_at=now,
                    )
                    if path:
                        set_page_path(content_record, path)
                        existing_by_path[collation_key(path)] = content_record
                    wiki_db.add(content_record)
                    created_sections += 1

            try:
                wiki_db.flush()
            except Exception as exc:
                wiki_db.rollback()
                logger.error(
                    "[wiki] failed to write contents for generation %s: %s",
                    generation.id,
                    exc,
                )
                raise HTTPException(
                    status_code=400, detail="Failed to persist wiki contents"
                )

        # Applied after the writes, so that a payload both writing and removing a path
        # ends with it removed regardless of the order the agent listed them in.
        removed_paths = self._apply_removals(wiki_db, generation, payload.removed_paths)

        summary = payload.summary
        previous_status = generation.status
        ext = generation.ext.copy() if isinstance(generation.ext, dict) else {}
        content_meta = dict(ext.get("content_write") or {})
        content_meta["last_write_at"] = now.isoformat()
        content_meta["last_write_titles"] = titles
        content_meta["created_sections"] = created_sections
        content_meta["updated_sections"] = updated_sections
        if removed_paths:
            content_meta["removed_paths"] = removed_paths
        content_meta["status_before_write"] = (
            previous_status.value
            if isinstance(previous_status, WikiGenerationStatus)
            else (str(previous_status) if previous_status is not None else "UNKNOWN")
        )
        # Counted over the id, not over the entity. Query.count() wraps the whole
        # entity select in a subquery, so the database was told to materialise every
        # page's body to arrive at a number.
        content_meta["total_sections"] = (
            wiki_db.query(func.count(WikiContent.id))
            .filter(WikiContent.generation_id == generation.id)
            .scalar()
            or 0
        )

        if summary:
            summary_dict = summary.model_dump(exclude_none=True)
            content_meta["summary"] = summary_dict
            if summary.model:
                content_meta["model"] = summary.model
            if summary.tokens_used is not None:
                content_meta["tokens_used"] = summary.tokens_used

        ext["content_write"] = content_meta
        generation.ext = ext
        generation.updated_at = now

        # A code wiki does not simply record its outcome: a successful version has to
        # pass the publish gate and be projected into the knowledge base, and that runs
        # after this write is committed rather than inside it. Deferring the status too
        # keeps the two from disagreeing if the projection is refused.
        finishes_a_code_wiki = False

        if summary and summary.status:
            try:
                status_enum = WikiGenerationStatus(summary.status)
            except ValueError as exc:
                logger.error(
                    "[wiki] unsupported summary status %s for generation %s",
                    summary.status,
                    generation.id,
                )
                raise HTTPException(
                    status_code=400,
                    detail=f"Unsupported summary status: {summary.status}",
                ) from exc
            finishes_a_code_wiki = is_code_wiki_generation(wiki_db, generation)
            if finishes_a_code_wiki:
                generation.status = WikiGenerationStatus.RUNNING
            else:
                generation.status = status_enum
            if not finishes_a_code_wiki and status_enum in {
                WikiGenerationStatus.COMPLETED,
                WikiGenerationStatus.FAILED,
                WikiGenerationStatus.CANCELLED,
            }:
                generation.completed_at = now
            # For non-terminal statuses, keep the default epoch time (NOT NULL constraint)
            if status_enum == WikiGenerationStatus.FAILED:
                if summary.error_message:
                    content_meta["error_message"] = summary.error_message
            else:
                content_meta.pop("error_message", None)
        else:
            if generation.status != WikiGenerationStatus.RUNNING:
                generation.status = WikiGenerationStatus.RUNNING
                # Keep the default epoch time for completed_at (NOT NULL constraint)
            content_meta.pop("error_message", None)

        content_meta["status_after_write"] = (
            generation.status.value
            if isinstance(generation.status, WikiGenerationStatus)
            else (
                str(generation.status) if generation.status is not None else "UNKNOWN"
            )
        )

        try:
            wiki_db.commit()
        except Exception as exc:
            wiki_db.rollback()
            logger.error(
                "[wiki] failed to commit contents for generation %s: %s",
                generation.id,
                exc,
            )
            raise HTTPException(
                status_code=400, detail="Failed to commit wiki contents"
            )

        logger.info(
            "[wiki] saved contents for generation %s (created=%s, updated=%s, titles=%s, status %s -> %s)",
            generation.id,
            created_sections,
            updated_sections,
            titles,
            content_meta.get("status_before_write"),
            content_meta.get("status_after_write"),
        )

        if finishes_a_code_wiki:
            return self._finish_code_wiki(wiki_db, generation, summary)

    def get_generation_page(
        self,
        wiki_db: Session,
        generation_id: int,
        path: str,
    ) -> Optional[WikiPageRead]:
        """Read one page of a version by its path.

        Matched the same way a write is — normalised, then compared case-insensitively
        — so that a path which would update a page also reads it. Resolving them
        differently would let the agent read one page and overwrite another.

        Returns:
            The page, or ``None`` when the version holds none at that path.
        """
        try:
            normalized = normalize_page_path(path)
        except InvalidPagePath as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        wanted = collation_key(normalized)
        for content in (
            wiki_db.query(WikiContent)
            .filter(WikiContent.generation_id == generation_id)
            .all()
        ):
            content_path = page_path_of(content)
            if content_path and collation_key(content_path) == wanted:
                return WikiPageRead(
                    path=content_path,
                    title=content.title,
                    content=content.content,
                )
        return None

    def _apply_removals(
        self,
        wiki_db: Session,
        generation: WikiGeneration,
        paths: List[str],
    ) -> List[str]:
        """Drop pages the agent declared gone, returning the ones that existed.

        A path that names no page is reported rather than refused: an agent listing a
        page it already removed on a retry has nothing to correct, and failing the
        whole write would lose the sections alongside it.
        """
        removed: List[str] = []
        for raw_path in paths:
            try:
                normalized = normalize_page_path(raw_path)
            except InvalidPagePath as exc:
                wiki_db.rollback()
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            if remove_page(wiki_db, generation_id=generation.id, path=normalized):
                removed.append(normalized)
            else:
                logger.info(
                    "[wiki] removal of '%s' from generation %s matched no page",
                    normalized,
                    generation.id,
                )
        return removed

    def _finish_code_wiki(
        self,
        wiki_db: Session,
        generation: WikiGeneration,
        summary: Optional[WikiContentSummary],
    ) -> Optional[PublishResult]:
        """Conclude a code wiki run once its final write is safely committed.

        Failures here are reported to the agent as a 5xx rather than swallowed. The
        version is committed either way, so a retried submission republishes it; a
        silent failure would leave a run stuck RUNNING with content nobody projects.

        Returns:
            What the publish attempt did, or ``None`` when the run reported failure
            and there was nothing to publish. The whole outcome rather than a refusal
            string because the agent is the only party that can still act on any of
            it — it is running, its checkout is there — and that covers a version the
            gate refused *and* one that published carrying broken diagrams.
        """
        succeeded = summary is not None and summary.status == "COMPLETED"
        try:
            return finish_run(
                wiki_db,
                generation=generation,
                succeeded=succeeded,
                error_message=(summary.error_message if summary else "") or "",
                head_commit=(summary.head_commit if summary else "") or "",
            )
        except Exception as exc:
            wiki_db.rollback()
            logger.error(
                "[wiki] failed to conclude code wiki generation %s: %s",
                generation.id,
                exc,
            )
            raise HTTPException(
                status_code=500,
                detail=f"Failed to publish the wiki version: {exc}",
            ) from exc


wiki_service = WikiService()
