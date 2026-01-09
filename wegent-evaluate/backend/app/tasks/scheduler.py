"""
APScheduler configuration.
"""
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.core.config import settings

scheduler = AsyncIOScheduler()


def setup_scheduler():
    """Set up scheduled tasks."""
    from app.tasks.evaluation_task import run_daily_evaluation
    from app.tasks.sync_task import run_daily_sync

    # Parse cron expressions
    sync_trigger = CronTrigger.from_crontab(settings.SYNC_CRON_EXPRESSION)
    evaluation_trigger = CronTrigger.from_crontab(settings.EVALUATION_CRON_EXPRESSION)

    # Add jobs
    scheduler.add_job(
        run_daily_sync,
        trigger=sync_trigger,
        id="daily_sync",
        name="Daily Data Sync",
        replace_existing=True,
    )

    scheduler.add_job(
        run_daily_evaluation,
        trigger=evaluation_trigger,
        id="daily_evaluation",
        name="Daily Evaluation",
        replace_existing=True,
    )


def start_scheduler():
    """Start the scheduler."""
    setup_scheduler()
    scheduler.start()


def shutdown_scheduler():
    """Shutdown the scheduler."""
    scheduler.shutdown()
