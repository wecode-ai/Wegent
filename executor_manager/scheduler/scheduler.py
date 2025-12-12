#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Scheduler module, responsible for periodic task execution
"""

import os
import time

import pytz
from apscheduler.executors.pool import ThreadPoolExecutor
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from shared.logger import setup_logger
from shared.telemetry.decorators import (add_span_event, set_span_attribute,
                                         trace_sync)

from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.config.config import (EXECUTOR_DISPATCHER_MODE,
                                            OFFLINE_TASK_EVENING_HOURS,
                                            OFFLINE_TASK_MORNING_HOURS,
                                            SCHEDULER_SLEEP_TIME,
                                            TASK_FETCH_INTERVAL)
from executor_manager.executors.dispatcher import ExecutorDispatcher
from executor_manager.tasks.task_processor import TaskProcessor

logger = setup_logger(__name__)


class TaskScheduler:
    """Task scheduler class, responsible for periodic task fetching and processing"""

    def __init__(self):
        """Initialize scheduler"""
        self.api_client = TaskApiClient()
        self.task_processor = TaskProcessor()
        self.running = False
        self.max_concurrent_tasks = int(os.getenv("MAX_CONCURRENT_TASKS", "30"))
        self.max_offline_concurrent_tasks = int(os.getenv("MAX_OFFLINE_CONCURRENT_TASKS", "10"))

        # Configure APScheduler
        jobstores = {"default": MemoryJobStore()}
        executors = {"default": ThreadPoolExecutor(20)}
        job_defaults = {
            "coalesce": False,
            "max_instances": 3,
            "misfire_grace_time": 60,
        }

        timezone_str = os.getenv("TZ", "Asia/Shanghai")
        try:
            timezone = pytz.timezone(timezone_str)
        except pytz.UnknownTimeZoneError:
            logger.warning(f"Unknown timezone: {timezone_str}, falling back to Asia/Shanghai")
            timezone = pytz.timezone("Asia/Shanghai")

        self.scheduler = BackgroundScheduler(
            jobstores=jobstores,
            executors=executors,
            job_defaults=job_defaults,
            timezone=timezone,
        )

    @trace_sync(
        span_name="fetch_online_tasks",
        tracer_name="executor_manager.scheduler",
        attributes={"task.type": "online", "scheduler.job": "fetch_online_tasks"},
    )
    def fetch_online_and_process_tasks(self):
        """Fetch and process online tasks"""
        executor_count_result = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE).get_executor_count(
            "aigc.weibo.com/task-type=online"
        )

        if executor_count_result["status"] != "success":
            error_msg = executor_count_result.get("error_msg", "Unknown error")
            logger.error(f"Failed to get pod count: {error_msg}")
            set_span_attribute("error", True)
            set_span_attribute("error.message", error_msg)
            return False

        running_executor_num = executor_count_result.get("running", 0)
        logger.info(f"Online tasks status: {running_executor_num} running pods, {self.max_concurrent_tasks} max concurrent tasks")

        set_span_attribute("executor.running_count", running_executor_num)
        set_span_attribute("executor.max_concurrent", self.max_concurrent_tasks)

        available_slots = min(10, self.max_concurrent_tasks - running_executor_num)

        if available_slots <= 0:
            logger.info("No available slots for new tasks, skipping fetch")
            set_span_attribute("task.skipped", True)
            set_span_attribute("task.skip_reason", "no_available_slots")
            return True

        self.api_client.update_fetch_params(limit=available_slots)
        logger.info(f"Fetching up to {available_slots} online tasks")
        set_span_attribute("task.fetch_limit", available_slots)

        success, result = self.api_client.fetch_tasks()
        logger.info(f"Online tasks fetch result: success={success}, data={result}")

        if success:
            tasks = result.get("tasks", [])
            set_span_attribute("task.fetched_count", len(tasks))
            self.task_processor.process_tasks(tasks)
        else:
            set_span_attribute("error", True)
            set_span_attribute("task.fetch_success", False)

        return success

    @trace_sync(
        span_name="fetch_offline_tasks",
        tracer_name="executor_manager.scheduler",
        attributes={"task.type": "offline", "scheduler.job": "fetch_offline_tasks"},
    )
    def fetch_offline_and_process_tasks(self):
        """Fetch and process offline tasks"""
        executor_count_result = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE).get_executor_count(
            "aigc.weibo.com/task-type=offline"
        )

        if executor_count_result["status"] != "success":
            error_msg = executor_count_result.get("error_msg", "Unknown error")
            logger.error(f"Failed to get pod count: {error_msg}")
            set_span_attribute("error", True)
            set_span_attribute("error.message", error_msg)
            return False

        running_executor_num = executor_count_result.get("running", 0)
        logger.info(f"Offline tasks status: {running_executor_num} running pods, {self.max_offline_concurrent_tasks} max concurrent tasks")

        set_span_attribute("executor.running_count", running_executor_num)
        set_span_attribute("executor.max_concurrent", self.max_offline_concurrent_tasks)

        available_slots = min(10, self.max_offline_concurrent_tasks - running_executor_num)

        if available_slots <= 0:
            logger.info("No available slots for new offline tasks, skipping fetch")
            set_span_attribute("task.skipped", True)
            set_span_attribute("task.skip_reason", "no_available_slots")
            return True

        self.api_client.update_offline_fetch_params(limit=available_slots)
        logger.info(f"Fetching up to {available_slots} offline tasks")
        set_span_attribute("task.fetch_limit", available_slots)

        success, result = self.api_client.fetch_offline_tasks()
        logger.info(f"Offline tasks fetch result: success={success}, data={result}")

        if success:
            tasks = result.get("tasks", [])
            set_span_attribute("task.fetched_count", len(tasks))
            self.task_processor.process_tasks(tasks)
        else:
            set_span_attribute("error", True)
            set_span_attribute("task.fetch_success", False)

        return success

    @trace_sync(
        span_name="fetch_subtasks",
        tracer_name="executor_manager.scheduler",
        attributes={"task.type": "subtask", "scheduler.job": "fetch_subtasks"},
    )
    def fetch_subtasks(self):
        """Fetch subtasks for pipeline tasks"""
        current_tasks = ExecutorDispatcher.get_executor(EXECUTOR_DISPATCHER_MODE).get_current_task_ids(
            "aigc.weibo.com/team-mode=pipeline"
        )
        logger.info(f"Current task ids: {current_tasks}")

        task_ids = current_tasks.get("task_ids", [])
        set_span_attribute("task.current_pipeline_count", len(task_ids) if task_ids else 0)

        if task_ids and len(task_ids) > 0:
            batch_size = 10

            for i in range(0, len(task_ids), batch_size):
                batch_task_ids = task_ids[i : i + batch_size]
                batch_num = i // batch_size + 1
                logger.info(f"Fetching subtasks batch {batch_num}, task_ids: {batch_task_ids}")

                success, result = self.api_client.fetch_subtasks(",".join(batch_task_ids))
                if success:
                    tasks = result.get("tasks", [])
                    add_span_event(
                        "subtask_batch_fetched",
                        {
                            "batch.number": batch_num,
                            "batch.task_ids": ",".join(batch_task_ids),
                            "batch.fetched_count": len(tasks),
                        },
                    )
                    self.task_processor.process_tasks(tasks)
                else:
                    logger.error(f"Failed to fetch subtasks batch {batch_num}: {result}")
                    add_span_event(
                        "subtask_batch_failed",
                        {
                            "batch.number": batch_num,
                            "batch.task_ids": ",".join(batch_task_ids),
                            "error": str(result),
                        },
                    )

    def setup_schedule(self):
        """Setup schedule plan"""
        logger.info(f"Set task fetch interval to {TASK_FETCH_INTERVAL} seconds")
        
        self.scheduler.add_job(
            self.fetch_online_and_process_tasks,
            'interval',
            seconds=TASK_FETCH_INTERVAL,
            id='fetch_online_tasks',
            name='fetch_online_tasks'
        )
        
        # Evening time range, execute every TASK_FETCH_INTERVAL seconds
        self.scheduler.add_job(
            self.fetch_offline_and_process_tasks,
            trigger=CronTrigger(hour=OFFLINE_TASK_EVENING_HOURS, second=f'*/{TASK_FETCH_INTERVAL}'),
            id='fetch_offline_tasks_night',
            name='fetch_offline_tasks_night'
        )

        # Early morning time range, execute every TASK_FETCH_INTERVAL seconds
        self.scheduler.add_job(
            self.fetch_offline_and_process_tasks,
            trigger=CronTrigger(hour=OFFLINE_TASK_MORNING_HOURS, second=f'*/{TASK_FETCH_INTERVAL}'),
            id='fetch_offline_tasks_morning',
            name='fetch_offline_tasks_morning'
        )
        
        self.scheduler.add_job(
            self.fetch_subtasks,
            'interval',
            seconds=TASK_FETCH_INTERVAL,
            id='fetch_subtasks',
            name='fetch_subtasks'
        )
    
    def start(self):
        """Start scheduler"""
        logger.info("Task fetching service started")
        self.setup_schedule()
        self.running = True
        
        try:
            self.scheduler.start()
            
            while self.running:
                time.sleep(SCHEDULER_SLEEP_TIME)
                
        except KeyboardInterrupt:
            logger.info("Service stopped manually")
            self.stop()
        except Exception as e:
            logger.error(f"Service terminated abnormally: {e}")
            self.stop()
            raise
    
    def stop(self):
        """Stop scheduler"""
        logger.info("Stopping service...")
        self.running = False
        
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)
            logger.info("Scheduler shutdown complete")