# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab MR -> board fix-task state machine.

Every (integration, MR iid) has one :class:`MRRecord`; rounds are keyed by the
MR head SHA and accumulate in ``rounds_json``. The machine waits on a single
axis (CI): a round finalizes when its pipeline reaches a terminal state, then a
card is created or updated only when there is actionable feedback (a failed
pipeline or review comments). The Celery reconcile task settles rounds that
never receive a pipeline terminal event (no-CI repos or lost webhooks).
"""

import logging
from datetime import datetime, timezone
from urllib.parse import quote

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.cloud_project import CloudProject
from app.models.delivery import LoopItem, ProjectChatAgent
from app.models.gitlab_mr import EPOCH_TIME, MRIntegration, MRRecord
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.share_link import ResourceType
from app.models.user import User
from app.services.gitlab.client import ProjectScopedGitlabClient
from app.services.gitlab.mr_templates import (
    max_retry_count,
    mr_snapshot,
    render_card_description,
    resolve_status_id,
    trace_tail,
)
from app.services.loop_item_status_history import write_status_change

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = {"success", "failed", "canceled", "skipped", "error"}
FAILED_STATUSES = {"failed", "canceled", "error"}
ROUNDS_STORED_LIMIT = 5
RECONCILE_EVALUATING_AGE_SECONDS = 600

# Human-readable action copy baked into MR fix-card status history at write
# time, so the frontend renders the entry directly instead of inferring the
# card type from unrelated fields.
_MR_ACTION_LABELS = {
    "create": "创建修复任务",
    "ai_started": "收到新反馈，重新处理",
    "ai_completed": "提交修复，待确认",
    "mr_merged": "MR 合并，已完成",
}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _note_position(attrs: dict[str, object]) -> dict[str, object]:
    """Extract the diff position (file/line) GitLab attaches to diff notes."""
    pos = attrs.get("position")
    if not isinstance(pos, dict):
        return {}
    path = str(pos.get("new_path") or pos.get("old_path") or "")
    line = int(pos.get("new_line") or pos.get("old_line") or 0)
    return {
        "path": path,
        "line": line,
        "position_type": str(pos.get("position_type") or ""),
    }


def _is_reply(note: dict[str, object]) -> bool:
    """Whether a note replies inside an existing discussion.

    Replies are part of the feedback they respond to, not new feedback; the
    state machine ignores them entirely (the pipeline's own confirmation
    comments and standalone self-comments are independent notes and still
    count).
    """
    return bool(int(note.get("in_reply_to_id") or 0))


class MrService:
    @staticmethod
    def _client(project: CloudProject) -> ProjectScopedGitlabClient:
        return ProjectScopedGitlabClient(project)

    @staticmethod
    def _api_path(client: ProjectScopedGitlabClient, suffix: str) -> str:
        return f"/projects/{quote(client.repository, safe='')}{suffix}"

    @staticmethod
    def _norm_domain(domain: str) -> str:
        domain = domain.strip().rstrip("/").lower()
        if "://" in domain:
            domain = domain.split("://", 1)[1]
        return domain.rstrip("/")

    # ------------------------------------------------------------------ state

    def _round_template(self, round_number: int, sha: str) -> dict[str, object]:
        return {
            "sha": sha,
            "round_number": round_number,
            "pipeline_status": "pending",
            "pipeline_id": 0,
            "failed_jobs": [],
            "notes": [],
            "at": _utcnow().isoformat(),
        }

    def _cap_rounds(self, record: MRRecord) -> None:
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        if len(rounds) > ROUNDS_STORED_LIMIT:
            record.rounds_json = rounds[-ROUNDS_STORED_LIMIT:]

    @staticmethod
    def has_incomplete_round(record: MRRecord) -> bool:
        """Whether the latest round's GitLab fetch (jobs/trace/notes) failed."""
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        return bool(rounds) and bool(rounds[-1].get("fetch_error"))

    def _snapshot_from_attrs(
        self, attrs: dict[str, object], head_sha: str
    ) -> dict[str, object]:
        return {
            "iid": int(attrs.get("iid") or 0),
            "title": str(attrs.get("title") or ""),
            "web_url": str(attrs.get("url") or ""),
            "source_branch": str(attrs.get("source_branch") or ""),
            "target_branch": str(attrs.get("target_branch") or ""),
            "author_id": int(attrs.get("author_id") or 0),
            "author_username": str(attrs.get("author_username") or ""),
            "head_sha": head_sha,
            "description": str(attrs.get("description") or ""),
        }

    def _create_record(
        self, integration: MRIntegration, mr_iid: int, attrs: dict[str, object]
    ) -> MRRecord:
        last_commit = (
            attrs.get("last_commit")
            if isinstance(attrs.get("last_commit"), dict)
            else {}
        )
        head_sha = str(last_commit.get("id") or "") or str(attrs.get("sha") or "")
        mr_state = str(attrs.get("state") or "")
        snapshot = self._snapshot_from_attrs(attrs, head_sha)
        snapshot["repository"] = integration.repository
        snapshot["domain"] = integration.domain
        return MRRecord(
            integration_id=integration.id,
            mr_iid=mr_iid,
            project_key=integration.project_key,
            source_branch=str(attrs.get("source_branch") or ""),
            target_branch=str(attrs.get("target_branch") or ""),
            author_id=int(attrs.get("author_id") or 0),
            mr_title=str(attrs.get("title") or ""),
            state="closed" if mr_state in {"merged", "closed"} else "evaluating",
            head_sha=head_sha,
            round_number=1,
            pipeline_status="pending",
            pipeline_id=0,
            snapshot_json=snapshot,
            rounds_json=[self._round_template(1, head_sha)],
            version=1,
        )

    def _get_or_bootstrap_record(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        mr_iid: int,
    ) -> MRRecord | None:
        """Return the record for an MR, bootstrapping it from GitLab when the
        MR open/update webhook was lost. Returns ``None`` when the MR is gone."""
        record = (
            db.query(MRRecord)
            .filter(
                MRRecord.integration_id == integration.id,
                MRRecord.mr_iid == mr_iid,
            )
            .with_for_update()
            .first()
        )
        if record is not None:
            return record
        client = self._client(project)
        data = client.request(
            "GET",
            self._api_path(client, f"/merge_requests/{mr_iid}"),
            not_found_ok=True,
        )
        if not isinstance(data, dict):
            return None
        attrs: dict[str, object] = {
            "iid": mr_iid,
            "title": data.get("title") or "",
            "state": data.get("state") or "",
            "source_branch": data.get("source_branch") or "",
            "target_branch": data.get("target_branch") or "",
            "author_id": (data.get("author") or {}).get("id") or 0,
            "author_username": (data.get("author") or {}).get("username") or "",
            "url": data.get("web_url") or "",
            "sha": data.get("sha") or "",
            "description": data.get("description") or "",
        }
        record = self._create_record(integration, mr_iid, attrs)
        # The FOR UPDATE miss above holds a gap lock on the (integration, iid)
        # unique key, so a concurrent worker's insert cannot race this one in
        # MySQL; any residual conflict surfaces as an IntegrityError that the
        # caller's retry / next reconcile pass absorbs instead of silently
        # discarding flushed work here.
        db.add(record)
        db.flush()
        return record

    def _update_snapshot(
        self,
        record: MRRecord,
        attrs: dict[str, object],
        integration: MRIntegration,
    ) -> None:
        last_commit = (
            attrs.get("last_commit")
            if isinstance(attrs.get("last_commit"), dict)
            else {}
        )
        head_sha = str(last_commit.get("id") or "") or str(attrs.get("sha") or "")
        record.mr_title = str(attrs.get("title") or record.mr_title or "")
        record.source_branch = str(
            attrs.get("source_branch") or record.source_branch or ""
        )
        record.target_branch = str(
            attrs.get("target_branch") or record.target_branch or ""
        )
        snapshot = self._snapshot_from_attrs(attrs, head_sha or record.head_sha)
        snapshot["repository"] = integration.repository
        snapshot["domain"] = integration.domain
        record.snapshot_json = snapshot

    # ------------------------------------------------------------- handlers

    def bootstrap_mr(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        mr_iid: int,
    ) -> MRRecord | None:
        """Ensure a record exists for an MR, fetching it from GitLab when the
        MR open/update webhook was lost. Public wrapper used by reconcile."""
        return self._get_or_bootstrap_record(db, integration, project, mr_iid)

    def handle_merge_request_event(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        payload: dict[str, object],
    ) -> MRRecord | None:
        attrs = payload.get("object_attributes") or {}
        if not isinstance(attrs, dict):
            return
        mr_iid = int(attrs.get("iid") or 0)
        if mr_iid <= 0:
            return
        record = self._get_or_bootstrap_record(db, integration, project, mr_iid)
        if record is None:
            return
        self._update_snapshot(record, attrs, integration)
        mr_state = str(attrs.get("state") or "")
        if mr_state in {"merged", "closed"}:
            self.close_record(db, integration, project, record)
            return
        if mr_state == "reopened" and record.state == "closed":
            record.state = "evaluating"
            record.closed_at = EPOCH_TIME
            # A reopen is a fresh MR lifecycle: reset the auto-run cap so the
            # robot can retry the reopened MR (the cap stays per lifecycle).
            record.auto_retrigger_count = 0
            self._transition_card(
                db, project, record, to_logical="in_progress", trigger="user_update"
            )
            moved = True
            # Fall through to the head_sha check: a reopen may carry a new head,
            # which must start a fresh round instead of keeping the stale sha.
        else:
            moved = False
        last_commit = (
            attrs.get("last_commit")
            if isinstance(attrs.get("last_commit"), dict)
            else {}
        )
        head_sha = str(last_commit.get("id") or "") or str(attrs.get("sha") or "")
        if head_sha and head_sha != record.head_sha:
            record.round_number += 1
            record.head_sha = head_sha
            record.pipeline_status = "pending"
            record.pipeline_id = 0
            record.state = "evaluating"
            rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
            rounds.append(self._round_template(record.round_number, head_sha))
            record.rounds_json = rounds
            flag_modified(record, "rounds_json")
            self._cap_rounds(record)
            # A new head means a fix was pushed; wait for CI/review to confirm.
            self._transition_card(
                db, project, record, to_logical="in_review", trigger="ai_completed"
            )
            moved = True
        if not moved:
            self._refresh_card(db, project, record)
        db.flush()
        return record

    def handle_pipeline_event(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        payload: dict[str, object],
    ) -> MRRecord | None:
        attrs = payload.get("object_attributes") or {}
        if not isinstance(attrs, dict):
            return
        sha = str(attrs.get("sha") or "")
        status = str(attrs.get("status") or "")
        pipeline_id = int(attrs.get("id") or 0)
        if not sha or status not in TERMINAL_STATUSES:
            return
        records = (
            db.query(MRRecord)
            .filter(
                MRRecord.integration_id == integration.id,
                MRRecord.head_sha == sha,
                MRRecord.state == "evaluating",
            )
            .with_for_update()
            .order_by(MRRecord.updated_at.desc())
            .all()
        )
        if not records:
            return
        record = self._pipeline_target(records, str(attrs.get("ref") or ""))
        if record is None:
            # Ambiguous or unmatched ref; settle by sha in reconcile instead of
            # finalizing the wrong MR.
            return
        self.finalize_round(
            db,
            integration,
            project,
            record,
            terminal_status=status,
            pipeline_id=pipeline_id,
        )
        return record

    @staticmethod
    def _pipeline_target(records: list[MRRecord], ref: str) -> MRRecord | None:
        """Pick the record a pipeline event belongs to.

        ``ref`` may be an MR-pipeline ref (``refs/merge-requests/{iid}/head``),
        a branch ref (``refs/heads/...`` or bare branch), or empty. Match it
        precisely and never guess among multiple records that share a head sha;
        an unmatched event is left for reconcile to settle by sha."""
        if ref.startswith("refs/merge-requests/"):
            raw = ref[len("refs/merge-requests/") :].split("/", 1)[0]
            try:
                iid = int(raw)
            except ValueError:
                iid = 0
            if iid:
                for record in records:
                    if record.mr_iid == iid:
                        return record
            return None
        branch = ref[len("refs/heads/") :] if ref.startswith("refs/heads/") else ref
        if not branch:
            return records[0] if len(records) == 1 else None
        for record in records:
            if record.source_branch == branch:
                return record
        return None

    def handle_note_event(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        payload: dict[str, object],
    ) -> MRRecord | None:
        attrs = payload.get("object_attributes") or {}
        if not isinstance(attrs, dict):
            return
        if str(attrs.get("noteable_type") or "") != "MergeRequest":
            return
        if bool(attrs.get("system")):
            return
        body = str(attrs.get("note") or "").strip()
        if not body:
            return
        mr_obj = payload.get("merge_request") or {}
        if not isinstance(mr_obj, dict):
            return
        mr_iid = int(mr_obj.get("iid") or 0)
        if mr_iid <= 0:
            return
        record = self._get_or_bootstrap_record(db, integration, project, mr_iid)
        if record is None or record.state == "closed":
            return
        if record.state == "evaluating":
            # The round's finalize fetches the full notes list from GitLab and
            # will capture this note there; ignore it here to stay idempotent.
            return
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        if not rounds:
            rounds = [self._round_template(record.round_number, record.head_sha)]
            record.rounds_json = rounds
        current = rounds[-1]
        note_id = int(attrs.get("id") or 0)
        # A reply inside an existing discussion is part of that feedback, not
        # new feedback; ignore it entirely.
        if int(attrs.get("in_reply_to_id") or 0):
            return
        existing = {
            int(n.get("id") or 0)
            for n in (current.get("notes") or [])
            if isinstance(n, dict)
        }
        if note_id and note_id in existing:
            return
        note_list = current.get("notes")
        if not isinstance(note_list, list):
            note_list = []
            current["notes"] = note_list
        note_list.append(
            {
                "id": note_id,
                # GitLab webhooks put the author at the payload top level (user);
                # object_attributes.author is not sent, so fall back to it.
                "author": str(
                    (payload.get("user") or {}).get("username")
                    or (attrs.get("author") or {}).get("username")
                    or ""
                ),
                "note": body,
                "web_url": str(attrs.get("url") or ""),
                "created_at": str(attrs.get("created_at") or ""),
                "discussion_id": str(attrs.get("discussion_id") or ""),
                "in_reply_to_id": int(attrs.get("in_reply_to_id") or 0),
                "position": _note_position(attrs),
            }
        )
        flag_modified(record, "rounds_json")
        if self._has_active_run(db, record):
            # A run is already working; the comment accumulates as pending
            # feedback and the card is re-pulled once for it when the run ends.
            db.flush()
            return
        self.create_or_update_card(db, integration, project, record)
        self._maybe_retrigger(db, integration, project, record)
        return record

    def finalize_round(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
        *,
        terminal_status: str,
        pipeline_id: int,
    ) -> None:
        client = self._client(project)
        failed_jobs: list[dict[str, object]] = []
        fetch_error = False
        if pipeline_id and terminal_status in FAILED_STATUSES:
            try:
                jobs = client.request(
                    "GET",
                    self._api_path(client, f"/pipelines/{pipeline_id}/jobs"),
                    params={"status": "failed"},
                    not_found_ok=True,
                )
                if isinstance(jobs, list):
                    for job in jobs:
                        if not isinstance(job, dict):
                            continue
                        job_id = int(job.get("id") or 0)
                        trace_summary = ""
                        if job_id:
                            trace = client.text(
                                "GET",
                                self._api_path(client, f"/jobs/{job_id}/trace"),
                                not_found_ok=True,
                            )
                            trace_summary = trace_tail(trace or "")
                        failed_jobs.append(
                            {
                                "id": job_id,
                                "name": str(job.get("name") or ""),
                                "stage": str(job.get("stage") or ""),
                                "web_url": str(job.get("web_url") or ""),
                                "trace_tail": trace_summary,
                                "started_at": str(
                                    job.get("started_at") or job.get("created_at") or ""
                                ),
                            }
                        )
            except Exception:
                logger.warning(
                    "Failed to fetch failed jobs for pipeline %s (integration %s)",
                    pipeline_id,
                    integration.id,
                    exc_info=True,
                )
                fetch_error = True
        notes: list[dict[str, object]] = []
        try:
            notes_data = client.request_all(
                "GET",
                self._api_path(client, f"/merge_requests/{record.mr_iid}/notes"),
                not_found_ok=True,
            )
            if isinstance(notes_data, list):
                for note in notes_data:
                    if not isinstance(note, dict) or bool(note.get("system")):
                        continue
                    body = str(note.get("body") or "").strip()
                    if not body:
                        continue
                    notes.append(
                        {
                            "id": int(note.get("id") or 0),
                            "author": str(
                                (note.get("author") or {}).get("username") or ""
                            ),
                            "note": body,
                            "web_url": str(note.get("web_url") or ""),
                            "created_at": str(note.get("created_at") or ""),
                            "discussion_id": str(note.get("discussion_id") or ""),
                            "in_reply_to_id": int(note.get("in_reply_to_id") or 0),
                            "position": _note_position(note),
                        }
                    )
        except Exception:
            logger.warning(
                "Failed to fetch notes for MR %s (integration %s)",
                record.mr_iid,
                integration.id,
                exc_info=True,
            )
            fetch_error = True

        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        if not rounds or rounds[-1].get("round_number") != record.round_number:
            rounds.append(self._round_template(record.round_number, record.head_sha))
            record.rounds_json = rounds
        current = rounds[-1]
        # A round only accumulates the standalone (non-reply) comments that
        # arrived after its head; older rounds' comments are handled by the
        # latest commit and never surface again as current feedback.
        standalone_notes = [n for n in notes if not _is_reply(n)]
        existing_ids = {
            int(n.get("id") or 0)
            for item in rounds
            for n in (item.get("notes") or [])
            if isinstance(n, dict)
        }
        current_notes = (
            list(current.get("notes")) if isinstance(current.get("notes"), list) else []
        )
        current_ids = {int(n.get("id") or 0) for n in current_notes}
        current["notes"] = current_notes + [
            n
            for n in standalone_notes
            if int(n.get("id") or 0) not in existing_ids
            and int(n.get("id") or 0) not in current_ids
        ]
        current["pipeline_status"] = terminal_status
        current["pipeline_id"] = pipeline_id
        current["failed_jobs"] = failed_jobs
        current["fetch_error"] = fetch_error
        current["at"] = _utcnow().isoformat()
        # JSON columns do not track in-place nested mutations; mark the column
        # modified so the terminal pipeline data and notes survive the commit.
        flag_modified(record, "rounds_json")
        self._cap_rounds(record)

        # A comment is new actionable feedback only when it is a standalone note
        # the latest robot run has not seen yet (a reply is part of the feedback
        # it responds to, not new feedback). Before any run has ever dispatched
        # (human-driven MR), fall back to the round boundary: earlier rounds'
        # comments are addressed by the latest fix.
        if record.seen_note_ids:
            pending_ids = self._pending_note_ids(record, standalone_notes)
            new_notes = [
                note
                for note in standalone_notes
                if int(note.get("id") or 0) in pending_ids
            ]
        else:
            previous_note_ids = {
                int(n.get("id") or 0)
                for item in rounds[:-1]
                for n in (item.get("notes") or [])
                if isinstance(n, dict)
            }
            new_notes = [
                note
                for note in standalone_notes
                if int(note.get("id") or 0) not in previous_note_ids
            ]
        record.pipeline_status = terminal_status
        record.pipeline_id = pipeline_id
        actionable = terminal_status in FAILED_STATUSES or bool(new_notes)
        record.state = "actionable" if actionable else "clean"
        if actionable:
            self.create_or_update_card(db, integration, project, record)
            self._maybe_retrigger(db, integration, project, record)
        else:
            # CI green with no new comments: the card may move to in_review,
            # but only when no run is still active (the _transition_card guard
            # keeps it in progress otherwise until the run settles).
            self._transition_card(
                db, project, record, to_logical="in_review", trigger="ai_completed"
            )
        db.flush()

    def reconcile_pending_feedback(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        """Re-pull the card when a run finished with comments it never saw.

        Called after an execution completes so mid-run review comments (which the
        running AI never read) trigger one batched re-run instead of being
        treated as addressed. ``finalize_round`` covers the fix-pushed path; this
        covers runs that complete without pushing a new head.
        """
        if record.state in {"closed", "evaluating"}:
            return
        if not record.current_loop_item_id:
            return
        if self._has_active_run(db, record):
            return
        if self._unseen_note_ids(record):
            record.state = "actionable"
            self.create_or_update_card(db, integration, project, record)
            self._maybe_retrigger(db, integration, project, record)
        else:
            # The run settled with no new feedback: settle the card into the
            # review column when its CI is green and nothing is pending.
            self._transition_card(
                db, project, record, to_logical="in_review", trigger="ai_completed"
            )
        db.flush()

    # ----------------------------------------------------------------- cards

    def create_or_update_card(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == integration.cloud_project_id)
            .with_for_update()
            .one()
        )
        binding_id = f"gitlab:mr:{integration.repository}:{record.mr_iid}"
        card = (
            db.query(LoopItem)
            .filter(
                LoopItem.source_task_binding_id == binding_id,
                LoopItem.cloud_project_id == str(project.id),
                LoopItem.deleted_at.is_(None),
            )
            # Locking read: two concurrent note events for the same MR must not
            # both see "no card" and race to INSERT (REPEATABLE READ snapshots
            # hide the other transaction's committed insert).
            .with_for_update()
            .first()
        )
        title = f"MR !{record.mr_iid} · {record.mr_title or ''}"
        snapshot = mr_snapshot(record)
        description = render_card_description(project, record)
        assignee = self._resolve_assignee_user_id(
            db, project, integration, record.author_id
        )
        if card is None:
            sequence = project.next_item_number
            project.next_item_number += 1
            card = LoopItem(
                # Distinct namespace so MR cards never collide with GitLab issue
                # ids ({project_key}-{iid}) in the merged board list.
                id=f"{project.project_key}-mr-{sequence}",
                cloud_project_id=str(project.id),
                sequence_number=sequence,
                title=title,
                description=description,
                # A fresh fix card lands in the inbox like any board task: it is
                # not being worked yet, and the executor's auto-start only picks
                # up inbox/pending cards.
                status=resolve_status_id(project, "inbox"),
                priority="none",
                source="gitlab",
                source_task_binding_id=binding_id,
                source_task_snapshot=snapshot,
                assignee_user_id=assignee,
                assignee_agent_id="",
                created_by_user_id=integration.created_by_user_id or 0,
                metadata_json={"tags": ["mr-fix"]},
                version=1,
            )
            self._record_card_status(
                card,
                project,
                from_status="",
                to_status=resolve_status_id(project, "inbox"),
                trigger="create",
                by_user_id=integration.created_by_user_id or None,
            )
            db.add(card)
            db.flush()
            record.current_loop_item_id = card.id
            # Transient marker for the caller: a fresh fix card should feed the
            # project-automation assignment flow. It is a plain Python attribute,
            # never persisted; the Celery task reads it after commit and fires a
            # task.created event.
            record._mr_card_created = True
        else:
            card.title = title
            card.description = description
            # Keep an unassigned inbox card in the inbox; only an already-started
            # card (in review) goes back to in progress on new feedback. History
            # is recorded only for a real status change, not a no-op re-set.
            in_progress = resolve_status_id(project, "in_progress")
            if card.status not in {resolve_status_id(project, "inbox"), in_progress}:
                self._record_card_status(
                    card,
                    project,
                    from_status=card.status,
                    to_status=in_progress,
                    trigger="ai_started",
                    by_user_id=None,
                )
                card.status = in_progress
            card.source_task_snapshot = snapshot
            card.assignee_user_id = assignee
            card.version += 1
        record.state = "actionable"
        db.flush()

    def _maybe_retrigger(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        """Auto-start a fresh run for the assigned robot when a round settles
        actionable (CI failed or new comments). A run reads the card at dispatch,
        so each round starts with the latest instruction. Capped by the project's
        ai_automation.max_retry_count; never starts a second run while one is
        already active."""
        if not record.current_loop_item_id:
            return
        card = db.get(LoopItem, record.current_loop_item_id)
        if card is None or card.deleted_at is not None or not card.assignee_agent_id:
            return
        if record.auto_retrigger_count >= max_retry_count(project):
            return
        from app.models.loop_item_execution import LoopItemExecution

        active = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == card.id,
                LoopItemExecution.status.in_(
                    {"pending_approval", "queued", "claimed", "running"}
                ),
            )
            .first()
        )
        if active is not None:
            return
        from app.services.loop_item_executions.service import (
            loop_item_execution_service,
        )
        from app.services.project_chat.service import bot_config

        agent = db.get(ProjectChatAgent, card.assignee_agent_id)
        if agent is None or agent.status != "active":
            return
        config = bot_config(agent)
        loop_item_execution_service.create_for_assignment(
            db,
            loop_item_id=card.id,
            cloud_project_id=str(project.id),
            agent=agent,
            assigner_user_id=(
                integration.created_by_user_id or project.created_by_user_id or 0
            ),
            environment=str(config.get("execution_environment") or "local"),
            execution_device_id=(
                config.get("execution_device_id")
                if isinstance(config.get("execution_device_id"), str)
                else None
            ),
            priority=card.priority,
        )
        record.auto_retrigger_count += 1
        db.flush()

    def close_record(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        if record.state == "closed":
            return
        record.state = "closed"
        record.closed_at = _utcnow()
        record.version += 1
        if record.current_loop_item_id:
            card = db.get(LoopItem, record.current_loop_item_id)
            if card is not None and card.deleted_at is None:
                # Content first so the card shows the closed state under the new
                # completed status, and the merge is recorded in history.
                self._apply_card_content(card, project, record)
                self._record_card_status(
                    card,
                    project,
                    from_status=card.status,
                    to_status=resolve_status_id(project, "completed"),
                    trigger="mr_merged",
                    by_user_id=None,
                )
                card.status = resolve_status_id(project, "completed")
                card.completed_at = _utcnow()
                card.version += 1
        db.flush()

    def settle_by_reconcile(
        self,
        db: Session,
        integration: MRIntegration,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        """Close MRs that merged/closed without an event, and finalize rounds
        that never received a pipeline terminal event (no-CI repos or lost
        webhooks)."""
        if record.state == "closed":
            return
        client = self._client(project)
        mr = client.request(
            "GET",
            self._api_path(client, f"/merge_requests/{record.mr_iid}"),
            not_found_ok=True,
        )
        if not isinstance(mr, dict):
            return
        if str(mr.get("state") or "") in {"merged", "closed"}:
            self.close_record(db, integration, project, record)
            return
        if record.state != "evaluating":
            return
        pipelines = client.request(
            "GET",
            self._api_path(client, "/pipelines"),
            params={"sha": record.head_sha, "per_page": 1},
            not_found_ok=True,
        )
        if not isinstance(pipelines, list) or not pipelines:
            # No pipeline exists for this head: settle as CI-passed so any notes
            # still surface a card through finalize.
            self.finalize_round(
                db,
                integration,
                project,
                record,
                terminal_status="success",
                pipeline_id=0,
            )
            return
        latest = pipelines[0]
        if not isinstance(latest, dict):
            return
        status = str(latest.get("status") or "")
        if status in TERMINAL_STATUSES:
            self.finalize_round(
                db,
                integration,
                project,
                record,
                terminal_status=status,
                pipeline_id=int(latest.get("id") or 0),
            )

    # ------------------------------------------------------------- helpers

    @staticmethod
    def _discussion_key(note: dict[str, object]) -> str:
        """A note's thread identity: its GitLab discussion id, or itself when it
        is a standalone comment with no thread."""
        return str(note.get("discussion_id") or note.get("id") or "")

    def _pending_note_ids(
        self, record: MRRecord, notes: list[dict[str, object]]
    ) -> set[int]:
        """Note ids representing NEW pending feedback among ``notes``.

        A note is pending only when it is a standalone (non-reply) note the
        latest robot run has not seen. Replies belong to the feedback they
        respond to and never start new work. Empty ``seen_note_ids`` means the
        run dispatched with no comments, so every standalone note is pending."""
        seen_note_ids = set(int(x) for x in (record.seen_note_ids or []))
        seen_keys: set[str] = set()
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        for item in rounds:
            for n in item.get("notes") or []:
                if isinstance(n, dict) and int(n.get("id") or 0) in seen_note_ids:
                    seen_keys.add(self._discussion_key(n))
        pending: set[int] = set()
        for note in notes:
            if not isinstance(note, dict) or _is_reply(note):
                continue
            note_id = int(note.get("id") or 0)
            if note_id in seen_note_ids:
                continue
            if self._discussion_key(note) in seen_keys:
                continue
            pending.add(note_id)
        return pending

    def _unseen_note_ids(self, record: MRRecord) -> set[int]:
        """Note ids the latest robot run has not seen, per discussion.

        Called only after a run completes (``reconcile_pending_feedback``), so an
        empty ``seen_note_ids`` means the run dispatched with no comments — every
        note present now arrived mid-run and must re-pull the card."""
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        all_notes = [n for item in rounds for n in (item.get("notes") or [])]
        return self._pending_note_ids(record, all_notes)

    def _has_active_run(self, db: Session, record: MRRecord) -> bool:
        if not record.current_loop_item_id:
            return False
        from app.models.loop_item_execution import LoopItemExecution

        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.loop_item_id == record.current_loop_item_id,
                LoopItemExecution.status.in_(
                    {"pending_approval", "queued", "claimed", "running"}
                ),
            )
            .first()
            is not None
        )

    def _card_ready_for_review(self, db: Session, record: MRRecord) -> bool:
        """Whether the card satisfies the in_review invariant: CI green, no
        current-round standalone comments, and no active robot run.

        A card may sit in the review column only while nobody is working it and
        there is nothing left to act on; otherwise a pull-back could land on an
        active run and silently drop the new feedback.
        """
        if str(record.pipeline_status or "") != "success":
            return False
        if self._has_active_run(db, record):
            return False
        rounds = record.rounds_json if isinstance(record.rounds_json, list) else []
        current = rounds[-1] if rounds else {}
        current_notes = (
            current.get("notes") if isinstance(current.get("notes"), list) else []
        )
        return not current_notes

    def _transition_card(
        self,
        db: Session,
        project: CloudProject,
        record: MRRecord,
        *,
        to_logical: str,
        trigger: str,
        by_user_id: int | None = None,
    ) -> None:
        """Refresh the card to current state, then change its status with history.

        Order is deliberate: the description/snapshot is updated first so the
        card never shows stale content under a new status, and every transition
        is recorded via ``write_status_change``.

        ``in_review`` is an invariant: a card only sits in the review column
        when its CI is green, it has no current-round comments, and no run is
        active. A request that does not satisfy that (e.g. a fresh head whose
        CI has not confirmed yet) falls back to keeping the card in progress.
        """
        if not record.current_loop_item_id:
            return
        card = db.get(LoopItem, record.current_loop_item_id)
        if card is None or card.deleted_at is not None:
            return
        if to_logical == "in_review" and not self._card_ready_for_review(db, record):
            to_logical = "in_progress"
        self._apply_card_content(card, project, record)
        to_status = resolve_status_id(project, to_logical)
        if to_status != card.status:
            self._record_card_status(
                card,
                project,
                from_status=card.status,
                to_status=to_status,
                trigger=trigger,
                by_user_id=by_user_id,
            )
            card.status = to_status
        card.version += 1
        db.flush()

    def _apply_card_content(
        self,
        card: LoopItem,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        """Refresh the card's title/description/snapshot to the record's state."""
        card.title = f"MR !{record.mr_iid} · {record.mr_title or ''}"
        card.description = render_card_description(project, record)
        card.source_task_snapshot = mr_snapshot(record)

    @staticmethod
    def _record_card_status(
        card: LoopItem,
        project: CloudProject,
        *,
        from_status: str,
        to_status: str,
        trigger: str,
        by_user_id: int | None,
    ) -> None:
        """Record one status transition in the card's metadata history.

        ``write_status_change`` mutates the passed dict in place; a plain JSON
        column does not track nested mutations, so the metadata is shallow-copied
        and reassigned for SQLAlchemy to persist the change.
        """
        metadata = (
            dict(card.metadata_json) if isinstance(card.metadata_json, dict) else {}
        )
        write_status_change(
            metadata,
            project=project,
            from_status=from_status,
            to_status=to_status,
            trigger=trigger,
            by_user_id=by_user_id,
            label=_MR_ACTION_LABELS.get(trigger),
        )
        card.metadata_json = metadata

    def _refresh_card(
        self,
        db: Session,
        project: CloudProject,
        record: MRRecord,
    ) -> None:
        if not record.current_loop_item_id:
            return
        card = db.get(LoopItem, record.current_loop_item_id)
        if card is None or card.deleted_at is not None:
            return
        self._apply_card_content(card, project, record)
        card.version += 1
        db.flush()

    def _resolve_assignee_user_id(
        self,
        db: Session,
        project: CloudProject,
        integration: MRIntegration,
        author_id: int,
    ) -> int | None:
        fallback = integration.created_by_user_id or None
        if not author_id:
            return fallback
        for user_id in self._project_member_ids(db, project):
            user = db.get(User, user_id)
            if user is None or not user.git_info:
                continue
            for info in user.git_info:
                if not isinstance(info, dict):
                    continue
                if (
                    info.get("type") == "gitlab"
                    and self._norm_domain(str(info.get("git_domain") or ""))
                    == self._norm_domain(integration.domain)
                    and str(info.get("git_id") or "") == str(author_id)
                ):
                    return user.id
        return fallback

    @staticmethod
    def _project_member_ids(db: Session, project: CloudProject) -> list[int]:
        member_ids: list[int] = []
        if project.created_by_user_id:
            member_ids.append(project.created_by_user_id)
        rows = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == ResourceType.CLOUD_PROJECT.value,
                ResourceMember.resource_id == project.id,
                ResourceMember.entity_type == "user",
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        for row in rows:
            try:
                member_ids.append(int(row.entity_id))
            except (TypeError, ValueError):
                continue
        return member_ids


mr_service = MrService()
