# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Dict, List, Optional
import httpx
import logging
from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import and_, func

from app.models.task import Task, TaskStatus
from app.models.subtask import Subtask, SubtaskStatus, SubtaskRole
from app.models.bot import Bot
from app.models.model import Model
from app.models.user import User
from app.models.team import Team
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.base import BaseService
from app.core.config import settings
logger = logging.getLogger(__name__)


class ExecutorService(BaseService[Task, SubtaskExecutorUpdate, SubtaskExecutorUpdate]):
    """
    Executor service class
    """

    async def dispatch_tasks(
        self, db: Session, *, status: str = "PENDING", limit: int = 1, task_ids: Optional[List[int]] = None
    ) -> Dict[str, List[Dict]]:
        """
        Task dispatch logic with subtask support
        
        Args:
            status: Subtask status to filter by
            limit: Maximum number of subtasks to return (only used when task_ids is None)
            task_ids: Optional list of task IDs to filter by
        """
        if task_ids:
            # Scenario 1: Specify task ID list, query subtasks for these tasks
            # When multiple task_ids are provided, ignore limit parameter, each task will only take 1 subtask
            subtasks = []
            
            for task_id in task_ids:
                # First query task table to check task status
                task = db.query(Task).filter(Task.id == task_id).first()
                if not task:
                    # Task doesn't exist, skip
                    continue
                
                # Check task status, skip if not PENDING or RUNNING
                if task.status not in [TaskStatus.PENDING, TaskStatus.RUNNING]:
                    continue
                
                # Check if the specified task has RUNNING status subtasks
                running_subtasks = db.query(Subtask).filter(
                    Subtask.task_id == task_id,
                    Subtask.status == SubtaskStatus.RUNNING
                ).count()
                
                if running_subtasks > 0:
                    # If there are running subtasks, skip this task
                    continue
                
                # Get subtasks for this task, only take 1 per task
                task_subtasks = self._get_subtasks_for_task(db, task_id, status, 1)
                if task_subtasks:
                    subtasks.extend(task_subtasks)
        else:
            # Scenario 2: No task_ids, first query tasks, then query first subtask for each task
            subtasks = self._get_first_subtasks_for_tasks(db, status, limit)
        
        if not subtasks:
            return {
                "tasks": []
            }
        
        # Update subtask status to RUNNING (concurrent safe)
        updated_subtasks = self._update_subtasks_to_running(db, subtasks)
        db.commit()

        # Format return data
        result = self._format_subtasks_response(db, updated_subtasks)
        return result

    def _get_subtasks_for_task(self, db: Session, task_id: int, status: str, limit: int) -> List[Subtask]:
        """Get subtasks for specified task, return first one sorted by message_id"""
        return db.query(Subtask).options(
            selectinload(Subtask.user),
        ).filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status == status
        ).order_by(
            Subtask.message_id.asc(),
            Subtask.created_at.asc()
        ).limit(limit).all()

    def _get_first_subtasks_for_tasks(self, db: Session, status: str, limit: int) -> List[Subtask]:
        """Get first subtask for multiple tasks"""
        # Step 1: First query task table to get limit tasks
        tasks = db.query(Task).filter(
            Task.status == status
        ).order_by(
            Task.created_at.desc()  # Sort by creation time descending, prioritize latest tasks
        ).limit(limit).all()
        
        if not tasks:
            return []
            
        task_ids = [task.id for task in tasks]
        # Step 2: Query first subtask with matching status for each task
        subtasks = []
        for tid in task_ids:
            first_subtask = db.query(Subtask).options(
                selectinload(Subtask.user),
            ).filter(
                Subtask.task_id == tid,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status == status
            ).order_by(
                Subtask.message_id.asc(),
                Subtask.created_at.asc()
            ).first()
            
            if first_subtask:
                subtasks.append(first_subtask)
        
        return subtasks

    def _update_subtasks_to_running(self, db: Session, subtasks: List[Subtask]) -> List[Subtask]:
        """Concurrently and safely update subtask status to RUNNING"""
        updated_subtasks = []
        
        for subtask in subtasks:
            # Use optimistic locking mechanism to ensure concurrent safety
            result = db.query(Subtask).filter(
                Subtask.id == subtask.id,
                Subtask.status == SubtaskStatus.PENDING  # Ensure only PENDING status can be updated
            ).update({
                Subtask.status: SubtaskStatus.RUNNING,
                Subtask.updated_at: datetime.utcnow()
            })
            
            if result > 0:  # If update is successful
                # Reload the updated subtask
                updated_subtask = db.query(Subtask).get(subtask.id)
                updated_subtasks.append(updated_subtask)
                # update task status to RUNNING
                self._update_task_to_running(db, updated_subtask.task_id)
        
        return updated_subtasks

    def _update_task_to_running(self, db: Session, task_id: int) -> None:
        """Update task status to RUNNING (only when task is PENDING)"""
        db.query(Task).filter(
            Task.id == task_id,
            Task.status == TaskStatus.PENDING  # Ensure only PENDING status can be updated
        ).update({
            Task.status: TaskStatus.RUNNING,
            Task.updated_at: datetime.utcnow()
        })

    def _format_subtasks_response(self, db: Session, subtasks: List[Subtask]) -> Dict[str, List[Dict]]:
        """Format subtask response data"""
        formatted_subtasks = []
        
        # Pre-fetch adjacent subtask information for each subtask
        for subtask in subtasks:
            # Query all related subtasks under the same task in one go
            related_subtasks = db.query(Subtask).filter(
                Subtask.task_id == subtask.task_id,
            ).order_by(
                Subtask.message_id.asc(),
                Subtask.created_at.asc()
            ).all()
            
            next_subtask = None
            previous_subtask_results = ""
           
            user_prompt = ""
            for i, related in enumerate(related_subtasks):
                if related.role == SubtaskRole.USER:
                    user_prompt = related.prompt
                    previous_subtask_results = ""
                    continue
                if related.message_id < subtask.message_id:
                    previous_subtask_results = related.result
                if related.message_id == subtask.message_id:
                    if i < len(related_subtasks) - 1:
                        next_subtask = related_subtasks[i+1]
                    break
               
            
            # Build aggregated prompt
            aggregated_prompt = ""
            # User input prompt
            if user_prompt:
                aggregated_prompt = user_prompt
            # Previous subtask result
            team = db.query(Team).filter(Team.id == subtask.team_id).first()
            if previous_subtask_results != "" :
                aggregated_prompt += f"\nPrevious execution result: {previous_subtask_results}"

            # Build user git information
            task = db.query(Task).filter(Task.id == subtask.task_id).first()
            git_info = next((info for info in subtask.user.git_info if info.get("git_domain") == task.git_domain), None) if subtask.user.git_info else None

            # Build bot information
            bots = []
            team = db.query(Team).filter(Team.id == subtask.team_id).first()
            team_bots = team.bots if team and team.bots else []
            
            pipeline_index = 0
            if team.workflow.get('mode') == "pipeline":
                for i, related in enumerate(related_subtasks):
                    if related.role == SubtaskRole.USER:
                        continue
                    if related.id == subtask.id:
                        break
                    pipeline_index = pipeline_index + 1
                

            for index, bot_id in enumerate(subtask.bot_ids):
                bot = db.query(Bot).filter(Bot.id == bot_id).first()
                team_bot_info = team_bots[index] if index < len(team_bots) else {}
                
                bot_prompt = bot.system_prompt
                if team.workflow.get('mode') == "pipeline":
                     team_bot_info = team_bots[pipeline_index] if pipeline_index < len(team_bots) else {}

                if team_bot_info.get('bot_prompt'):
                    bot_prompt += f"\n{team_bot_info['bot_prompt']}"
                
                # Resolve agent_config:
                # If bot.agent_config has top-level {"private_model": "<model_name>"},
                # fetch Model by name and use its config instead.
                agent_config_data = bot.agent_config
                try:
                    if isinstance(bot.agent_config, dict):
                        # Without changing the original logic, frontend and backend agreed to use private_model
                        private_model_name = bot.agent_config.get("private_model")
                        if isinstance(private_model_name, str) and private_model_name.strip():
                            model_row = db.query(Model).filter(Model.name == private_model_name.strip()).first()
                            if model_row and isinstance(model_row.config, dict):
                                agent_config_data = model_row.config
                except Exception:
                    # On any error, fallback to original agent_config
                    agent_config_data = bot.agent_config

                bots.append({
                    "id": bot.id,
                    "name": bot.name,
                    "agent_name": bot.agent_name,
                    "agent_config": agent_config_data,
                    "system_prompt": bot_prompt,
                    "mcp_servers": bot.mcp_servers,
                    "role": team_bot_info.get('role', '')
                })

            formatted_subtasks.append({
                "subtask_id": subtask.id,
                "subtask_next_id": next_subtask.id if next_subtask else None,
                "task_id": subtask.task_id,
                "executor_name": subtask.executor_name,
                "executor_namespace": subtask.executor_namespace,
                "subtask_title": subtask.title,
                "task_title": task.title,
                "user": {
                    "id": subtask.user.id,
                    "name": subtask.user.user_name,
                    "git_domain": git_info.get("git_domain") if git_info else None,
                    "git_token": git_info.get("git_token") if git_info else None,
                    "git_id": git_info.get("git_id") if git_info else None,
                    "git_login": git_info.get("git_login") if git_info else None,
                    "git_email": git_info.get("git_email") if git_info else None
                },
                "bot": bots,
                "team_id": subtask.team_id,
                "mode": team.workflow.get('mode'),
                "git_domain": task.git_domain,
                "git_repo": task.git_repo,
                "git_repo_id": task.git_repo_id,
                "branch_name": task.branch_name,
                "git_url": task.git_url,
                "prompt": aggregated_prompt,
                "status": subtask.status,
                "progress": subtask.progress,
                "created_at": subtask.created_at,
                "updated_at": subtask.updated_at
            })
        # Log before returning the formatted response
        subtask_ids = [item.get("subtask_id") for item in formatted_subtasks]
        logger.info(f"dispatch subtasks response count={len(formatted_subtasks)} ids={subtask_ids}")
        return {
            "tasks": formatted_subtasks
        }
    async def update_subtask(
        self, db: Session, *, subtask_update: SubtaskExecutorUpdate
    ) -> Dict:
        """
        Update subtask and automatically update associated task status
        """
        # Get subtask
        subtask = db.query(Subtask).get(subtask_update.subtask_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")
        
        # Update subtask title (if provided)
        if subtask_update.subtask_title:
            subtask.title = subtask_update.subtask_title
        
        # Update task title (if provided)
        if subtask_update.task_title:
            task = db.query(Task).get(subtask.task_id)
            if task:
                task.title = subtask_update.task_title
                db.add(task)
        
        # Update other subtask fields
        update_data = subtask_update.model_dump(
            exclude={"subtask_title", "task_title"},
            exclude_unset=True
        )
        for field, value in update_data.items():
            setattr(subtask, field, value)
        
        # Set completion time
        if subtask_update.status == SubtaskStatus.COMPLETED and not subtask.completed_at:
            subtask.completed_at = datetime.utcnow()
        
        db.add(subtask)
        db.flush()  # Ensure subtask update is complete
        
        # Update associated task status
        self._update_task_status_based_on_subtasks(db, subtask.task_id)
        
        db.commit()
        
        return {
            "subtask_id": subtask.id,
            "task_id": subtask.task_id,
            "status": subtask.status,
            "progress": subtask.progress,
            "message": "Subtask updated successfully"
        }

    def _update_task_status_based_on_subtasks(self, db: Session, task_id: int) -> None:
        """Update task status based on subtask status"""
        # Get all subtasks for the task
        task = db.query(Task).get(task_id)
        if not task:
            return
        
        subtasks = db.query(Subtask).filter(Subtask.task_id == task_id, Subtask.role == SubtaskRole.ASSISTANT).order_by(Subtask.message_id.asc()).all()
        if not subtasks:
            return
        
        total_subtasks = len(subtasks)
        completed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.COMPLETED])
        failed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.FAILED])
        
        # Calculate task progress
        task.progress = int((completed_subtasks / total_subtasks) * 100)
        
        # Check if there are failed subtasks
        if failed_subtasks > 0:
            task.status = TaskStatus.FAILED
            # Get error message from last failed subtask
            failed_subtask = next((s for s in reversed(subtasks) if s.status == SubtaskStatus.FAILED), None)
            if failed_subtask and failed_subtask.error_message:
                task.error_message = failed_subtask.error_message
            if failed_subtask and failed_subtask.result:
                task.result = failed_subtask.result
        # Check if all subtasks are completed
        elif completed_subtasks == total_subtasks:
            # Get last completed subtask
            last_subtask = subtasks[-1] if subtasks else None
            if last_subtask:
                task.status = last_subtask.status
                task.result = last_subtask.result
            task.progress = 100
            task.completed_at = datetime.utcnow()
        else:
            # Update to running status
            task.status = TaskStatus.RUNNING
        
        db.add(task)

    async def delete_executor_task(self, executor_name: str, executor_namespace: str) -> Dict:
        """
        Delete task from executor

        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name or not executor_namespace:
            raise HTTPException(status_code=400, detail="executor_name and executor_namespace are required")
        try:
            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            # Log before sending delete request
            logger.info(f"executor.delete request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}")

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_TASK_URL,
                    json=payload,
                    headers={"Content-Type": "application/json"},
                    timeout=30.0
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Failed to delete executor task: {e.response.text}"
            )
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error deleting executor task: {str(e)}"
            )


executor_service = ExecutorService(Task)