# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Tuple
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.repository.github_provider import GitHubProvider

from app.models.task import Task, TaskStatus
from app.models.team import Team
from app.models.bot import Bot
from app.models.user import User
from app.models.subtask import Subtask, SubtaskStatus
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB
from app.services.base import BaseService
from app.services.subtask import subtask_service


class TaskService(BaseService[Task, TaskCreate, TaskUpdate]):
    """
    Task service class
    """

    def create_with_user(
        self, db: Session, *, obj_in: TaskCreate, user: User, task_id: Optional[int] = None
    ) -> Task:
        """
        Create user task and automatically create subtasks based on team configuration
        """
        # Validate team exists and belongs to user
        team = db.query(Team).filter(
            Team.id == obj_in.team_id,
            Team.user_id == user.id
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
        
        if not obj_in.git_url:
            obj_in.git_url = ""
        if not obj_in.git_repo:
            obj_in.git_repo = ""
        if not obj_in.git_domain:
            obj_in.git_domain = ""
        if not obj_in.branch_name:
            obj_in.branch_name = ""
        if not obj_in.git_repo_id:
            obj_in.git_repo_id = 0    

        # If title is empty, extract first 50 characters from prompt as title
        title = obj_in.title
        if not title and obj_in.prompt:
            # Extract first 50 characters, add ellipsis if exceeds 50 characters
            title = obj_in.prompt[:50]
            if len(obj_in.prompt) > 50:
                title += "..."
        
        # Create the main task
        task_data = {
            "user_id": user.id,
            "k_id": obj_in.k_id,
            "user_name": user.user_name,
            "title": title,
            "team_id": obj_in.team_id,
            "git_url": obj_in.git_url,
            "git_repo": obj_in.git_repo,
            "git_repo_id": obj_in.git_repo_id,
            "git_domain": obj_in.git_domain,
            "branch_name": obj_in.branch_name,
            "prompt": obj_in.prompt,
            "status": TaskStatus.PENDING,
            "progress": 0,
            "batch": 0
        }
        
        if task_id is not None:
            task_data["id"] = task_id
        else:
            task_data["id"] = self.create_task_id(db)
            
        task = Task(**task_data)
        
        db.add(task)
        db.commit()
        db.refresh(task)
        
        # Create subtasks based on team's bots
        self._create_subtasks_from_team(db, task, team, user.id)
        
        return task

    def create_or_update_by_k_task_id(
        self, db: Session, *, k_task_id: int, user_id: int
    ) -> Task:
        """
        Create or update task based on k_task id
        """
        from app.models.kind import Kind
        from app.schemas.task import TaskCreate, TaskUpdate
        
        # Get k_task from Kind table
        k_task = db.query(Kind).filter(
            Kind.id == k_task_id,
            Kind.user_id == user_id,
            Kind.kind == 'Task',
            Kind.is_active == True
        ).first()
        
        if not k_task:
            raise HTTPException(
                status_code=404,
                detail="Task not found in Kind table"
            )
            
        # Extract task data from json
        k_task_json = k_task.json
        
        # Get team reference from task json
        team_ref = k_task_json.get('spec', {}).get('teamRef', {})
        team_ref_name = team_ref.get('name')
        team_ref_namespace = team_ref.get('namespace', 'default')
        
        # Get k_team from Kind table
        k_team = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Team',
            Kind.name == team_ref_name,
            Kind.namespace == team_ref_namespace,
            Kind.is_active == True
        ).first()
        
        if not k_team:
            raise HTTPException(
                status_code=404,
                detail="Team not found in Kind table"
            )
        
        # Get corresponding team
        team = db.query(Team).filter(
            Team.k_id == k_team.id,
            Team.user_id == user_id,
            Team.is_active == True
        ).first()
        
        if not team:
            raise HTTPException(
                status_code=404,
                detail="Team not found for k_team"
            )
        
        # Get workspace reference from task json
        workspace_ref = k_task_json.get('spec', {}).get('workspaceRef', {})
        workspace_ref_name = workspace_ref.get('name')
        workspace_ref_namespace = workspace_ref.get('namespace', 'default')
        
        # Get k_workspace from Kind table
        k_workspace = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Workspace',
            Kind.name == workspace_ref_name,
            Kind.namespace == workspace_ref_namespace,
            Kind.is_active == True
        ).first()
        
        if not k_workspace:
            raise HTTPException(
                status_code=404,
                detail="Workspace not found in Kind table"
            )
            
        # Extract workspace data from json
        k_workspace_json = k_workspace.json
        workspace_spec = k_workspace_json.get('spec', {})
        repository = workspace_spec.get('repository', {})
        
        # Get user
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=404,
                detail="User not found"
            )
        
        # Check if task already exists for this k_task using k_id
        existing_task = db.query(Task).filter(
            Task.k_id == k_task_id,
            Task.user_id == user_id,
            Task.status != TaskStatus.DELETE
        ).first()
        
        # Get git_repo_id (moved outside if to avoid code duplication)
        github_provider = GitHubProvider()
        git_repo_id = 0  # Default value
        try:
            # Use new method to get repo_id
            git_domain = repository.get('gitDomain', '')
            git_repo = repository.get('gitRepo', '')
            if git_domain == "github.com" and git_repo:
                git_repo_id = github_provider.get_repo_id_by_fullname(user, git_repo) or 0
        except Exception as e:
            print(f"Error getting repo_id for {git_repo}: {str(e)}")
        
        if existing_task:
            # Update existing task
            task_update = TaskUpdate(
                k_id=k_task_id,
                title=k_task_json.get('spec', {}).get('title', ''),
                prompt=k_task_json.get('spec', {}).get('prompt', ''),
                team_id=team.id,
                git_url=repository.get('gitUrl', ''),
                git_repo=repository.get('gitRepo', ''),
                git_repo_id=git_repo_id,  # Use the obtained repo_id
                git_domain=repository.get('gitDomain', ''),
                branch_name=repository.get('branchName', '')
            )
            return self.update_with_user(
                db=db,
                task_id=existing_task.id,
                obj_in=task_update,
                user_id=user_id
            )
        else:
            # Create new task
            task_create = TaskCreate(
                k_id=k_task_id,
                title=k_task_json.get('spec', {}).get('title', ''),
                prompt=k_task_json.get('spec', {}).get('prompt', ''),
                team_id=team.id,
                git_url=repository.get('gitUrl', ''),
                git_repo=repository.get('gitRepo', ''),
                git_repo_id=git_repo_id,  # Use the obtained repo_id
                git_domain=repository.get('gitDomain', ''),
                branch_name=repository.get('branchName', '')
            )

        return self.create_with_user(
                db=db,
                obj_in=task_create,
                user=user
            )

    def _create_subtasks_from_team(self, db: Session, task: Task, team: Team, user_id: int) -> None:
        """
        Create subtasks based on team's workflow configuration
        """
        from app.services.team import team_service
        
        # Get bot info from team.bots JSON
        if not team.bots:
            raise HTTPException(
                status_code=400,
                detail="No bots configured in team"
            )
            
        try:
            bot_id_list = [bot['bot_id'] for bot in team.bots]
        except (KeyError, TypeError):
            raise HTTPException(
                status_code=400,
                detail="Invalid bots format in team configuration"
            )
        
        # Validate all bots exist, belong to user and are active
        valid_bot_ids = {
            bot.id for bot in db.query(Bot.id).filter(
                Bot.id.in_(bot_id_list),
                Bot.user_id == user_id,
                Bot.is_active == True
            ).all()
        }
        
        if not all(bot_id in valid_bot_ids for bot_id in bot_id_list):
            raise HTTPException(
                status_code=400,
                detail="Some bots in team configuration are invalid or inactive"
            )
            
        # Create simple subtasks based on bots
        for index, bot_info in enumerate(team.bots):
            bot = db.query(Bot).filter(
                Bot.id == bot_info['bot_id'],
                Bot.user_id == user_id,
                Bot.is_active == True
            ).first()
            
            if not bot:
                continue
                
            subtask = Subtask(
                user_id=user_id,
                task_id=task.id,
                team_id=team.id,
                title=f"{task.title} - {bot.name}",
                bot_id=bot.id,
                prompt=bot_info.get('bot_prompt'),
                status=SubtaskStatus.PENDING,
                progress=0,
                batch=0,
                sort_order=index
            )
            
            db.add(subtask)
        
        db.commit()

    def get_user_tasks(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> List[Task]:
        """
        Get user's task list, excluding DELETE status tasks
        """
        return db.query(Task).filter(
            Task.user_id == user_id,
            Task.status != TaskStatus.DELETE
        ).order_by(Task.created_at.desc()).offset(skip).limit(limit).all()

    def get_user_tasks_count(
        self, db: Session, *, user_id: int
    ) -> int:
        """
        Get total count of user's tasks, excluding DELETE status tasks
        """
        return db.query(func.count(Task.id)).filter(
            Task.user_id == user_id,
            Task.status != TaskStatus.DELETE
        ).scalar()

    def get_user_tasks_with_pagination(
        self, db: Session, *, user_id: int, skip: int = 0, limit: int = 100
    ) -> Tuple[List[Task], int]:
        """
        Get user's task list with pagination and total count, excluding DELETE status tasks
        """
        query = db.query(Task).filter(
            Task.user_id == user_id,
            Task.status != TaskStatus.DELETE
        )
        
        total = query.with_entities(func.count(Task.id)).scalar()
        items = query.order_by(Task.created_at.desc()).offset(skip).limit(limit).all()
        
        return items, total

    def get_by_id_and_user(
        self, db: Session, *, task_id: int, user_id: int, include_relations: bool = False
    ) -> Optional[Task]:
        """
        Get task by ID and user ID
        
        Args:
            db: Database session
            task_id: Task ID
            user_id: User ID
            include_relations: Whether to include related entities (user, team, subtasks)
        """
        task = db.query(Task).filter(
            Task.id == task_id,
            Task.user_id == user_id
        ).first()
        
        if not task:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )
            
        return task
    
    def get_task_detail(
        self, db: Session, *, task_id: int, user_id: int
    ) -> dict:
        """
        Get detailed task information including related entities
        """
        from app.services.subtask import subtask_service
        from app.schemas.bot import BotInDB
        
        # Get the basic task
        task = self.get_by_id_and_user(db, task_id=task_id, user_id=user_id)
        
        # Get related user
        user = db.query(User).filter(User.id == task.user_id).first()
        
        # Get related team
        team = db.query(Team).filter(Team.id == task.team_id).first()
        
        # Get related subtasks
        subtasks = subtask_service.get_by_task(
            db=db,
            task_id=task_id,
            user_id=user_id
        )
        
        # Get all bot objects for the subtasks
        bot_ids = [subtask.bot_id for subtask in subtasks if subtask.bot_id]
        bots = {}
        if bot_ids:
            bot_objects = db.query(Bot).filter(Bot.id.in_(bot_ids)).all()
            # Convert bot objects to dict using Pydantic schema
            for bot in bot_objects:
                bot_schema = BotInDB.model_validate(bot)
                bots[bot.id] = bot_schema.model_dump()
        
        # Convert subtasks to dict and replace bot_id with bot object
        subtasks_dict = []
        for subtask in subtasks:
            # Convert subtask to dict
            subtask_dict = {
                # Subtask base fields
                "id": subtask.id,
                "task_id": subtask.task_id,
                "team_id": subtask.team_id,
                "title": subtask.title,
                "bot_id": subtask.bot_id,  # Keep bot_id for compatibility
                "prompt": subtask.prompt,
                "executor_namespace": subtask.executor_namespace,
                "executor_name": subtask.executor_name,
                "sort_order": subtask.sort_order,
                "status": subtask.status,
                "progress": subtask.progress,
                "batch": subtask.batch,
                "result": subtask.result,
                "error_message": subtask.error_message,
                "user_id": subtask.user_id,
                "created_at": subtask.created_at,
                "updated_at": subtask.updated_at,
                "completed_at": subtask.completed_at,
                # Add bot object as dict
                "bot": bots.get(subtask.bot_id) if subtask.bot_id else None
            }
            subtasks_dict.append(subtask_dict)
        
        # Convert to dict to allow adding related entities
        task_dict = {
            # Task base fields
            "id": task.id,
            "title": task.title,
            "git_url": task.git_url,
            "git_repo": task.git_repo,
            "git_repo_id": task.git_repo_id,
            "git_domain": task.git_domain,
            "branch_name": task.branch_name,
            "prompt": task.prompt,
            "status": task.status,
            "progress": task.progress,
            "batch": task.batch,
            "result": task.result,
            "error_message": task.error_message,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
            "completed_at": task.completed_at,
            
            # Related entities
            "user": user,
            "team": team,
            "subtasks": subtasks_dict
        }
        
        return task_dict

    def update_with_user(
        self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int
    ) -> Task:
        """
        Update user task
        """
        task = self.get_by_id_and_user(db, task_id=task_id, user_id=user_id)
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
        
        for field, value in update_data.items():
            setattr(task, field, value)
        
        db.add(task)
        db.commit()
        db.refresh(task)
        return task

    def delete_with_user(
        self, db: Session, *, task_id: int, user_id: int
    ) -> None:
        """
        Delete user task and handle running subtasks
        """
        task = self.get_by_id_and_user(db, task_id=task_id, user_id=user_id)
        if not task:
            raise HTTPException(
                status_code=404,
                detail="Task not found"
            )
        
        # Get all running subtasks
        running_subtasks = db.query(Subtask).filter(
            Subtask.task_id == task_id,
            Subtask.status.in_([SubtaskStatus.RUNNING, SubtaskStatus.PENDING])
        ).all()
        
        # Stop running subtasks on executor
        for subtask in running_subtasks:
            if subtask.executor_name:
                try:
                    import asyncio
                    from app.services.executor import executor_service
                    
                    # Run async delete_executor_task in sync context
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        loop.run_until_complete(
                            executor_service.delete_executor_task(subtask.executor_name)
                        )
                    finally:
                        loop.close()
                except Exception as e:
                    # Log error but continue with status update
                    print(f"Warning: Failed to delete executor task {subtask.executor_name}: {str(e)}")
        
        # Update all subtasks to DELETE status
        db.query(Subtask).filter(Subtask.task_id == task_id).update({
            Subtask.status: SubtaskStatus.DELETE,
            Subtask.updated_at: datetime.utcnow()
        })
        
        # Update task status to DELETE instead of deleting from database
        task.status = TaskStatus.DELETE
        task.updated_at = datetime.utcnow()
        db.add(task)
        db.commit()


    def get_session_id(self, db: Session) -> int:
        """
        Get a session id from session table
        """
        from sqlalchemy import text
        session_result = db.execute(text("INSERT INTO session () VALUES ()"))
        db.commit()
        return session_result.lastrowid

    def create_task_id(self, db: Session) -> int:
        """
        Create new task id with session id
        """
        session_id = self.get_session_id(db)
        return session_id


task_service = TaskService(Task)