#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Scheduler module, responsible for periodic task execution
"""

from executor_manager.executors.dispatcher import ExecutorDispatcher
from shared.logger import setup_logger

import os
import schedule
import time
from datetime import datetime
from executor_manager.config.config import TASK_FETCH_INTERVAL, TIME_LOG_INTERVAL, SCHEDULER_SLEEP_TIME
from executor_manager.clients.task_api_client import TaskApiClient
from executor_manager.tasks.task_processor import TaskProcessor

# Setup logger
logger = setup_logger(__name__)

class TaskScheduler:
    """Task scheduler class, responsible for periodic task fetching and processing"""
    
    def __init__(self):
        """Initialize scheduler"""
        self.api_client = TaskApiClient()
        self.task_processor = TaskProcessor()
        self.running = False
        self.max_concurrent_tasks = int(os.getenv("MAX_CONCURRENT_TASKS", "5"))
    
    def log_current_time(self):
        """Log current time"""
        current_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        logger.info(f"Current time: {current_time}")
        return True
    
    def fetch_and_process_tasks(self):
        """Fetch and process tasks"""
        
        executor_count_result = ExecutorDispatcher.get_executor("docker").get_executor_count()
        
        if executor_count_result["status"] != "success":
            logger.error(f"Failed to get job count: {executor_count_result.get('error_msg', 'Unknown error')}")
            return False
        
        running_executor_num = executor_count_result.get("running", 0)
        logger.info(f"Current running jobs: {running_executor_num}, max concurrent tasks: {self.max_concurrent_tasks}")
        
        available_slots = max(0, self.max_concurrent_tasks - running_executor_num)
        
        if available_slots <= 0:
            logger.info("No available slots for new tasks, skipping fetch")
            return True
        
        self.api_client.update_fetch_params(limit=available_slots)
        logger.info(f"Fetching up to {available_slots} tasks")
        
        success, result = self.api_client.fetch_tasks()
        logger.info(f"Fetch result: {success}, {result}")
        if success:
            self.task_processor.process_tasks(result["tasks"])
        return success
    
    def fetch_subtasks(self):
        current_tasks = ExecutorDispatcher.get_executor("docker").get_current_task_ids()
        logger.info(f"Current task ids: {current_tasks}")
        if current_tasks.get("task_ids") and len(current_tasks.get("task_ids")) > 0:
            success, result = self.api_client.fetch_subtasks(",".join(current_tasks.get("task_ids")))
            if success:
                self.task_processor.process_tasks(result["tasks"])

    def setup_schedule(self):
        """Setup schedule plan"""
        logger.info(f"Set task fetch interval to {TASK_FETCH_INTERVAL} seconds")
        schedule.every(TIME_LOG_INTERVAL).seconds.do(self.log_current_time)
        schedule.every(TASK_FETCH_INTERVAL).seconds.do(self.fetch_and_process_tasks)
        schedule.every(TASK_FETCH_INTERVAL).seconds.do(self.fetch_subtasks)
    
    def start(self):
        """Start scheduler"""
        logger.info("Task fetching service started")
        self.setup_schedule()
        self.running = True
        
        try:
            while self.running:
                schedule.run_pending()
                time.sleep(SCHEDULER_SLEEP_TIME)
                
        except KeyboardInterrupt:
            logger.info("Service stopped manually")
            self.running = False
        except Exception as e:
            logger.error(f"Service terminated abnormally: {e}")
            self.running = False
            raise
    
    def stop(self):
        """Stop scheduler"""
        logger.info("Stopping service...")
        self.running = False