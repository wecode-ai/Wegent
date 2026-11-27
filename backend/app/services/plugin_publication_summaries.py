"""Load only associations referenced by an authorized publication page."""

import logging
from dataclasses import dataclass, field
from time import perf_counter

from sqlalchemy.orm import Session

from app.models.plugin_marketplace import Plugin
from app.models.plugin_publication import (
    PluginPublicationCheck,
    PluginPublicationRequest,
    PluginPublicationRevision,
)
from app.models.user import User

logger = logging.getLogger(__name__)


@dataclass
class PublicationSummaryData:
    plugins: dict[int, Plugin] = field(default_factory=dict)
    users: dict[int, User] = field(default_factory=dict)
    revisions: dict[int, PluginPublicationRevision] = field(default_factory=dict)
    checks: dict[int, list[PluginPublicationCheck]] = field(default_factory=dict)

    def revision(
        self, request: PluginPublicationRequest
    ) -> PluginPublicationRevision | None:
        revision = self.revisions.get(request.current_revision_id)
        return revision if revision and revision.request_id == request.id else None


def load_summary_data(
    db: Session, requests: list[PluginPublicationRequest]
) -> PublicationSummaryData:
    started = perf_counter()
    data = PublicationSummaryData()
    if not requests:
        return data
    plugin_ids = {row.source_plugin_id for row in requests}
    user_ids = {row.submitter_user_id for row in requests}
    revision_ids = {row.current_revision_id for row in requests}
    data.plugins = {
        row.id: row for row in db.query(Plugin).filter(Plugin.id.in_(plugin_ids)).all()
    }
    data.users = {
        row.id: row for row in db.query(User).filter(User.id.in_(user_ids)).all()
    }
    data.revisions = {
        row.id: row
        for row in db.query(PluginPublicationRevision)
        .filter(PluginPublicationRevision.id.in_(revision_ids))
        .all()
    }
    valid_ids = {
        revision.id
        for request in requests
        if (revision := data.revision(request)) is not None
    }
    if valid_ids:
        checks = (
            db.query(PluginPublicationCheck)
            .filter(PluginPublicationCheck.revision_id.in_(valid_ids))
            .order_by(PluginPublicationCheck.id)
            .all()
        )
        for check in checks:
            data.checks.setdefault(check.revision_id, []).append(check)
    logger.debug(
        "Publication summaries requests=%d plugins=%d users=%d revisions=%d checks=%d elapsed_ms=%.3f",
        len(requests),
        len(data.plugins),
        len(data.users),
        len(data.revisions),
        sum(map(len, data.checks.values())),
        (perf_counter() - started) * 1000,
    )
    return data
