# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple
import json
import logging
import asyncio

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import func, text

from app.models.kind import Kind
from app.models.user import User
from app.models.shared_team import SharedTeam
from app.models.subtask import Subtask, SubtaskStatus, SubtaskRole
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB, TaskDetail, TaskStatus
from app.schemas.kind import Task, Workspace, Team, Bot, Ghost, Shell, Model
from app.services.adapters.executor_kinds import executor_kinds_service
from app.services.base import BaseService
from app.core.config import settings

logger = logging.getLogger(__name__)

class TaskKindsService(BaseService[Kind, TaskCreate, TaskUpdate]):
    """
    Task service class using kinds table
    """
    def create_task_or_append(
        self, db: Session, *, obj_in: TaskCreate, user: User, task_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Create user Task using kinds table
        """
        logger.info(f"create_task_or_append called with task_id={task_id}, user_id={user.id}")
        task = None
        team = None

        # Limit running tasks per user
        running_count = db.query(Kind).filter(
            Kind.user_id == user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_UNQUOTE(JSON_EXTRACT(json, '$.status.status')) IN ('PENDING', 'RUNNING') and (JSON_EXTRACT(json, '$.metadata.labels.type') is null or JSON_EXTRACT(json, '$.metadata.labels.type') = 'online')")
        ).count()
        if running_count >= settings.MAX_RUNNING_TASKS_PER_USER:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum number of running tasks per user ({settings.MAX_RUNNING_TASKS_PER_USER}) exceeded."
            )

        # Set task ID
        if task_id is None:
            task_id = self.create_task_id(db, user.id)
        else:
            # Validate if task_id is valid
            if not self.validate_task_id(db, task_id):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid task_id: {task_id} does not exist in session"
                )

        # Check if already exists
        existing_task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).first()
        if existing_task:
            # Handle existing task logic
            task_crd = Task.model_validate(existing_task.json)
            task_status = task_crd.status.status if task_crd.status else "PENDING"
            
            if task_status == "RUNNING":
                raise HTTPException(
                    status_code=400,
                    detail="Task is still running, please wait for it to complete"
                )
            elif task_status in ["FAILED", "DELETE", "CANCELLED"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task has {task_status.lower()}, please create a new task"
                )
            elif task_status != "COMPLETED":
                raise HTTPException(
                    status_code=400,
                    detail="Task is in progress, please wait for it to complete"
                )
            
            if task_crd.metadata.labels and task_crd.metadata.labels["autoDeleteExecutor"] == "true" :
                raise HTTPException(
                    status_code=400,
                    detail="offline task already clear, please create a new task"
                )
            
            # Check if task is expired
            expire_hours = settings.APPEND_TASK_EXPIRE_HOURS
            if (datetime.now() - existing_task.updated_at).total_seconds() > expire_hours * 3600:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task has expired. You can only append tasks within {expire_hours} hours after last update."
                )

            # Get team reference information from task_crd and validate if team exists
            team_name = task_crd.spec.teamRef.name
            team_namespace = task_crd.spec.teamRef.namespace
            
            team = self._get_team_by_name_and_namespace(db, team_name, team_namespace, user.id)
            if not team:
                raise HTTPException(
                    status_code=404,
                    detail=f"Team '{team_name}' not found, it may be deleted or not shared"
                )

            # Update existing task status to PENDING
            if task_crd.status:
                task_crd.status.status = "PENDING"
                task_crd.status.progress = 0
            existing_task.json = task_crd.model_dump(mode='json', exclude_none=True)
            existing_task.updated_at = datetime.now()

            task = existing_task
        else:
            # Validate team exists and belongs to user
            if not obj_in.team_id:
                raise HTTPException(
                    status_code=400,
                    detail="Team ID is required for creating a new task."
                )

            team = self._get_team_by_id_or_join_team(db, obj_in.team_id, user.id)
            
            if not team:
                raise HTTPException(
                    status_code=404,
                    detail="Team not found, it may be deleted or not shared"
                )

            # Additional business validation for prompt length
            if obj_in.prompt and len(obj_in.prompt.encode('utf-8')) > 60000:
                raise HTTPException(
                    status_code=400,
                    detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding."
                )

            # Default values for git-related information
            git_url = obj_in.git_url or ""
            git_repo = obj_in.git_repo or ""
            git_domain = obj_in.git_domain or ""
            branch_name = obj_in.branch_name or ""
            git_repo_id = obj_in.git_repo_id or 0

            # If title is empty, extract first 50 characters from prompt as title
            title = obj_in.title
            if not title and obj_in.prompt:
                title = obj_in.prompt[:50]
                if len(obj_in.prompt) > 50:
                    title += "..."

            # Create Workspace first
            workspace_name = f"workspace-{task_id}"
            workspace_json = {
                "kind": "Workspace",
                "spec": {
                    "repository": {
                        "gitUrl": git_url,
                        "gitRepo": git_repo,
                        "gitRepoId": git_repo_id,
                        "gitDomain": git_domain,
                        "branchName": branch_name
                    }
                },
                "status": {
                    "state": "Available"
                },
                "metadata": {
                    "name": workspace_name,
                    "namespace": "default"
                },
                "apiVersion": "agent.wecode.io/v1"
            }

            workspace = Kind(
                user_id=user.id,
                kind="Workspace",
                name=workspace_name,
                namespace="default",
                json=workspace_json,
                is_active=True
            )
            db.add(workspace)
            

        # If not exists, create new task
        if task is None:
            # Create Task JSON
            task_json = {
                "kind": "Task",
                "spec": {
                    "title": title,
                    "prompt": obj_in.prompt,
                    "teamRef": {
                        "name": team.name,
                        "namespace": team.namespace
                    },
                    "workspaceRef": {
                        "name": workspace_name,
                        "namespace": "default"
                    }
                },
                "status": {
                    "state": "Available",
                    "status": "PENDING",
                    "progress": 0,
                    "result": None,
                    "errorMessage": "",
                    "createdAt": datetime.now().isoformat(),
                    "updatedAt": datetime.now().isoformat(),
                    "completedAt": None
                },
                "metadata": {
                    "name": f"task-{task_id}",
                    "namespace": "default",
                    "labels": {
                        "type": obj_in.type or "online", # "online" or "offline"
                        "autoDeleteExecutor": obj_in.auto_delete_executor or "false",
                    }
                },
                "apiVersion": "agent.wecode.io/v1"
            }

            task = Kind(
                id=task_id,  # Use the provided task_id
                user_id=user.id,
                kind="Task",
                name=f"task-{task_id}",
                namespace="default",
                json=task_json,
                is_active=True
            )
            db.add(task)

        # Create subtasks for the task
        self._create_subtasks(db, task, team, user.id, obj_in.prompt)

        db.commit()
        db.refresh(task)
        db.flush()

        return self._convert_to_task_dict(task, db, user.id)

    def _get_team_by_name_and_namespace(self, db: Session, team_name: str, team_namespace: str, user_id: int) -> Optional[Kind]:
        existing_team = db.query(Kind).filter(
            Kind.name == team_name,
            Kind.namespace == team_namespace,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()

        if existing_team:
            return existing_team

        join_share_teams = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.is_active == True
        ).all()

        for join_team in join_share_teams:
            team = db.query(Kind).filter(
                Kind.name == team_name,
                Kind.namespace == team_namespace,
                Kind.user_id == join_team.original_user_id,
                Kind.kind == "Team",
                Kind.is_active == True
            ).first()
            if team:
                return team

        return None

    def _get_team_by_id_or_join_team(self, db: Session, team_id: int, user_id: int) -> Optional[Kind]:
        """
        Get team by ID, checking both user's own teams and shared teams
        """
        # First check if team exists and belongs to user
        existing_team = db.query(Kind).filter(
            Kind.id == team_id,
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        
        if existing_team:
            return existing_team
        
        # If not found, check if team exists in shared teams
        shared_team = db.query(SharedTeam).filter(
            SharedTeam.user_id == user_id,
            SharedTeam.team_id == team_id,
            SharedTeam.is_active == True
        ).first()
        
        if shared_team:
            # Return shared team
            return db.query(Kind).filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active == True
            ).first()
        
        return None
    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (only active tasks, excluding DELETE status)
        Optimized version using batch queries to reduce database calls
        """
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'")
        )

        total = query.with_entities(func.count(Kind.id)).scalar()
        tasks = query.order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()

        if not tasks:
            return [], total

        # Get all related data in batch to avoid N+1 queries
        related_data_batch = self._get_tasks_related_data_batch(db, tasks, user_id)
        
        result = []
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(self._convert_to_task_dict_optimized(task, task_related_data, task_crd))

        return result, total

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Fuzzy search tasks by title for current user (pagination), excluding DELETE status
        Optimized version using batch queries to reduce database calls
        """
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE' and JSON_EXTRACT(json, '$.spec.title') LIKE :title")
        ).params(title=f"%{title}%")

        total = query.with_entities(func.count(Kind.id)).scalar()
        tasks = query.order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()

        if not tasks:
            return [], total

        # Get all related data in batch to avoid N+1 queries
        related_data_batch = self._get_tasks_related_data_batch(db, tasks, user_id)
        
        result = []
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            task_related_data = related_data_batch.get(str(task.id), {})
            result.append(self._convert_to_task_dict_optimized(task, task_related_data, task_crd))

        return result, total

    def get_task_by_id(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get Task by ID and user ID (only active tasks)
        """
        task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'")
        ).first()

        if not task:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        return self._convert_to_task_dict(task, db, user_id)

    def get_task_detail(
        self, db: Session, *, task_id: int, user_id: int
    ) -> Dict[str, Any]:
        """
        Get detailed task information including related user, team and subtasks
        """
        from app.services.subtask import subtask_service
        
        task_dict = self.get_task_by_id(db, task_id=task_id, user_id=user_id)

        # Get related user
        user = db.query(User).filter(User.id == user_id).first()

        # Get related team
        team_id = task_dict.get("team_id")
        team = None
        if team_id:
            team = db.query(Kind).filter(
                Kind.id == team_id,
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.is_active == True
            ).first()
            if team:
                team = self._convert_team_to_dict(team, db, user_id)

        # Get related subtasks
        subtasks = subtask_service.get_by_task(
            db=db,
            task_id=task_id,
            user_id=user_id
        )
        
        # Get all bot objects for the subtasks
        all_bot_ids = set()
        for subtask in subtasks:
            if subtask.bot_ids:
                all_bot_ids.update(subtask.bot_ids)
        
        bots = {}
        if all_bot_ids:
            # Get bots from kinds table (Bot kind)
            bot_objects = db.query(Kind).filter(
                Kind.id.in_(list(all_bot_ids)),
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.is_active == True
            ).all()
            
            # Convert bot objects to dict using bot JSON data
            # Convert bot objects to dict using bot JSON data
            for bot in bot_objects:
                bot_crd = Bot.model_validate(bot.json)
                
                # Initialize default values
                agent_name = ""
                agent_config = {}
                system_prompt = ""
                mcp_servers = {}
                
                # Get Ghost data from kinds table
                ghost = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Ghost",
                    Kind.name == bot_crd.spec.ghostRef.name,
                    Kind.namespace == bot_crd.spec.ghostRef.namespace,
                    Kind.is_active == True
                ).first()
                if ghost and ghost.json:
                    ghost_crd = Ghost.model_validate(ghost.json)
                    system_prompt = ghost_crd.spec.systemPrompt
                    mcp_servers = ghost_crd.spec.mcpServers or {}
                
                # Get Model data from kinds table
                model = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Model",
                    Kind.name == bot_crd.spec.modelRef.name,
                    Kind.namespace == bot_crd.spec.modelRef.namespace,
                    Kind.is_active == True
                ).first()
                if model and model.json:
                    model_crd = Model.model_validate(model.json)
                    agent_config = model_crd.spec.modelConfig
                
                # Get Shell data from kinds table
                shell = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Shell",
                    Kind.name == bot_crd.spec.shellRef.name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace,
                    Kind.is_active == True
                ).first()
                if shell and shell.json:
                    shell_crd = Shell.model_validate(shell.json)
                    agent_name = shell_crd.spec.runtime
                
                # Create bot dict compatible with BotInDB schema
                bot_dict = {
                    "id": bot.id,
                    "user_id": bot.user_id,
                    "name": bot.name,
                    "agent_name": agent_name,
                    "agent_config": agent_config,
                    "system_prompt": system_prompt,
                    "mcp_servers": mcp_servers,
                    "is_active": bot.is_active,
                    "created_at": bot.created_at,
                    "updated_at": bot.updated_at
                }
                bots[bot.id] = bot_dict
        # Convert subtasks to dict and replace bot_ids with bot objects
        subtasks_dict = []
        for subtask in subtasks:
            # Convert subtask to dict
            subtask_dict = {
                # Subtask base fields
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_ids": subtask.bot_ids,
                "role": subtask.role,
                "prompt": subtask.prompt,
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "message_id": subtask.message_id,
                "parent_id": subtask.parent_id,
                "status": subtask.status,
                "progress": subtask.progress,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "user_id": subtask.user_id,
                "created_at": subtask.created_at,
                "updated_at": subtask.updated_at,
                "completed_at": subtask.completed_at,
                # Add bot objects as dict for each bot_id
                "bots": [bots.get(bot_id) for bot_id in subtask.bot_ids if bot_id in bots]
            }
            subtasks_dict.append(subtask_dict)

        task_dict["user"] = user
        task_dict["team"] = team
        task_dict["subtasks"] = subtasks_dict

        return task_dict

    def update_task(
        self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int
    ) -> Dict[str, Any]:
        """
        Update user Task
        """
        task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).first()

        if not task:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        # Additional business validation for prompt length if being updated
        if obj_in.prompt is not None and len(obj_in.prompt.encode('utf-8')) > 60000:
            raise HTTPException(
                status_code=400,
                detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding."
            )

        update_data = obj_in.model_dump(exclude_unset=True)
        task_crd = Task.model_validate(task.json)

        # Update task spec fields
        if "title" in update_data:
            task_crd.spec.title = update_data["title"]
        if "prompt" in update_data:
            task_crd.spec.prompt = update_data["prompt"]

        # Update task status fields
        if task_crd.status:
            if "status" in update_data:
                task_crd.status.status = update_data["status"].value if hasattr(update_data["status"], 'value') else update_data["status"]
            if "progress" in update_data:
                task_crd.status.progress = update_data["progress"]
            if "result" in update_data:
                task_crd.status.result = update_data["result"]
            if "error_message" in update_data:
                task_crd.status.errorMessage = update_data["error_message"]

        # Update workspace if git-related fields are provided
        if any(field in update_data for field in ["git_url", "git_repo", "git_repo_id", "git_domain", "branch_name"]):
            workspace = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Workspace",
                Kind.name == task_crd.spec.workspaceRef.name,
                Kind.namespace == task_crd.spec.workspaceRef.namespace,
                Kind.is_active == True
            ).first()
            
            if workspace:
                workspace_crd = Workspace.model_validate(workspace.json)
                
                if "git_url" in update_data:
                    workspace_crd.spec.repository.gitUrl = update_data["git_url"]
                if "git_repo" in update_data:
                    workspace_crd.spec.repository.gitRepo = update_data["git_repo"]
                if "git_repo_id" in update_data:
                    workspace_crd.spec.repository.gitRepoId = update_data["git_repo_id"]
                if "git_domain" in update_data:
                    workspace_crd.spec.repository.gitDomain = update_data["git_domain"]
                if "branch_name" in update_data:
                    workspace_crd.spec.repository.branchName = update_data["branch_name"]
                
                workspace.json = workspace_crd.model_dump()
                flag_modified(workspace, "json")

        # Update timestamps
        if task_crd.status:
            task_crd.status.updatedAt = datetime.now()
            if "status" in update_data and update_data["status"] in ["COMPLETED", "FAILED", "CANCELLED"]:
                task_crd.status.completedAt = datetime.now()

        task.json = task_crd.model_dump()
        task.updated_at = datetime.now()
        flag_modified(task, "json")

        db.commit()
        db.refresh(task)

        return self._convert_to_task_dict(task, db, user_id)

    def delete_task(
        self, db: Session, *, task_id: int, user_id: int
    ) -> None:
        """
        Delete user Task and handle running subtasks
        """
        logger.info(f"Deleting task with id: {task_id}")
        task = db.query(Kind).filter(
            Kind.id == task_id,
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True
        ).first()

        if not task:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )

        # Get all subtasks for the task
        task_subtasks = db.query(Subtask).filter(
            Subtask.task_id == task_id
        ).all()
        
        # Collect unique executor keys to avoid duplicate calls (namespace + name)
        unique_executor_keys = set()
        for subtask in task_subtasks:
            if subtask.executor_name and not subtask.executor_deleted_at:
                unique_executor_keys.add((subtask.executor_namespace, subtask.executor_name))
        
        # Stop running subtasks on executor (deduplicated by (namespace, name))
        for executor_namespace, executor_name in unique_executor_keys:
            try:
                logger.info(f"deleting task - delete_executor_task ns={executor_namespace} name={executor_name}")
                # Use sync version to avoid event loop issues
                executor_kinds_service.delete_executor_task_sync(executor_name, executor_namespace)
            except Exception as e:
                # Log error but continue with status update
                logger.warning(f"Failed to delete executor task ns={executor_namespace} name={executor_name}: {str(e)}")
        
        # Update all subtasks to DELETE status
        db.query(Subtask).filter(Subtask.task_id == task_id).update({
            Subtask.executor_deleted_at: True,
            Subtask.status: SubtaskStatus.DELETE,
            Subtask.updated_at: datetime.now()
        })
        
        # Update task status to DELETE
        task_crd = Task.model_validate(task.json)
        if task_crd.status:
            task_crd.status.status = "DELETE"
            task_crd.status.updatedAt = datetime.now()
        # Use model_dump's exclude_none and json_encoders options to ensure datetime is properly serialized
        task.json = task_crd.model_dump(mode='json', exclude_none=True)
        task.updated_at = datetime.now()
        task.is_active = False
        flag_modified(task, "json")

        db.commit()

    def create_task_id(self, db: Session, user_id: int) -> int:
        """
        Create new task id using kinds table auto increment (pre-allocation mechanism)
        Compatible with concurrent scenarios
        """
        from sqlalchemy import text
        import json as json_lib
        
        try:
            # First check if user already has a Placeholder record
            existing_placeholder = db.execute(text("""
                SELECT id FROM kinds
                WHERE user_id = :user_id AND kind = 'Placeholder' AND is_active = false
                LIMIT 1
            """), {"user_id": user_id}).fetchone()
            
            if existing_placeholder:
                # Return existing placeholder ID
                return existing_placeholder[0]
            
            # Create placeholder JSON data
            placeholder_json = {
                "kind": "Placeholder",
                "metadata": {"name": "temp-placeholder", "namespace": "default"},
                "spec": {},
                "status": {"state": "Reserved"}
            }
            
            # Insert placeholder record with real user_id, let MySQL auto-increment handle the ID allocation
            # Keep the placeholder record until validate_task_id is called
            result = db.execute(text("""
                INSERT INTO kinds (user_id, kind, name, namespace, json, is_active, created_at, updated_at)
                VALUES (:user_id, 'Placeholder', 'temp-placeholder', 'default', :json, false, NOW(), NOW())
            """), {
                "user_id": user_id,
                "json": json_lib.dumps(placeholder_json)
            })
            
            # Get the auto-generated ID
            allocated_id = result.lastrowid
            if not allocated_id:
                raise Exception("Failed to get allocated ID")
            
            # Do NOT delete the placeholder record here - keep it for validation
            db.commit()
            
            return allocated_id
            
        except Exception as e:
            db.rollback()
            raise HTTPException(
                status_code=500,
                detail=f"Unable to allocate task ID: {str(e)}"
            )

    def validate_task_id(self, db: Session, task_id: int) -> bool:
        """
        Validate that task_id is valid and clean up placeholder if exists
        """
        from sqlalchemy import text
        
        # Check if task_id exists and get its kind
        existing_record = db.execute(
            text("SELECT kind FROM kinds WHERE id = :task_id"),
            {"task_id": task_id}
        ).fetchone()
        
        if existing_record:
            kind = existing_record[0]
            
            # If it's a Placeholder, delete it and return True
            if kind == "Placeholder":
                db.execute(text("DELETE FROM kinds WHERE id = :id"), {"id": task_id})
                db.commit()
                return True
            
            # If it's any other kind, it's valid
            return True

        return False

    def _convert_to_task_dict(self, task: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Task to task-like dictionary
        """
        task_crd = Task.model_validate(task.json)

        # Get workspace data
        workspace = db.query(Kind).filter(
            Kind.user_id == user_id,
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

        # Get team data
        team = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.name == task_crd.spec.teamRef.name,
            Kind.namespace == task_crd.spec.teamRef.namespace,
            Kind.is_active == True
        ).first()

        team_id = team.id if team else None

        # Parse timestamps
        created_at = None
        updated_at = None
        completed_at = None
        
        if task_crd.status:
            try:
                if task_crd.status.createdAt:
                    created_at = task_crd.status.createdAt
                if task_crd.status.updatedAt:
                    updated_at = task_crd.status.updatedAt
                if task_crd.status.completedAt:
                    completed_at = task_crd.status.completedAt
            except:
                # Fallback to task timestamps
                created_at = task.created_at
                updated_at = task.updated_at

        # Get user info
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else ""

        type = task_crd.metadata.labels and task_crd.metadata.labels.get("type") or "online"

        return {
            "id": task.id,
            "type": type,
            "user_id": task.user_id,
            "user_name": user_name,
            "title": task_crd.spec.title,
            "team_id": team_id,
            "git_url": git_url,
            "git_repo": git_repo,
            "git_repo_id": git_repo_id,
            "git_domain": git_domain,
            "branch_name": branch_name,
            "prompt": task_crd.spec.prompt,
            "status": task_crd.status.status if task_crd.status else "PENDING",
            "progress": task_crd.status.progress if task_crd.status else 0,
            "result": task_crd.status.result if task_crd.status else None,
            "error_message": task_crd.status.errorMessage if task_crd.status else None,
            "created_at": created_at or task.created_at,
            "updated_at": updated_at or task.updated_at,
            "completed_at": completed_at,
        }

    def _convert_team_to_dict(self, team: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary (simplified version)
        """
        team_crd = Team.model_validate(team.json)

        # Convert members to bots format
        bots = []
        for member in team_crd.spec.members:
            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True
            ).first()

            if bot:
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.prompt or "",
                    "role": member.role or ""
                }
                bots.append(bot_info)

        # Convert collaboration model to workflow format
        workflow = {"mode": team_crd.spec.collaborationModel}

        # Get user info for user name
        user = db.query(User).filter(User.id == team.user_id).first()
        user_name = user.user_name if user else ""

        return {
            "id": team.id,
            "user_id": team.user_id,
            "user_name": user_name,
            "name": team.name,
            "bots": bots,
            "workflow": workflow,
            "is_active": team.is_active,
            "created_at": team.created_at,
            "updated_at": team.updated_at,
        }

    def _create_subtasks(self, db: Session, task: Kind, team: Kind, user_id: int, user_prompt: str) -> None:
        """
        Create subtasks based on team's workflow configuration
        """
        logger.info(f"_create_subtasks called with task_id={task.id}, team_id={team.id}, user_id={user_id}")
        team_crd = Team.model_validate(team.json)
        task_crd = Task.model_validate(task.json)
        
        if not team_crd.spec.members:
            logger.warning(f"No members configured in team {team.id}")
            raise HTTPException(
                status_code=400,
                detail="No members configured in team"
            )

        # Get bot IDs from team members
        bot_ids = []
        for member in team_crd.spec.members:
            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True
            ).first()
            
            if bot:
                bot_ids.append(bot.id)

        if not bot_ids:
            raise HTTPException(
                status_code=400,
                detail="No valid bots found in team configuration"
            )

        # For followup tasks: query existing subtasks and add one more
        existing_subtasks = db.query(Subtask).filter(
            Subtask.task_id == task.id,
            Subtask.user_id == user_id
        ).order_by(Subtask.message_id.desc()).all()
        
        # Get the next message_id for the new subtask
        next_message_id = 1
        parent_id = 0
        if existing_subtasks:
            next_message_id = existing_subtasks[0].message_id + 1
            parent_id = existing_subtasks[0].message_id

        # Create USER role subtask based on task object
        user_subtask = Subtask(
            user_id=user_id,
            task_id=task.id,
            team_id=team.id,
            title=f"{task_crd.spec.title} - User",
            bot_ids=bot_ids,
            role=SubtaskRole.USER,
            executor_namespace="",  # Add default empty string for NOT NULL constraint
            executor_name="",       # Add default empty string for NOT NULL constraint
            prompt=user_prompt,
            status=SubtaskStatus.COMPLETED,
            progress=0,
            message_id=next_message_id,
            parent_id=parent_id,
            error_message="",
            completed_at=datetime.now(),
            result=None,
        )
        db.add(user_subtask)

        # Update id of next message and parent
        if parent_id == 0:
            parent_id = 1
        next_message_id = next_message_id + 1

        # Create ASSISTANT role subtask based on team workflow
        collaboration_model = team_crd.spec.collaborationModel
        
        if collaboration_model == "pipeline":
            # Create individual subtasks for each bot in pipeline mode
            executor_infos = self._get_pipeline_executor_info(existing_subtasks)
            for i, member in enumerate(team_crd.spec.members):
                # Find bot in kinds table
                bot = db.query(Kind).filter(
                    Kind.user_id == team.user_id,
                    Kind.kind == "Bot",
                    Kind.name == member.botRef.name,
                    Kind.namespace == member.botRef.namespace,
                    Kind.is_active == True
                ).first()

                if bot is None:
                    raise Exception(f"Bot {member.botRef.name} not found in kinds table")
                
                subtask = Subtask(
                    user_id=user_id,
                    task_id=task.id,
                    team_id=team.id,
                    title=f"{task_crd.spec.title} - {bot.name}",
                    bot_ids=[bot.id],
                    role=SubtaskRole.ASSISTANT,
                    prompt="",
                    status=SubtaskStatus.PENDING,
                    progress=0,
                    message_id=next_message_id,
                    parent_id=parent_id,
                    # If executor_infos is not empty, take the i-th one, otherwise empty string
                    executor_name=executor_infos[i].get('executor_name') if len(executor_infos) > i else "",
                    executor_namespace=executor_infos[i].get('executor_namespace') if len(executor_infos) > i else "",
                    error_message="",
                    completed_at=datetime.now(),
                    result=None,
                )

                # Update id of next message and parent
                next_message_id = next_message_id + 1
                parent_id = parent_id + 1
                
                db.add(subtask)
        else:
            # For other collaboration models, create a single assistant subtask
            executor_name = ""
            executor_namespace = ""
            if existing_subtasks:
                # Take executor_name and executor_namespace from the last existing_subtasks
                executor_name = existing_subtasks[0].executor_name
                executor_namespace = existing_subtasks[0].executor_namespace
                
            assistant_subtask = Subtask(
                user_id=user_id,
                task_id=task.id,
                team_id=team.id,
                title=f"{task_crd.spec.title} - Assistant",
                bot_ids=bot_ids,
                role=SubtaskRole.ASSISTANT,
                prompt="",
                status=SubtaskStatus.PENDING,
                progress=0,
                message_id=next_message_id,
                parent_id=parent_id,
                executor_name=executor_name,
                executor_namespace=executor_namespace,
                error_message="",
                completed_at=datetime.now(),
                result=None,
            )
            db.add(assistant_subtask)

    def _get_pipeline_executor_info(self, existing_subtasks: List[Subtask]) -> List[Dict[str, str]]:
        """
        Get executor info from existing subtasks for pipeline mode
        """
        first_group_assistants = []
        for s in existing_subtasks:
            if s.role == SubtaskRole.USER:
                break
            if s.role == SubtaskRole.ASSISTANT:
                first_group_assistants.append({
                    "executor_namespace": s.executor_namespace,
                    "executor_name": s.executor_name
                })

        first_group_assistants.reverse()
        return first_group_assistants


    def _get_tasks_related_data_batch(
        self, db: Session, tasks: List[Kind], user_id: int
    ) -> Dict[str, Dict[str, Any]]:
        """
        Batch get workspace and team data for multiple tasks to reduce database queries
        """
        if not tasks:
            return {}
        
        # Extract workspace and team references from all tasks
        workspace_refs = set()
        team_refs = set()
        task_crd_map = {}
        
        for task in tasks:
            task_crd = Task.model_validate(task.json)
            task_crd_map[task.id] = task_crd
            
            if hasattr(task_crd.spec, 'workspaceRef') and task_crd.spec.workspaceRef:
                workspace_refs.add((task_crd.spec.workspaceRef.name, task_crd.spec.workspaceRef.namespace))
            
            if hasattr(task_crd.spec, 'teamRef') and task_crd.spec.teamRef:
                team_refs.add((task_crd.spec.teamRef.name, task_crd.spec.teamRef.namespace))
        
        # Batch query workspaces
        workspace_data = {}
        if workspace_refs:
            workspace_names, workspace_namespaces = zip(*workspace_refs)
            workspaces = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Workspace",
                Kind.name.in_(workspace_names),
                Kind.namespace.in_(workspace_namespaces),
                Kind.is_active == True
            ).all()
            
            for workspace in workspaces:
                key = f"{workspace.name}:{workspace.namespace}"
                if workspace.json:
                    workspace_crd = Workspace.model_validate(workspace.json)
                    workspace_data[key] = {
                        "git_url": workspace_crd.spec.repository.gitUrl,
                        "git_repo": workspace_crd.spec.repository.gitRepo,
                        "git_repo_id": workspace_crd.spec.repository.gitRepoId or 0,
                        "git_domain": workspace_crd.spec.repository.gitDomain,
                        "branch_name": workspace_crd.spec.repository.branchName,
                    }
                else:
                    workspace_data[key] = {
                        "git_url": "",
                        "git_repo": "",
                        "git_repo_id": 0,
                        "git_domain": "",
                        "branch_name": "",
                    }
        
        # Batch query teams
        team_data = {}
        if team_refs:
            team_names, team_namespaces = zip(*team_refs)
            teams = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.name.in_(team_names),
                Kind.namespace.in_(team_namespaces),
                Kind.is_active == True
            ).all()
            
            for team in teams:
                key = f"{team.name}:{team.namespace}"
                team_data[key] = team
        
        # Get user info once
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else ""
        
        # Build result mapping
        result = {}
        for task in tasks:
            task_crd = task_crd_map[task.id]
            
            # Get workspace data
            workspace_key = f"{task_crd.spec.workspaceRef.name}:{task_crd.spec.workspaceRef.namespace}"
            task_workspace_data = workspace_data.get(workspace_key, {
                "git_url": "",
                "git_repo": "",
                "git_repo_id": 0,
                "git_domain": "",
                "branch_name": "",
            })
            
            # Get team data
            team_key = f"{task_crd.spec.teamRef.name}:{task_crd.spec.teamRef.namespace}"
            task_team = team_data.get(team_key)
            team_id = task_team.id if task_team else None
            
            # Parse timestamps
            created_at = None
            updated_at = None
            completed_at = None
            
            if task_crd.status:
                try:
                    if task_crd.status.createdAt:
                        created_at = task_crd.status.createdAt
                    if task_crd.status.updatedAt:
                        updated_at = task_crd.status.updatedAt
                    if task_crd.status.completedAt:
                        completed_at = task_crd.status.completedAt
                except:
                    # Fallback to task timestamps
                    created_at = task.created_at
                    updated_at = task.updated_at
            
            result[str(task.id)] = {
                "workspace_data": task_workspace_data,
                "team_id": team_id,
                "user_name": user_name,
                "created_at": created_at or task.created_at,
                "updated_at": updated_at or task.updated_at,
                "completed_at": completed_at,
            }
        
        return result

    def _convert_to_task_dict_optimized(
        self, task: Kind, related_data: Dict[str, Any], task_crd: Task
    ) -> Dict[str, Any]:
        """
        Optimized version of _convert_to_task_dict that uses pre-fetched related data
        """
        workspace_data = related_data.get("workspace_data", {})
        
        return {
            "id": task.id,
            "user_id": task.user_id,
            "user_name": related_data.get("user_name", ""),
            "title": task_crd.spec.title,
            "team_id": related_data.get("team_id"),
            "git_url": workspace_data.get("git_url", ""),
            "git_repo": workspace_data.get("git_repo", ""),
            "git_repo_id": workspace_data.get("git_repo_id", 0),
            "git_domain": workspace_data.get("git_domain", ""),
            "branch_name": workspace_data.get("branch_name", ""),
            "prompt": task_crd.spec.prompt,
            "status": task_crd.status.status if task_crd.status else "PENDING",
            "progress": task_crd.status.progress if task_crd.status else 0,
            "result": task_crd.status.result if task_crd.status else None,
            "error_message": task_crd.status.errorMessage if task_crd.status else None,
            "created_at": related_data.get("created_at", task.created_at),
            "updated_at": related_data.get("updated_at", task.updated_at),
            "completed_at": related_data.get("completed_at"),
        }


task_kinds_service = TaskKindsService(Kind)
