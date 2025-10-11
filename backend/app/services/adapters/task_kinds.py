# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import func, text

from app.models.kind import Kind
from app.models.user import User
from app.models.subtask import Subtask, SubtaskStatus, SubtaskRole
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB, TaskDetail, TaskStatus
from app.services.base import BaseService
from app.core.config import settings


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
        # Limit running tasks per user
        running_count = db.query(Kind).filter(
            Kind.user_id == user.id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') IN ('PENDING', 'RUNNING')")
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
            task_status = existing_task.json.get("status", {}).get("status", "PENDING")
            
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
            
            # Check if task is expired
            expire_hours = settings.APPEND_TASK_EXPIRE_HOURS
            if (datetime.utcnow() - existing_task.updated_at).total_seconds() > expire_hours * 3600:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task has expired. You can only append tasks within {expire_hours} hours after last update."
                )

            # Update existing task status to PENDING
            task_json = existing_task.json
            task_json["status"]["status"] = "PENDING"
            task_json["status"]["progress"] = 0
            existing_task.json = task_json
            flag_modified(existing_task, "json")
            
            db.commit()
            db.refresh(existing_task)
            return self._convert_to_task_dict(existing_task, db, user.id)

        # Validate team exists and belongs to user
        if not obj_in.team_id:
            raise HTTPException(
                status_code=400,
                detail="Team ID is required for creating a new task."
            )

        team = db.query(Kind).filter(
            Kind.id == obj_in.team_id,
            Kind.user_id == user.id,
            Kind.kind == "Team",
            Kind.is_active == True
        ).first()
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found"
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
        db.flush()  # Get workspace ID

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
                },
                "batch": obj_in.batch or 0
            },
            "status": {
                "state": "Available",
                "status": obj_in.status.value if obj_in.status else "PENDING",
                "progress": obj_in.progress or 0,
                "result": obj_in.result,
                "errorMessage": obj_in.error_message,
                "createdAt": datetime.utcnow().isoformat(),
                "updatedAt": datetime.utcnow().isoformat(),
                "completedAt": None
            },
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default"
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

        return self._convert_to_task_dict(task, db, user.id)

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Get user's Task list with pagination (only active tasks, excluding DELETE status)
        """
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'")
        )

        total = query.with_entities(func.count(Kind.id)).scalar()
        tasks = query.order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()

        result = []
        for task in tasks:
            result.append(self._convert_to_task_dict(task, db, user_id))

        return result, total

    def get_user_tasks_by_title_with_pagination(
        self, db: Session, *, user_id: int, title: str, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Dict[str, Any]], int]:
        """
        Fuzzy search tasks by title for current user (pagination), excluding DELETE status
        """
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Task",
            Kind.is_active == True,
            text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"),
            text("JSON_EXTRACT(json, '$.spec.title') LIKE :title")
        ).params(title=f"%{title}%")

        total = query.with_entities(func.count(Kind.id)).scalar()
        tasks = query.order_by(Kind.created_at.desc()).offset(skip).limit(limit).all()

        result = []
        for task in tasks:
            result.append(self._convert_to_task_dict(task, db, user_id))

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
        Get detailed task information including related user and team
        """
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

        task_dict["user"] = user
        task_dict["team"] = team
        task_dict["subtasks"] = []  # TODO: Implement subtasks if needed

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
        task_json = task.json

        # Update task spec fields
        if "title" in update_data:
            task_json["spec"]["title"] = update_data["title"]
        if "prompt" in update_data:
            task_json["spec"]["prompt"] = update_data["prompt"]

        # Update task status fields
        if "status" in update_data:
            task_json["status"]["status"] = update_data["status"].value if hasattr(update_data["status"], 'value') else update_data["status"]
        if "progress" in update_data:
            task_json["status"]["progress"] = update_data["progress"]
        if "result" in update_data:
            task_json["status"]["result"] = update_data["result"]
        if "error_message" in update_data:
            task_json["status"]["errorMessage"] = update_data["error_message"]

        # Update workspace if git-related fields are provided
        if any(field in update_data for field in ["git_url", "git_repo", "git_repo_id", "git_domain", "branch_name"]):
            workspace_ref = task_json["spec"]["workspaceRef"]
            workspace = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Workspace",
                Kind.name == workspace_ref["name"],
                Kind.namespace == workspace_ref["namespace"],
                Kind.is_active == True
            ).first()
            
            if workspace:
                workspace_json = workspace.json
                repository = workspace_json["spec"]["repository"]
                
                if "git_url" in update_data:
                    repository["gitUrl"] = update_data["git_url"]
                if "git_repo" in update_data:
                    repository["gitRepo"] = update_data["git_repo"]
                if "git_repo_id" in update_data:
                    repository["gitRepoId"] = update_data["git_repo_id"]
                if "git_domain" in update_data:
                    repository["gitDomain"] = update_data["git_domain"]
                if "branch_name" in update_data:
                    repository["branchName"] = update_data["branch_name"]
                
                workspace.json = workspace_json
                flag_modified(workspace, "json")

        # Update timestamps
        task_json["status"]["updatedAt"] = datetime.utcnow().isoformat()
        if "status" in update_data and update_data["status"] in ["COMPLETED", "FAILED", "CANCELLED"]:
            task_json["status"]["completedAt"] = datetime.utcnow().isoformat()

        task.json = task_json
        task.updated_at = datetime.utcnow()
        flag_modified(task, "json")

        db.commit()
        db.refresh(task)

        return self._convert_to_task_dict(task, db, user_id)

    def delete_task(
        self, db: Session, *, task_id: int, user_id: int
    ) -> None:
        """
        Delete user Task (set status to DELETE)
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

        # Update task status to DELETE
        task_json = task.json
        task_json["status"]["status"] = "DELETE"
        task_json["status"]["updatedAt"] = datetime.utcnow().isoformat()
        task.json = task_json
        task.updated_at = datetime.utcnow()
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
        # Extract data from task JSON
        task_spec = task.json.get("spec", {})
        task_status = task.json.get("status", {})

        # Get workspace data
        workspace_ref = task_spec.get("workspaceRef", {})
        workspace = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Workspace",
            Kind.name == workspace_ref.get("name"),
            Kind.namespace == workspace_ref.get("namespace", "default"),
            Kind.is_active == True
        ).first()

        git_url = ""
        git_repo = ""
        git_repo_id = 0
        git_domain = ""
        branch_name = ""

        if workspace and workspace.json:
            repository = workspace.json.get("spec", {}).get("repository", {})
            git_url = repository.get("gitUrl", "")
            git_repo = repository.get("gitRepo", "")
            git_repo_id = repository.get("gitRepoId", 0)
            git_domain = repository.get("gitDomain", "")
            branch_name = repository.get("branchName", "")

        # Get team data
        team_ref = task_spec.get("teamRef", {})
        team = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Team",
            Kind.name == team_ref.get("name"),
            Kind.namespace == team_ref.get("namespace", "default"),
            Kind.is_active == True
        ).first()

        team_id = team.id if team else None

        # Parse timestamps
        created_at = None
        updated_at = None
        completed_at = None
        
        try:
            if task_status.get("createdAt"):
                created_at = datetime.fromisoformat(task_status["createdAt"].replace('Z', '+00:00'))
            if task_status.get("updatedAt"):
                updated_at = datetime.fromisoformat(task_status["updatedAt"].replace('Z', '+00:00'))
            if task_status.get("completedAt"):
                completed_at = datetime.fromisoformat(task_status["completedAt"].replace('Z', '+00:00'))
        except:
            # Fallback to task timestamps
            created_at = task.created_at
            updated_at = task.updated_at

        # Get user info
        user = db.query(User).filter(User.id == user_id).first()
        user_name = user.user_name if user else ""

        return {
            "id": task.id,
            "user_id": task.user_id,
            "k_id": task.id,  # For compatibility
            "user_name": user_name,
            "title": task_spec.get("title", ""),
            "team_id": team_id,
            "git_url": git_url,
            "git_repo": git_repo,
            "git_repo_id": git_repo_id,
            "git_domain": git_domain,
            "branch_name": branch_name,
            "prompt": task_spec.get("prompt", ""),
            "status": task_status.get("status", "PENDING"),
            "progress": task_status.get("progress", 0),
            "batch": task_spec.get("batch", 0),
            "result": task_status.get("result"),
            "error_message": task_status.get("errorMessage"),
            "created_at": created_at or task.created_at,
            "updated_at": updated_at or task.updated_at,
            "completed_at": completed_at,
        }

    def _convert_team_to_dict(self, team: Kind, db: Session, user_id: int) -> Dict[str, Any]:
        """
        Convert kinds Team to team-like dictionary (simplified version)
        """
        team_spec = team.json.get("spec", {})
        members = team_spec.get("members", [])
        collaboration_model = team_spec.get("collaborationModel", "pipeline")

        # Convert members to bots format
        bots = []
        for member in members:
            bot_ref = member.get("botRef", {})
            bot_name = bot_ref.get("name")
            bot_namespace = bot_ref.get("namespace", "default")

            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
                Kind.is_active == True
            ).first()

            if bot:
                bot_info = {
                    "bot_id": bot.id,
                    "bot_prompt": member.get("prompt", ""),
                    "role": member.get("name", "")
                }
                bots.append(bot_info)

        # Convert collaboration model to workflow format
        workflow = {"mode": collaboration_model}

        return {
            "id": team.id,
            "user_id": team.user_id,
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
        # Extract team members from team JSON
        team_spec = team.json.get("spec", {})
        members = team_spec.get("members", [])
        
        if not members:
            raise HTTPException(
                status_code=400,
                detail="No members configured in team"
            )

        # Get bot IDs from team members
        bot_ids = []
        for member in members:
            bot_ref = member.get("botRef", {})
            bot_name = bot_ref.get("name")
            bot_namespace = bot_ref.get("namespace", "default")
            
            # Find bot in kinds table
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Bot",
                Kind.name == bot_name,
                Kind.namespace == bot_namespace,
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
        parent_id = None
        if existing_subtasks:
            next_message_id = existing_subtasks[0].message_id + 1
            parent_id = existing_subtasks[0].message_id

        # Create USER role subtask based on task object
        user_subtask = Subtask(
            user_id=user_id,
            task_id=task.id,
            team_id=team.id,
            title=f"{task.json['spec']['title']} - User",
            bot_ids=bot_ids,
            role=SubtaskRole.USER,
            prompt=user_prompt,
            status=SubtaskStatus.COMPLETED,
            progress=0,
            message_id=next_message_id,
            parent_id=parent_id,
        )
        db.add(user_subtask)

        # Update id of next message and parent
        if parent_id is None:
            parent_id = 1
        next_message_id = next_message_id + 1

        # Create ASSISTANT role subtask based on team workflow
        collaboration_model = team_spec.get("collaborationModel", "pipeline")
        
        if collaboration_model == "pipeline":
            # Create individual subtasks for each bot in pipeline mode
            executor_infos = self._get_pipeline_executor_info(existing_subtasks)
            for i, member in enumerate(members):
                bot_ref = member.get("botRef", {})
                bot_name = bot_ref.get("name")
                bot_namespace = bot_ref.get("namespace", "default")
                
                # Find bot in kinds table
                bot = db.query(Kind).filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Bot",
                    Kind.name == bot_name,
                    Kind.namespace == bot_namespace,
                    Kind.is_active == True
                ).first()
                
                if bot:
                    subtask = Subtask(
                        user_id=user_id,
                        task_id=task.id,
                        team_id=team.id,
                        title=f"{task.json['spec']['title']} - {bot.name}",
                        bot_ids=[bot.id],
                        role=SubtaskRole.ASSISTANT,
                        prompt="",
                        status=SubtaskStatus.PENDING,
                        progress=0,
                        message_id=next_message_id,
                        parent_id=parent_id,
                        # If executor_infos is not empty, take the i-th one, otherwise empty string
                        executor_name=executor_infos[i].get('executor_name') if len(executor_infos) > i else "",
                        executor_namespace=executor_infos[i].get('executor_namespace') if len(executor_infos) > i else ""
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
                title=f"{task.json['spec']['title']} - Assistant",
                bot_ids=bot_ids,
                role=SubtaskRole.ASSISTANT,
                prompt="",
                status=SubtaskStatus.PENDING,
                progress=0,
                message_id=next_message_id,
                parent_id=parent_id,
                executor_name=executor_name,
                executor_namespace=executor_namespace
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


task_kinds_service = TaskKindsService(Kind)