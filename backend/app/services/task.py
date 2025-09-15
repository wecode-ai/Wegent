# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import List, Optional, Tuple, Dict
import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.repository.github_provider import GitHubProvider

from app.models.task import Task, TaskStatus
from app.models.team import Team
from app.models.bot import Bot
from app.models.user import User
from app.models.subtask import Subtask, SubtaskStatus, SubtaskRole
from app.schemas.task import TaskCreate, TaskUpdate, TaskInDB
from app.services.base import BaseService
from app.services.subtask import subtask_service
from app.services.team import team_service
from app.core.config import settings


class TaskService(BaseService[Task, TaskCreate, TaskUpdate]):
    """
    Task service class
    """

    def create_task_or_append(
        self, db: Session, *, obj_in: TaskCreate, user: User, task_id: Optional[int] = None
    ) -> Task:
        """
        Create user task and automatically create subtasks based on team configuration
        """
        task = None
        team = None

        # Limit running tasks per user
        running_count = db.query(Task).filter(
            Task.user_id == user.id,
            Task.status.in_([TaskStatus.PENDING, TaskStatus.RUNNING])
        ).count()
        if running_count >= settings.MAX_RUNNING_TASKS_PER_USER:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum number of running tasks per user ({settings.MAX_RUNNING_TASKS_PER_USER}) exceeded."
            )

        # 设置任务ID
        if task_id is None:
            task_id = self.create_task_id(db)
        else:
            # 验证task_id是否有效
            if not self.validate_task_id(db, task_id):
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid task_id: {task_id} does not exist in session"
                )
        
        # 查询是否已存在
        existing_task = db.query(Task).filter(Task.id == task_id).first()
        if existing_task:
            # 追加任务
            # 如果任务正在运行，则不允许更新
            if existing_task.status != TaskStatus.COMPLETED:
                raise HTTPException(
                    status_code=400,
                    detail="Task is still running, please wait for it to complete"
                )
            
            # Check if task is expired
            expire_hours = settings.APPEND_TASK_EXPIRE_HOURS
            if (datetime.utcnow() - existing_task.updated_at).total_seconds() > expire_hours * 3600:
                raise HTTPException(
                    status_code=400,
                    detail=f"Task has expired. You can only append tasks within {expire_hours} hours after last update."
                )

            # 更新现有任务状态为PENDING
            existing_task.status = TaskStatus.PENDING
            existing_task.progress = 0
            task = existing_task

            # Validate team exists and belongs to user
            existing_team = db.query(Team).filter(
                Team.id == existing_task.team_id,
                Team.user_id == user.id
            ).first()
            if not existing_team:
                raise HTTPException(
                    status_code=404,
                    detail="Team not found"
                )
            team = existing_team
        else:
            # 首次创建新任务
            # 必须输入team_id
            if not obj_in.team_id:
                raise HTTPException(
                    status_code=400,
                    detail="Team ID is required for creating a new task."
                )
            
            # Validate team exists and belongs to user
            existing_team = db.query(Team).filter(
                Team.id == obj_in.team_id,
                Team.user_id == user.id
            ).first()
            if not existing_team:
                raise HTTPException(
                    status_code=404,
                    detail="Team not found"
                )
            team = existing_team
            
            # Additional business validation for prompt length
            if obj_in.prompt and len(obj_in.prompt.encode('utf-8')) > 60000:
                raise HTTPException(
                    status_code=400,
                    detail="Prompt content is too long. Maximum allowed size is 60000 bytes in UTF-8 encoding."
                )
            # git相关信息默认值
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
        
        # 如果不存在，则创建新任务
        if task is None:
            # 准备任务数据
            task_data = {
                "id": task_id,
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
            }
            
            # 创建并添加新任务
            task = Task(**task_data)
            db.add(task)

        # Create subtasks for the task
        self._create_subtasks(db, task, team, user.id, obj_in.prompt)

        db.commit()
        db.refresh(task)
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
            return self.update_task(
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

        return self.create_task_or_append(
                db=db,
                obj_in=task_create,
                user=user
            )

    def _create_subtasks(self, db: Session, task: Task, team: Team, user_id: int, userPrompt: str) -> None:
        """
        Create subtasks based on team's workflow configuration
        """

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

        bot_ids = [bot["bot_id"] for bot in team.bots]
        # Create USER role subtask based on task object
        user_subtask = Subtask(
            user_id=user_id,
            task_id=task.id,
            team_id=team.id,
            title=f"{task.title} - User",
            bot_ids=bot_ids,
            role=SubtaskRole.USER,
            prompt=userPrompt,
            status=SubtaskStatus.COMPLETED,
            progress=0,
            message_id=next_message_id,
            parent_id=parent_id,
        )
        db.add(user_subtask)

        # update id of next message and parent
        if parent_id is None :
            parent_id = 1
        next_message_id = next_message_id + 1

        executor_name = ""
        executor_namespace = ""
        # Create ASSISTANT role subtask based on task object
        if team.workflow.get('mode') == "pipeline":
            executor_infos = self._get_pipeline_executor_info(existing_subtasks)
            for i, bot_info in enumerate(team.bots):
                bot = db.query(Bot).filter(
                    Bot.id == bot_info.get('bot_id'),
                    Bot.user_id == user_id,
                    Bot.is_active == True
                ).first()
                
                subtask = Subtask(
                    user_id=user_id,
                    task_id=task.id,
                    team_id=team.id,
                    title=f"{task.title} - {bot.name}",
                    bot_ids=[bot.id],
                    role=SubtaskRole.ASSISTANT,
                    prompt=bot_info.get('bot_prompt'),
                    status=SubtaskStatus.PENDING,
                    progress=0,
                    message_id=next_message_id,
                    parent_id=parent_id,
                    # 如果executor_infos 不是空，则取i个，否则是空字符串
                    executor_name=executor_infos[i].get('executor_name') if len(executor_infos) > 0 else "",
                    executor_namespace=executor_infos[i].get('executor_namespace') if len(executor_infos) > 0 else ""
                )

                # update id of next message and parent
                next_message_id = next_message_id + 1
                parent_id = parent_id + 1
                
                db.add(subtask)
        else :
            if existing_subtasks:
                #取 existing_subtasks 最后一个的executor_name 和 executor_namespace
                executor_name = existing_subtasks[0].executor_name
                executor_namespace = existing_subtasks[0].executor_namespace
            assistant_subtask = Subtask(
                user_id=user_id,
                task_id=task.id,
                team_id=team.id,
                title=f"{task.title} - Assistant",
                bot_ids=bot_ids,
                role=SubtaskRole.ASSISTANT,
                prompt="",
                status=SubtaskStatus.PENDING,
                progress=0,
                message_id=next_message_id,
                parent_id=parent_id,
                executor_name = executor_name,
                executor_namespace = executor_namespace
            )
            db.add(assistant_subtask)

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

    def get_task_by_id(
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
        task = self.get_task_by_id(db, task_id=task_id, user_id=user_id)
        
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
        all_bot_ids = set()
        for subtask in subtasks:
            if subtask.bot_ids:
                all_bot_ids.update(subtask.bot_ids)
        
        bots = {}
        if all_bot_ids:
            bot_objects = db.query(Bot).filter(Bot.id.in_(list(all_bot_ids))).all()
            # Convert bot objects to dict using Pydantic schema
            for bot in bot_objects:
                bot_schema = BotInDB.model_validate(bot)
                bots[bot.id] = bot_schema.model_dump()
        
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

    def update_task(
        self, db: Session, *, task_id: int, obj_in: TaskUpdate, user_id: int
    ) -> Task:
        """
        Update user task
        """
        task = self.get_task_by_id(db, task_id=task_id, user_id=user_id)
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

    def delete_task(
        self, db: Session, *, task_id: int, user_id: int
    ) -> None:
        """
        Delete user task and handle running subtasks
        """
        task = self.get_task_by_id(db, task_id=task_id, user_id=user_id)
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

    def validate_task_id(self, db: Session, task_id: int) -> bool:
        """
        Validate that task_id exists in session table
        """
        from sqlalchemy import text
        session_exists = db.execute(
            text("SELECT 1 FROM session WHERE id = :task_id"),
            {"task_id": task_id}
        ).fetchone()
        
        return session_exists is not None

    def _get_pipeline_executor_info(self, existing_subtasks: List[Subtask]) -> List[Dict[str, str]]:
        first_group_assistants = []
        for s in existing_subtasks:
            if s.role == SubtaskRole.USER:
                break
            if s.role == SubtaskRole.ASSISTANT:
                first_group_assistants.append({"executor_namespace": s.executor_namespace, "executor_name": s.executor_name})

        first_group_assistants.reverse()
        return first_group_assistants


task_service = TaskService(Task)