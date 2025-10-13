# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Dict, List, Optional
import httpx
import logging
from fastapi import HTTPException
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import and_, func, text

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus, SubtaskRole
from app.schemas.subtask import SubtaskExecutorUpdate
from app.schemas.kind import Task, Workspace, Team, Bot, Ghost, Shell, Model
from app.services.base import BaseService
from app.core.config import settings

logger = logging.getLogger(__name__)


class ExecutorKindsService(BaseService[Kind, SubtaskExecutorUpdate, SubtaskExecutorUpdate]):
    """
    Executor service class using kinds table for Task operations
    """

    async def dispatch_tasks(
        self, db: Session, *, status: str = "PENDING", limit: int = 1, task_ids: Optional[List[int]] = None
    ) -> Dict[str, List[Dict]]:
        """
        Task dispatch logic with subtask support using kinds table
        
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
                # First query kinds table to check task status
                task = db.query(Kind).filter(
                    Kind.id == task_id,
                    Kind.kind == "Task",
                    Kind.is_active == True
                ).first()
                if not task:
                    # Task doesn't exist, skip
                    continue
                # Check task status from JSON, skip if not PENDING or RUNNING
                task_crd = Task.model_validate(task.json)
                task_status = task_crd.status.status if task_crd.status else "PENDING"
                if task_status not in ["PENDING", "RUNNING"]:
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
        """Get first subtask for multiple tasks using kinds table"""
        # Step 1: First query kinds table to get limit tasks
        tasks = db.query(Kind).filter(
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') = :status")
        ).params(status=status).order_by(
            Kind.created_at.desc()  # Sort by creation time descending, prioritize latest tasks
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
        """Update task status to RUNNING (only when task is PENDING) using kinds table"""
        task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).first()
        
        if task:
            if task:
                task_crd = Task.model_validate(task.json)
                current_status = task_crd.status.status if task_crd.status else "PENDING"
                
                # Ensure only PENDING status can be updated
                if current_status == "PENDING":
                    if task_crd.status:
                        task_crd.status.status = "RUNNING"
                        task_crd.status.updatedAt = datetime.utcnow()
                    task.json = task_crd.model_dump(mode='json')
                    task.updated_at = datetime.utcnow()
                    from sqlalchemy.orm.attributes import flag_modified
                    flag_modified(task, "json")
    def _format_subtasks_response(self, db: Session, subtasks: List[Subtask]) -> Dict[str, List[Dict]]:
        """Format subtask response data using kinds table for task information"""
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
            if previous_subtask_results != "":
                aggregated_prompt += f"\nPrevious execution result: {previous_subtask_results}"
            # Get task information from kinds table
            task = db.query(Kind).filter(
                Kind.id == subtask.task_id,
                Kind.kind == "Task",
                Kind.is_active == True
            ).first()
            
            if not task:
                continue
                
            task_crd = Task.model_validate(task.json)
            
            # Get workspace information
            workspace = db.query(Kind).filter(
                Kind.user_id == task.user_id,
                Kind.kind == "Workspace",
                Kind.name == task_crd.spec.workspaceRef.name,
                Kind.namespace == task_crd.spec.workspaceRef.namespace,
                Kind.is_active == True
            ).first()
            
            git_url = ""
            git_repo = ""
            git_repo_id = 0
            git_domain = ""
            branch_name = ""
            
            if workspace and workspace.json:
                workspace_crd = Workspace.model_validate(workspace.json)
                git_url = workspace_crd.spec.repository.gitUrl
                git_repo = workspace_crd.spec.repository.gitRepo
                git_repo_id = workspace_crd.spec.repository.gitRepoId or 0
                git_domain = workspace_crd.spec.repository.gitDomain
                branch_name = workspace_crd.spec.repository.branchName

            # Build user git information
            git_info = next((info for info in subtask.user.git_info if info.get("git_domain") == git_domain), None) if subtask.user.git_info else None

            # Get team information from kinds table
            team = db.query(Kind).filter(
                Kind.user_id == task.user_id,
                Kind.kind == "Team",
                Kind.name == task_crd.spec.teamRef.name,
                Kind.namespace == task_crd.spec.teamRef.namespace,
                Kind.is_active == True
            ).first()
            
            if not team:
                continue
                
            team_crd = Team.model_validate(team.json)
            team_members = team_crd.spec.members
            collaboration_model = team_crd.spec.collaborationModel

            # Build bot information
            bots = []
            
            pipeline_index = 0
            if collaboration_model == "pipeline":
                for i, related in enumerate(related_subtasks):
                    if related.role == SubtaskRole.USER:
                        continue
                    if related.id == subtask.id:
                        break
                    pipeline_index = pipeline_index + 1

            for index, bot_id in enumerate(subtask.bot_ids):
                # Get bot from kinds table
                for index, bot_id in enumerate(subtask.bot_ids):
                    # Get bot from kinds table
                    bot = db.query(Kind).filter(
                        Kind.id == bot_id,
                        Kind.user_id == task.user_id,
                        Kind.kind == "Bot",
                        Kind.is_active == True
                    ).first()
                    
                    if not bot:
                        continue
                        
                    bot_crd = Bot.model_validate(bot.json)
                    
                    # Get ghost for system prompt and mcp servers
                    ghost = db.query(Kind).filter(
                        Kind.user_id == task.user_id,
                        Kind.kind == "Ghost",
                        Kind.name == bot_crd.spec.ghostRef.name,
                        Kind.namespace == bot_crd.spec.ghostRef.namespace,
                        Kind.is_active == True
                    ).first()
                    
                    # Get shell for agent name
                    shell = db.query(Kind).filter(
                        Kind.user_id == task.user_id,
                        Kind.kind == "Shell",
                        Kind.name == bot_crd.spec.shellRef.name,
                        Kind.namespace == bot_crd.spec.shellRef.namespace,
                        Kind.is_active == True
                    ).first()
                    
                    # Get model for agent config
                    model = db.query(Kind).filter(
                        Kind.user_id == task.user_id,
                        Kind.kind == "Model",
                        Kind.name == bot_crd.spec.modelRef.name,
                        Kind.namespace == bot_crd.spec.modelRef.namespace,
                        Kind.is_active == True
                    ).first()
                    
                    # Extract data from components
                    system_prompt = ""
                    mcp_servers = {}
                    agent_name = ""
                    agent_config = {}
                    
                    if ghost and ghost.json:
                        ghost_crd = Ghost.model_validate(ghost.json)
                        system_prompt = ghost_crd.spec.systemPrompt
                        mcp_servers = ghost_crd.spec.mcpServers or {}
                    
                    if shell and shell.json:
                        shell_crd = Shell.model_validate(shell.json)
                        agent_name = shell_crd.spec.runtime
                    
                    if model and model.json:
                        model_crd = Model.model_validate(model.json)
                        agent_config = model_crd.spec.modelConfig
                    
                    # Get team member info for bot prompt and role
                    team_member_info = None
                    if collaboration_model == "pipeline":
                        if pipeline_index < len(team_members):
                            team_member_info = team_members[pipeline_index]
                    else:
                        if index < len(team_members):
                            team_member_info = team_members[index]
                    
                    bot_prompt = system_prompt
                    if team_member_info and team_member_info.prompt:
                        bot_prompt += f"\n{team_member_info.prompt}"
                agent_config_data = agent_config
                try:
                    if isinstance(agent_config, dict):
                        private_model_name = agent_config.get("private_model")
                        if isinstance(private_model_name, str) and private_model_name.strip():
                            # Query public_models table for private model
                            from app.models.public_model import PublicModel
                            model_row = db.query(PublicModel).filter(PublicModel.name == private_model_name.strip()).first()
                            if model_row and model_row.json:
                                # Extract modelConfig from json.spec.modelConfig
                                model_config = model_row.json.get("spec", {}).get("modelConfig", {})
                                if isinstance(model_config, dict):
                                    agent_config_data = model_config
                except Exception:
                    # On any error, fallback to original agent_config
                    agent_config_data = agent_config

                bots.append({
                    "id": bot.id,
                    "name": bot.name,
                    "agent_name": agent_name,
                    "agent_config": agent_config_data,
                    "system_prompt": bot_prompt,
                    "mcp_servers": mcp_servers,
                    "role": team_member_info.role if team_member_info else ''
                })

            formatted_subtasks.append({
                "subtask_id": subtask.id,
                "subtask_next_id": next_subtask.id if next_subtask else None,
                "task_id": subtask.task_id,
                "executor_name": subtask.executor_name,
                "executor_namespace": subtask.executor_namespace,
                "subtask_title": subtask.title,
                "task_title": task_crd.spec.title,
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
                "team_id": team.id,
                "mode": collaboration_model,
                "git_domain": git_domain,
                "git_repo": git_repo,
                "git_repo_id": git_repo_id,
                "branch_name": branch_name,
                "git_url": git_url,
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
        Update subtask and automatically update associated task status using kinds table
        """
        # Get subtask
        subtask = db.query(Subtask).get(subtask_update.subtask_id)
        if not subtask:
            raise HTTPException(status_code=404, detail="Subtask not found")
        
        # Update subtask title (if provided)
        if subtask_update.subtask_title:
            subtask.title = subtask_update.subtask_title
        
        # Update task title (if provided) using kinds table
        if subtask_update.task_title:
            task = db.query(Kind).filter(
                Kind.id == subtask.task_id,
                Kind.kind == "Task",
                Kind.is_active == True
            ).first()
            if task:
                task_crd = Task.model_validate(task.json)
                task_crd.spec.title = subtask_update.task_title
                task.json = task_crd.model_dump(mode='json')
                task.updated_at = datetime.utcnow()
                from sqlalchemy.orm.attributes import flag_modified
                flag_modified(task, "json")
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
        """Update task status based on subtask status using kinds table"""
        # Get task from kinds table
        task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).first()
        if not task:
            return
        
        subtasks = db.query(Subtask).filter(
            Subtask.task_id == task_id, 
            Subtask.role == SubtaskRole.ASSISTANT
        ).order_by(Subtask.message_id.asc()).all()
        if not subtasks:
            return
        
        total_subtasks = len(subtasks)
        completed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.COMPLETED])
        failed_subtasks = len([s for s in subtasks if s.status == SubtaskStatus.FAILED])
        
        task_json = task.json
        task_crd = Task.model_validate(task.json)
        
        # Calculate task progress
        progress = int((completed_subtasks / total_subtasks) * 100)
        if task_crd.status:
            task_crd.status.progress = progress
        
        # Check if there are failed subtasks
        if failed_subtasks > 0:
            if task_crd.status:
                task_crd.status.status = "FAILED"
                # Get error message from last failed subtask
                failed_subtask = next((s for s in reversed(subtasks) if s.status == SubtaskStatus.FAILED), None)
                if failed_subtask and failed_subtask.error_message:
                    task_crd.status.errorMessage = failed_subtask.error_message
                if failed_subtask and failed_subtask.result:
                    task_crd.status.result = failed_subtask.result
        # Check if all subtasks are completed
        elif completed_subtasks == total_subtasks:
            # Get last completed subtask
            last_subtask = subtasks[-1] if subtasks else None
            if last_subtask and task_crd.status:
                task_crd.status.status = last_subtask.status.value
                task_crd.status.result = last_subtask.result
                task_crd.status.errorMessage = last_subtask.error_message
                task_crd.status.progress = 100
                task_crd.status.completedAt = datetime.utcnow()
        else:
            # Update to running status
            if task_crd.status:
                task_crd.status.status = "RUNNING"
                # If there is only one subtask, use the subtask's progress
                if total_subtasks == 1:
                    task_crd.status.progress = subtasks[0].progress
                    task_crd.status.result = subtasks[0].result
                    task_crd.status.errorMessage = subtasks[0].error_message
        
        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.utcnow()
        task.json = task_crd.model_dump(mode='json')
        task.updated_at = datetime.utcnow()
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(task, "json")
        db.add(task)

    def delete_executor_task_sync(self, executor_name: str, executor_namespace: str) -> Dict:
        """
        Synchronous version of delete_executor_task to avoid event loop issues
        
        Args:
            executor_name: The executor task name to delete
            executor_namespace: Executor namespace (required)
        """
        if not executor_name or not executor_namespace:
            raise HTTPException(status_code=400, detail="executor_name and executor_namespace are required")
        try:
            import requests
            payload = {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            }
            logger.info(f"executor.delete sync request url={settings.EXECUTOR_DELETE_TASK_URL} {payload}")

            response = requests.post(
                settings.EXECUTOR_DELETE_TASK_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
                timeout=30.0
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            raise HTTPException(
                status_code=500,
                detail=f"Error deleting executor task: {str(e)}"
            )


executor_kinds_service = ExecutorKindsService(Kind)