# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Route normalized external events to their waiting workflow nodes."""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.delivery import ProjectIncomingHook
from app.services.external_events.adapters import (
    NormalizedExternalEvent,
    external_event_dict,
)
from app.services.external_events.binding import (
    ExternalEventBindingService,
    external_event_binding_service,
)
from app.services.external_events.buffer import external_event_buffer
from app.services.external_events.evaluate import (
    ExternalEventEvaluationService,
    external_event_evaluation_service,
)

logger = logging.getLogger(__name__)


class ExternalEventService:
    def __init__(
        self,
        binding_service: ExternalEventBindingService | None = None,
        evaluation_service: ExternalEventEvaluationService | None = None,
    ) -> None:
        self.binding_service = binding_service or external_event_binding_service
        self.evaluation_service = (
            evaluation_service or external_event_evaluation_service
        )

    def route(
        self,
        db: Session,
        *,
        hook: ProjectIncomingHook,
        event: NormalizedExternalEvent,
    ) -> str:
        """Route one event and return the audit status for its log row.

        Events never create collection-inbox issues. A matched binding is
        evaluated immediately; an unmatched event waits in the Redis buffer
        until a binding registers (compensation).
        """

        bindings = self.binding_service.route(
            db, provider=event.provider, opaque_ref=event.opaque_ref
        )
        if not bindings:
            external_event_buffer.append(
                event.provider,
                event.opaque_ref,
                event.event_type,
                external_event_dict(event),
            )
            logger.info(
                "[ExternalEvent] Buffered unmatched event hook=%s provider=%s "
                "ref=%s type=%s",
                hook.id,
                event.provider,
                event.opaque_ref,
                event.event_type,
            )
            return "buffered"
        evaluated = 0
        for binding in bindings:
            try:
                self.evaluation_service.evaluate_event(db, binding=binding, event=event)
                evaluated += 1
            except Exception:
                logger.exception(
                    "[ExternalEvent] Evaluation failed binding=%s provider=%s ref=%s",
                    binding.id,
                    event.provider,
                    event.opaque_ref,
                )
        return "created" if evaluated else "failed"


external_event_service = ExternalEventService()
