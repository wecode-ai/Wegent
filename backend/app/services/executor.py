# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Dict, List, Optional
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import and_, func

from app.models.task import Task, TaskStatus
from app.models.subtask import Subtask, SubtaskStatus
from app.models.bot import Bot
from app.models.user import User
from app.schemas.subtask import SubtaskExecutorUpdate
from app.services.base import BaseService
from app.core.config import settings


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

        # Commit transaction to ensure status updates take effect
        db.commit()

        # Format return data
        return self._format_subtasks_response(db, updated_subtasks)

    def _get_subtasks_for_task(self, db: Session, task_id: int, status: str, limit: int) -> List[Subtask]:
        """Get subtasks for specified task, return first one sorted by sort_order"""
        return db.query(Subtask).options(
            selectinload(Subtask.task),
            selectinload(Subtask.user),
            selectinload(Subtask.bot),
            selectinload(Subtask.team)
        ).filter(
            Subtask.task_id == task_id,
            Subtask.status == status
        ).order_by(
            Subtask.sort_order.asc(),
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
                selectinload(Subtask.task),
                selectinload(Subtask.user),
                selectinload(Subtask.bot),
                selectinload(Subtask.team)
            ).filter(
                Subtask.task_id == tid,
                Subtask.status == status
            ).order_by(
                Subtask.sort_order.asc(),
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
                
                # If it's the first subtask, update task status to RUNNING
                if updated_subtask.sort_order == 0:
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
        for subtask in subtasks:
            # Get previous subtask results
            previous_results = self._get_previous_subtask_results(db, subtask)
            
            # Build aggregated prompt
            aggregated_prompt = ""
            # 1. If it's the first subtask, need to append task prompt
            if subtask.sort_order == 0:
                aggregated_prompt = subtask.task.prompt

            # 2. If previous subtasks have results, append "Previous execution result: last item in previous_results"
            if previous_results:
                aggregated_prompt += f"Previous execution result: {previous_results[-1]}"

            # 3. Finally append subtask prompt with newline separator
            aggregated_prompt += f"\n{subtask.prompt}"

            # Build user git information
            # Iterate through subtask.user.git_info to find item where git_domain equals subtask.task.git_domain
            git_info = next((info for info in subtask.user.git_info if info.get("git_domain") == subtask.task.git_domain), None) if subtask.user.git_info else None
            
            # Get next subtask ID
            next_subtask = db.query(Subtask).filter(
                Subtask.task_id == subtask.task_id,
                Subtask.sort_order > subtask.sort_order
            ).order_by(
                Subtask.sort_order.asc(),
                Subtask.created_at.asc()
            ).first()
            
            next_subtask_id = next_subtask.id if next_subtask else None

            # get previous subtask ID
            previous_subtask = db.query(Subtask).filter(
                Subtask.task_id == subtask.task_id,
                Subtask.sort_order < subtask.sort_order
            ).order_by(
                Subtask.sort_order.desc(),
                Subtask.created_at.desc()
            ).first()

            executor_name = ""
            executor_namespace = ""
            if previous_subtask:
                executor_name = previous_subtask.executor_name
                executor_namespace = previous_subtask.executor_namespace

            formatted_subtasks.append({
                "subtask_id": subtask.id,
                "subtask_next_id": next_subtask_id,
                "task_id": subtask.task_id,
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
                "subtask_title": subtask.title,
                "task_title": subtask.task.title,
                "user": {
                    "id": subtask.user.id,
                    "name": subtask.user.user_name,
                    "git_domain": git_info.get("git_domain") if git_info else None,
                    "git_token": git_info.get("git_token") if git_info else None,
                    "git_id": git_info.get("git_id") if git_info else None,
                    "git_login": git_info.get("git_login") if git_info else None
                },
                "bot": {
                    "id": subtask.bot.id,
                    "name": subtask.bot.name,
                    "agent_name": subtask.bot.agent_name,
                    "agent_config": subtask.bot.agent_config,
                    "system_prompt": subtask.bot.system_prompt,
                    "mcp_servers": subtask.bot.mcp_servers
                },
                "team_id": subtask.team_id,
                "git_domain": subtask.task.git_domain,
                "git_repo": subtask.task.git_repo,
                "git_repo_id": subtask.task.git_repo_id,
                "branch_name": subtask.task.branch_name,
                "git_url": subtask.task.git_url,
                "prompt": aggregated_prompt,
                "status": subtask.status,
                "progress": subtask.progress,
                "created_at": subtask.created_at,
                "updated_at": subtask.updated_at
            })
        
        return {
            "tasks": formatted_subtasks
        }

    def _get_previous_subtask_results(self, db: Session, current_subtask: Subtask) -> List[str]:
        """Get previous subtask results"""
        previous_subtasks = db.query(Subtask).filter(
            Subtask.task_id == current_subtask.task_id,
            Subtask.sort_order < current_subtask.sort_order,
            Subtask.status == SubtaskStatus.COMPLETED,
            Subtask.result.isnot(None)
        ).order_by(Subtask.sort_order.asc()).all()
        
        results = []
        for subtask in previous_subtasks:
            if subtask.result and isinstance(subtask.result, dict):
                result_text = subtask.result
                if result_text:
                    results.append(f"{result_text}")
        
        return results

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
        
        subtasks = db.query(Subtask).filter(Subtask.task_id == task_id).order_by(Subtask.sort_order.asc()).all()
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

    async def delete_executor_task(self, executor_name: str) -> Dict:
        """
        Delete task from executor
        """
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    settings.EXECUTOR_DELETE_TASK_URL,
                    json={"executor_name": executor_name},
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