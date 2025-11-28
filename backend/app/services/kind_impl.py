# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Implementation of specific Kind services
"""
import logging
from typing import Dict, Any
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.core.exceptions import NotFoundException
from app.services.kind_base import KindBaseService
from app.services.adapters.task_kinds import task_kinds_service
from app.schemas.kind import Bot, Team, Task

logger = logging.getLogger(__name__)

class GhostKindService(KindBaseService):
    """Service for Ghost resources"""
    
    def __init__(self):
        super().__init__("Ghost")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """No references to validate for Ghost"""
        pass


class ModelKindService(KindBaseService):
    """Service for Model resources"""
    
    def __init__(self):
        super().__init__("Model")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """No references to validate for Model"""
        pass


class ShellKindService(KindBaseService):
    """Service for Shell resources"""
    
    def __init__(self):
        super().__init__("Shell")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """No references to validate for Shell"""
        pass


class BotKindService(KindBaseService):
    """Service for Bot resources"""
    
    def __init__(self):
        super().__init__("Bot")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """Validate Ghost, Shell, and Model references"""
        bot_crd = Bot.model_validate(resource)
        
        # Check if referenced ghost exists
        ghost_name = bot_crd.spec.ghostRef.name
        ghost_namespace = bot_crd.spec.ghostRef.namespace or 'default'
        
        ghost = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Ghost',
            Kind.namespace == ghost_namespace,
            Kind.name == ghost_name,
            Kind.is_active == True
        ).first()
        if not ghost:
            raise NotFoundException(
                f"Ghost '{ghost_name}' not found in namespace '{ghost_namespace}'"
            )
        
        # Check if referenced shell exists
        shell_name = bot_crd.spec.shellRef.name
        shell_namespace = bot_crd.spec.shellRef.namespace or 'default'
        
        shell = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Shell',
            Kind.namespace == shell_namespace,
            Kind.name == shell_name,
            Kind.is_active == True
        ).first()
        if not shell:
            raise NotFoundException(
                f"Shell '{shell_name}' not found in namespace '{shell_namespace}'"
            )
        
        # Check if referenced model exists
        model_name = bot_crd.spec.modelRef.name
        model_namespace = bot_crd.spec.modelRef.namespace or 'default'
        
        model = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Model',
            Kind.namespace == model_namespace,
            Kind.name == model_name,
            Kind.is_active == True
        ).first()
        if not model:
            raise NotFoundException(
                f"Model '{model_name}' not found in namespace '{model_namespace}'"
            )
    
    def _get_ghost_data(self, db: Session, user_id: int, name: str, namespace: str) -> Dict[str, Any]:
        """Get ghost data from Kind table"""
        ghost = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Ghost',
            Kind.namespace == namespace,
            Kind.name == name,
            Kind.is_active == True
        ).first()
        
        return ghost.json
    
    def _get_shell_data(self, db: Session, user_id: int, name: str, namespace: str) -> Dict[str, Any]:
        """Get shell data from Kind table"""
        shell = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Shell',
            Kind.namespace == namespace,
            Kind.name == name,
            Kind.is_active == True
        ).first()
        
        return shell.json
    
    def _get_model_data(self, db: Session, user_id: int, name: str, namespace: str) -> Dict[str, Any]:
        """Get model data from Kind table"""
        model = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Model',
            Kind.namespace == namespace,
            Kind.name == name,
            Kind.is_active == True
        ).first()
        
        return model.json


class TeamKindService(KindBaseService):
    """Service for Team resources"""
    
    def __init__(self):
        super().__init__("Team")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """Validate Bot references and workflow configuration"""
        team_crd = Team.model_validate(resource)
        
        # Check if all referenced bots exist
        for member in team_crd.spec.members:
            bot_name = member.botRef.name
            bot_namespace = member.botRef.namespace or 'default'
            
            bot = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == 'Bot',
                Kind.namespace == bot_namespace,
                Kind.name == bot_name,
                Kind.is_active == True
            ).first()
            
            if not bot:
                raise NotFoundException(
                    f"Bot '{bot_name}' not found in namespace '{bot_namespace}'"
                )
        
class WorkspaceKindService(KindBaseService):
    """Service for Workspace resources"""
    
    def __init__(self):
        super().__init__("Workspace")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """No references to validate for Workspace"""
        pass


class TaskKindService(KindBaseService):
    """Service for Task resources"""
    
    def __init__(self):
        super().__init__("Task")
    
    def _validate_references(self, db: Session, user_id: int, resource: Dict[str, Any]) -> None:
        """Validate Team and Workspace references"""
        task_crd = Task.model_validate(resource)
        
        # Check if referenced team exists
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace or 'default'
        
        team = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Team',
            Kind.namespace == team_namespace,
            Kind.name == team_name,
            Kind.is_active == True
        ).first()
        
        if not team:
            raise NotFoundException(
                f"Team '{team_name}' not found in namespace '{team_namespace}'"
            )
        
        # Check if referenced workspace exists
        workspace_name = task_crd.spec.workspaceRef.name
        workspace_namespace = task_crd.spec.workspaceRef.namespace or 'default'
        
        workspace = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Workspace',
            Kind.namespace == workspace_namespace,
            Kind.name == workspace_name,
            Kind.is_active == True
        ).first()
        
        if not workspace:
            raise NotFoundException(
                f"Workspace '{workspace_name}' not found in namespace '{workspace_namespace}'"
            )
        
        # Check the status of existing task, if not COMPLETED status, modification is not allowed
        existing_task = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == 'Task',
            Kind.namespace == resource['metadata']['namespace'],
            Kind.name == resource['metadata']['name'],
            Kind.is_active == True
        ).first()
        
        if existing_task:
            existing_task_crd = Task.model_validate(existing_task.json)
            
            if existing_task_crd.status and existing_task_crd.status.status != "COMPLETED":
                raise NotFoundException(
                    f"Task '{resource['metadata']['name']}' in namespace '{resource['metadata']['namespace']}' cannot be modified when status is '{existing_task_crd.status.status}'. Only COMPLETED tasks can be updated."
                )
    
    
    def _perform_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Create subtasks for the new task"""
        try:
            task_crd = Task.model_validate(resource)
            
            team = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == 'Team',
                Kind.name == task_crd.spec.teamRef.name,
                Kind.namespace == task_crd.spec.teamRef.namespace,
                Kind.is_active == True
            ).first()
            
            if not team:
                logger.error(f"Team not found: {task_crd.spec.teamRef.name}")
                return
            
            # Call _create_subtasks method to create subtasks
            task_kinds_service._create_subtasks(
                db=db,
                task=db_resource,
                team=team,
                user_id=user_id,
                user_prompt=task_crd.spec.prompt
            )
            db.commit()
                
        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error creating subtasks: {str(e)}")
    
    def _update_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Update subtasks for the existing task"""
        try:
            task_crd = Task.model_validate(resource)
            
            team = db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == 'Team',
                Kind.name == task_crd.spec.teamRef.name,
                Kind.namespace == task_crd.spec.teamRef.namespace,
                Kind.is_active == True
            ).first()
            
            if not team:
                logger.error(f"Team not found: {task_crd.spec.teamRef.name}")
                return
            
            # Call _create_subtasks method to update subtasks (append mode)
            task_kinds_service._create_subtasks(
                db=db,
                task=db_resource,
                team=team,
                user_id=user_id,
                user_prompt=task_crd.spec.prompt
            )
            db.commit()
                
        except Exception as e:
            # Log error but don't interrupt the process
            logger.error(f"Error updating subtasks: {str(e)}")
    
    def _format_resource(self, resource: Kind) -> Dict[str, Any]:
        """Format Task resource for API response with enhanced status information"""
        # Get the stored resource data
        stored_resource = resource.json
        
        # Ensure metadata has the correct name and namespace from the database
        result = stored_resource.copy()
        
        # Update metadata with values from the database (in case they were changed)
        if 'metadata' not in result:
            result['metadata'] = {}
            
        result['metadata']['name'] = resource.name
        result['metadata']['namespace'] = resource.namespace
        
        # Ensure apiVersion and kind are set correctly
        result['apiVersion'] = 'agent.wecode.io/v1'
        result['kind'] = self.kind
        
        # Get database connection
        with self.get_db() as db:
            # Query all Subtasks for this Task
            subtasks = db.query(Subtask).filter(
                Subtask.task_id == resource.id
            ).order_by(Subtask.message_id.asc()).all()
            
            # Build subtasks array
            subtask_list = []
            for subtask in subtasks:
                subtask_list.append({
                    'title': subtask.title,
                    'role': subtask.role,
                    'prompt': subtask.prompt,
                    'bot_ids': subtask.bot_ids,
                    'executor_namespace': subtask.executor_namespace,
                    'executor_name': subtask.executor_name,
                    'status': subtask.status,
                    'progress': subtask.progress,
                    'result': subtask.result,
                    'errorMessage': subtask.error_message,
                    'messageId': subtask.message_id,
                    'parentId': subtask.parent_id,
                    'createdAt': subtask.created_at,
                    'updatedAt': subtask.updated_at,
                    'completedAt': subtask.completed_at
                })
            
            result["status"]['subTasks'] = subtask_list
        
        return result
    
    def _post_delete_side_effects(self, db: Session, user_id: int, db_resource: Kind) -> None:
        """Perform side effects after Task deletion - delegate to task_kinds_service.delete_task"""
        try:
            # Call task_kinds_service's delete_task method to handle cleanup after deletion
            task_kinds_service.delete_task(
                db=db,
                task_id=db_resource.id,
                user_id=user_id
            )
        except Exception as e:
            logger.error(f"Error delegating Task deletion to task_kinds_service: {str(e)}")
    
    def _should_delete_resource(self, db: Session, user_id: int, db_resource: Kind) -> bool:
        return False