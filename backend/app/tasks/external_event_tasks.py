# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Delayed settle tasks for external event wait-node aggregation."""

import logging

from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.db.session import SessionLocal
from app.models.delivery import ExternalEventBinding
from app.services.external_events.evaluate import (
    ExternalEventEvaluationService,
    external_event_evaluation_service,
)

logger = logging.getLogger(__name__)


def settle_external_event_window_sync(
    *,
    binding_id: str,
    event_type: str,
    generation: int,
    evaluation_service: ExternalEventEvaluationService | None = None,
) -> None:
    """Settle one expired short-window aggregation in its own session."""

    db: Session = SessionLocal()
    try:
        binding = db.get(ExternalEventBinding, binding_id)
        if binding is None:
            logger.warning(
                "External event window settle binding missing binding=%s type=%s",
                binding_id,
                event_type,
            )
            return
        service = evaluation_service or external_event_evaluation_service
        service.settle_window(
            db,
            binding=binding,
            event_type=event_type,
            generation=generation,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "External event window settle failed binding=%s type=%s generation=%s",
            binding_id,
            event_type,
            generation,
        )
    finally:
        db.close()


@celery_app.task(name="app.tasks.external_event_tasks.settle_external_event_window")
def settle_external_event_window(
    *,
    binding_id: str,
    event_type: str,
    generation: int,
) -> None:
    """Settle a short-window aggregation after its window expires."""

    settle_external_event_window_sync(
        binding_id=binding_id,
        event_type=event_type,
        generation=generation,
    )


def dispatch_external_event_continue_sync(
    *,
    binding_id: str,
    instruction: str,
) -> None:
    """Send one continue prompt into the issue's current task conversation."""

    db: Session = SessionLocal()
    try:
        binding = db.get(ExternalEventBinding, binding_id)
        if binding is None:
            logger.warning(
                "External event continue binding missing binding=%s",
                binding_id,
            )
            return
        external_event_evaluation_service.continue_round(
            db,
            binding=binding,
            instruction=instruction,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "External event continue failed binding=%s",
            binding_id,
        )
    finally:
        db.close()


@celery_app.task(name="app.tasks.external_event_tasks.dispatch_external_event_continue")
def dispatch_external_event_continue(
    *,
    binding_id: str,
    instruction: str,
) -> None:
    """Dispatch a wait-node continue round to the owning device."""

    dispatch_external_event_continue_sync(
        binding_id=binding_id,
        instruction=instruction,
    )
