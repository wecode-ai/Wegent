# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""GitLab MR integration lifecycle: install/verify/remove the project webhook.

Owns the ``mr_integrations`` row for a cloud project and the matching GitLab
project hook. The management endpoints and the Celery reconcile task both use
this service so hook state stays consistent across manual and background
changes.
"""

import logging
from datetime import datetime, timedelta, timezone
from secrets import token_hex, token_urlsafe
from urllib.parse import quote

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.timezone import database_datetime_timezone
from app.models.cloud_project import CloudProject
from app.models.gitlab_mr import MRIntegration, MRRecord
from app.services.gitlab.client import ProjectScopedGitlabClient, resolve_repository
from app.services.gitlab.mr_service import (
    RECONCILE_EVALUATING_AGE_SECONDS,
    mr_service,
)

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _webhook_url(webhook_token: str) -> str:
    backend_base = str(settings.WEGENT_BACKEND_PUBLIC_URL or "").rstrip("/")
    return f"{backend_base}{settings.API_PREFIX}/v1/webhooks/gitlab/mr/{webhook_token}"


class MrIntegrationService:
    def enable(self, db: Session, project: CloudProject, user_id: int) -> MRIntegration:
        if project.task_provider != "gitlab":
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Project task provider is not gitlab"
            )
        client = ProjectScopedGitlabClient(project)
        repository = resolve_repository(project)
        existing = (
            db.query(MRIntegration)
            .filter(MRIntegration.cloud_project_id == str(project.id))
            .with_for_update()
            .first()
        )
        webhook_token = existing.webhook_token if existing else token_urlsafe(32)
        webhook_secret = existing.webhook_secret if existing else token_hex(16)
        if not self._configured_public_url():
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                "Backend public URL is not configured; set WEGENT_BACKEND_PUBLIC_URL",
            )
        try:
            hook = client.request(
                "POST",
                f"/projects/{quote(repository, safe='')}/hooks",
                json={
                    "url": _webhook_url(webhook_token),
                    "token": webhook_secret,
                    "merge_requests_events": True,
                    "note_events": True,
                    "pipeline_events": True,
                    "push_events": False,
                    "enable_ssl_verification": True,
                },
            )
        except HTTPException as exc:
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Failed to install GitLab webhook: {exc.detail}",
            ) from exc
        hook_id = int((hook or {}).get("id") or 0) if isinstance(hook, dict) else 0
        if existing and existing.gitlab_hook_id and existing.gitlab_hook_id != hook_id:
            # Replace the old hook only after the new one installed successfully;
            # a failed install must leave the old hook live.
            self._delete_hook(client, repository, existing.gitlab_hook_id)
        if existing:
            existing.repository = repository
            existing.domain = client.domain
            existing.api_base = client.api_base
            existing.gitlab_hook_id = hook_id
            existing.enabled = True
            existing.status = "ok"
            existing.last_error = ""
        else:
            existing = MRIntegration(
                cloud_project_id=str(project.id),
                project_key=project.project_key,
                repository=repository,
                domain=client.domain,
                api_base=client.api_base,
                webhook_token=webhook_token,
                webhook_secret=webhook_secret,
                gitlab_hook_id=hook_id,
                enabled=True,
                status="ok",
                created_by_user_id=user_id,
            )
            db.add(existing)
        try:
            db.flush()
        except IntegrityError:
            # A concurrent enable inserted first; return the winning row instead
            # of surfacing the constraint violation as a 500.
            db.rollback()
            existing = (
                db.query(MRIntegration)
                .filter(MRIntegration.cloud_project_id == str(project.id))
                .first()
            )
        return existing

    def disable(self, db: Session, project: CloudProject) -> None:
        integration = (
            db.query(MRIntegration)
            .filter(MRIntegration.cloud_project_id == str(project.id))
            .first()
        )
        if integration is None:
            return
        if integration.gitlab_hook_id:
            try:
                client = ProjectScopedGitlabClient(project)
                self._delete_hook(
                    client, integration.repository, integration.gitlab_hook_id
                )
            except HTTPException:
                logger.warning(
                    "Could not delete GitLab hook %s for project %s",
                    integration.gitlab_hook_id,
                    project.id,
                )
        db.query(MRRecord).filter(MRRecord.integration_id == integration.id).delete()
        db.delete(integration)
        db.flush()

    def status(self, db: Session, project: CloudProject) -> dict[str, object]:
        integration = (
            db.query(MRIntegration)
            .filter(MRIntegration.cloud_project_id == str(project.id))
            .first()
        )
        if integration is None:
            return {
                "enabled": False,
                "repository": None,
                "domain": None,
                "webhook_url": None,
                "hook_installed": False,
                "hook_id": 0,
                "status": "",
                "last_error": "",
                "last_reconcile_at": None,
            }
        hook_installed = False
        try:
            hook_installed = self._hook_exists(db, project, integration)
            integration.status = "ok" if hook_installed else "hook_missing"
            integration.last_error = ""
            integration.last_reconcile_at = _utcnow()
        except HTTPException as exc:
            integration.status = "error"
            integration.last_error = str(exc.detail)[:1000]
        db.flush()
        return {
            "enabled": integration.enabled,
            "repository": integration.repository,
            "domain": integration.domain,
            "webhook_url": _webhook_url(integration.webhook_token),
            "hook_installed": hook_installed,
            "hook_id": integration.gitlab_hook_id,
            "status": integration.status,
            "last_error": integration.last_error,
            "last_reconcile_at": integration.last_reconcile_at,
        }

    def reconcile(self, db: Session, integration: MRIntegration) -> None:
        """Sweep one integration: hook health, stale evaluating rounds, and
        open-MR bootstrap / lost merge closure."""
        project = db.get(CloudProject, integration.cloud_project_id)
        if project is None or not integration.enabled:
            return
        try:
            current_repository = resolve_repository(project)
        except HTTPException:
            integration.status = "error"
            integration.last_error = "Provider credential is not configured"
            db.flush()
            return
        if integration.repository != current_repository:
            integration.status = "error"
            integration.last_error = (
                "Repository changed in project settings; re-enable MR integration"
            )
            db.flush()
            return

        client = ProjectScopedGitlabClient(project)
        self._reconcile_hook(db, client, integration)

        # ``updated_at`` is written by ``func.now()`` under the session's forced
        # timezone; compute the cutoff in that same clock so stale evaluating
        # rounds settle at the intended age rather than ~8h late.
        db_tz = database_datetime_timezone(db)
        cutoff = datetime.now(db_tz).replace(tzinfo=None) - timedelta(
            seconds=RECONCILE_EVALUATING_AGE_SECONDS
        )
        records = (
            db.query(MRRecord)
            .filter(
                MRRecord.integration_id == integration.id,
                MRRecord.state != "closed",
            )
            .with_for_update()
            .all()
        )
        open_iids = self._open_mr_iids(client, integration)
        tracked = {record.mr_iid for record in records}
        for record in records:
            if record.mr_iid not in open_iids:
                mr_service.settle_by_reconcile(db, integration, project, record)
                continue
            if record.state == "evaluating" and record.updated_at < cutoff:
                mr_service.settle_by_reconcile(db, integration, project, record)
                continue
            # Re-fetch a round whose GitLab reads failed transiently so the card
            # gets the failed-job details / comments that were missing.
            if mr_service.has_incomplete_round(record):
                mr_service.finalize_round(
                    db,
                    integration,
                    project,
                    record,
                    terminal_status=record.pipeline_status,
                    pipeline_id=record.pipeline_id,
                )
        for iid in open_iids:
            if iid in tracked:
                continue
            bootstrapped = mr_service.bootstrap_mr(db, integration, project, iid)
            if bootstrapped is not None:
                mr_service.settle_by_reconcile(db, integration, project, bootstrapped)
        integration.last_reconcile_at = _utcnow()
        db.flush()

    # ------------------------------------------------------------- helpers

    def _reconcile_hook(
        self,
        db: Session,
        client: ProjectScopedGitlabClient,
        integration: MRIntegration,
    ) -> None:
        try:
            hooks = client.request(
                "GET",
                f"/projects/{quote(integration.repository, safe='')}/hooks",
                not_found_ok=True,
            )
            exists = isinstance(hooks, list) and any(
                isinstance(hook, dict)
                and int(hook.get("id") or 0) == integration.gitlab_hook_id
                for hook in hooks
            )
            if not exists:
                hook = client.request(
                    "POST",
                    f"/projects/{quote(integration.repository, safe='')}/hooks",
                    json={
                        "url": _webhook_url(integration.webhook_token),
                        "token": integration.webhook_secret,
                        "merge_requests_events": True,
                        "note_events": True,
                        "pipeline_events": True,
                        "push_events": False,
                        "enable_ssl_verification": True,
                    },
                )
                integration.gitlab_hook_id = (
                    int((hook or {}).get("id") or 0) if isinstance(hook, dict) else 0
                )
            integration.status = "ok"
            integration.last_error = ""
        except HTTPException as exc:
            integration.status = "error"
            integration.last_error = str(exc.detail)[:1000]

    def _hook_exists(
        self,
        db: Session,
        project: CloudProject,
        integration: MRIntegration,
    ) -> bool:
        client = ProjectScopedGitlabClient(project)
        hooks = client.request(
            "GET",
            f"/projects/{quote(integration.repository, safe='')}/hooks",
            not_found_ok=True,
        )
        return isinstance(hooks, list) and any(
            isinstance(hook, dict)
            and int(hook.get("id") or 0) == integration.gitlab_hook_id
            for hook in hooks
        )

    @staticmethod
    def _configured_public_url() -> bool:
        """Whether the webhook callback URL is reachable from GitLab.

        A missing or loopback default would install a hook GitLab can never
        reach, silently dropping every event; refuse to install instead."""
        url = str(settings.WEGENT_BACKEND_PUBLIC_URL or "").strip().rstrip("/")
        if not url.startswith(("http://", "https://")):
            return False
        host = url.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0].lower()
        return host not in {"localhost", "127.0.0.1"}

    @staticmethod
    def _delete_hook(
        client: ProjectScopedGitlabClient, repository: str, hook_id: int
    ) -> None:
        client.request(
            "DELETE",
            f"/projects/{quote(repository, safe='')}/hooks/{hook_id}",
            not_found_ok=True,
        )

    def _open_mr_iids(
        self,
        client: ProjectScopedGitlabClient,
        integration: MRIntegration,
    ) -> set[int]:
        mrs = client.request_all(
            "GET",
            f"/projects/{quote(integration.repository, safe='')}/merge_requests",
            params={"state": "opened", "scope": "all"},
            not_found_ok=True,
        )
        if not isinstance(mrs, list):
            return set()
        return {
            int(mr.get("iid") or 0)
            for mr in mrs
            if isinstance(mr, dict) and mr.get("iid")
        }


mr_integration_service = MrIntegrationService()
