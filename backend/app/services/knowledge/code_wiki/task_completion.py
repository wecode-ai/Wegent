# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reflect a task's terminal state onto the version it was driving.

A run's outcome is normally reported by the agent itself, which calls the content
write API with a summary. That covers the agent finishing, and the agent failing in a
way it can describe. It does not cover the agent never getting to speak: a container
that disappears, an executor that dies, a task cancelled from elsewhere. The version
then stays RUNNING with nothing to end it, and the staleness sweep only looks when
the *next* run starts — so a wiki reports "generating" for six hours after its
executor has gone, and cannot be retriggered in the meantime.

Subscribing to ``TaskCompletedEvent`` closes that gap without putting anything about
code wikis on the task path itself: the event already exists, is already published
for every execution mode, and already has two subscribers.

**The lookup runs the other way round on purpose.** Almost no task belongs to a code
wiki, so this asks "is there a running version for this task", answered by the index
on ``wiki_generations.task_id``, and returns immediately when there is not.
"""

import logging

from app.core.events import TaskCompletedEvent
from app.db.session import SessionLocal
from app.models.wiki import WikiGeneration, WikiGenerationStatus
from app.services.knowledge.code_wiki.generation import FailureCode
from app.services.knowledge.code_wiki.runner import finish_run

logger = logging.getLogger(__name__)


async def conclude_code_wiki_run(event: TaskCompletedEvent) -> None:
    """End the code wiki version this task was writing, if it was writing one.

    Does nothing for a run the agent already concluded: it filters on RUNNING, so a
    task whose agent reported success finds nothing left to do. That makes this
    idempotent by construction rather than by a check that could race with the
    agent's own report.

    Never raises. Handlers share a loop with the subscription and IM channel ones,
    and a code wiki has no claim to break their delivery.
    """
    db = SessionLocal()
    try:
        generation = (
            db.query(WikiGeneration)
            .filter(
                WikiGeneration.task_id == event.task_id,
                WikiGeneration.status == WikiGenerationStatus.RUNNING,
            )
            .first()
        )
        if generation is None:
            return

        succeeded = event.status == "COMPLETED"
        if succeeded:
            # The agent reports success by writing its pages and a summary. Reaching
            # here with none of that means the task ended without saying so, which is
            # not a published version — it is a run that produced nothing.
            logger.warning(
                "[code_wiki] task %s ended as COMPLETED without the agent concluding "
                "generation %s; recording it as failed",
                event.task_id,
                generation.id,
            )

        finish_run(
            db,
            generation=generation,
            succeeded=False,
            # The task's own error is external text and is shown as it stands. What
            # this server has to say about it is a code, so a reader is not handed an
            # English sentence beside translated UI.
            error_message=event.error or "",
            failure_code=FailureCode.TASK_ENDED_WITHOUT_REPORT,
        )
        db.commit()
        logger.info(
            "[code_wiki] generation %s ended with its task %s (%s)",
            generation.id,
            event.task_id,
            event.status,
        )
    except Exception:  # pragma: no cover - defensive
        db.rollback()
        logger.exception(
            "[code_wiki] could not conclude the run driven by task %s", event.task_id
        )
    finally:
        db.close()
