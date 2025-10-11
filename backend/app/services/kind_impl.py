# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Implementation of specific Kind services
"""
from typing import Dict, Any, Optional, List
from sqlalchemy.orm import Session
from datetime import datetime

from app.models.kind import Kind, KGhost, KModel, KShell, KBot, KTeam, KWorkspace, KTask
from app.models.bot import Bot
from app.models.task import Task
from app.models.subtask import Subtask
from app.core.exceptions import NotFoundException
from app.services.kind_base import KindBaseService


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
        # Check if referenced ghost exists
        ghost_name = resource['spec']['ghostRef']['name']
        ghost_namespace = resource['spec']['ghostRef'].get('namespace', 'default')
        
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
        shell_name = resource['spec']['shellRef']['name']
        shell_namespace = resource['spec']['shellRef'].get('namespace', 'default')
        
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
        model_name = resource['spec']['modelRef']['name']
        model_namespace = resource['spec']['modelRef'].get('namespace', 'default')
        
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
    
    def _perform_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Create entry in bots table for compatibility"""
        ghost_name = resource['spec']['ghostRef']['name']
        ghost_namespace = resource['spec']['ghostRef'].get('namespace', 'default')
        shell_name = resource['spec']['shellRef']['name']
        shell_namespace = resource['spec']['shellRef'].get('namespace', 'default')
        model_name = resource['spec']['modelRef']['name']
        model_namespace = resource['spec']['modelRef'].get('namespace', 'default')
        
        # Get ghost and shell data
        ghost_data = self._get_ghost_data(db, user_id, ghost_name, ghost_namespace)
        shell_data = self._get_shell_data(db, user_id, shell_name, shell_namespace)
        
        # Get model data directly from Bot's modelRef
        model_data = self._get_model_data(db, user_id, model_name, model_namespace)
        
        # Create bot entry
        if ghost_data and shell_data:
            # Create bot entry
            bot_entry = Bot(
                user_id=user_id,
                k_id=db_resource.id,
                name=resource['metadata']['name'],
                agent_name=shell_data.get('spec', {}).get('runtime'),
                agent_config=model_data.get('spec', {}).get('modelConfig'),
                system_prompt=ghost_data.get('spec', {}).get('systemPrompt'),
                mcp_servers=ghost_data.get('spec', {}).get('mcpServers')
            )
            
            db.add(bot_entry)
            db.commit()
    
    def _update_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Update entry in bots table for compatibility"""
        bot_entry = db.query(Bot).filter(
            Bot.user_id == user_id,
            Bot.k_id == db_resource.id,
            Bot.is_active == True
        ).first()
        
        if bot_entry:
            ghost_name = resource['spec']['ghostRef']['name']
            ghost_namespace = resource['spec']['ghostRef'].get('namespace', 'default')
            shell_name = resource['spec']['shellRef']['name']
            shell_namespace = resource['spec']['shellRef'].get('namespace', 'default')
            model_name = resource['spec']['modelRef']['name']
            model_namespace = resource['spec']['modelRef'].get('namespace', 'default')
            
            # Get ghost and shell data
            ghost_data = self._get_ghost_data(db, user_id, ghost_name, ghost_namespace)
            shell_data = self._get_shell_data(db, user_id, shell_name, shell_namespace)
            
            # Get model data directly from Bot's modelRef
            model_data = self._get_model_data(db, user_id, model_name, model_namespace)
            
            # Update bot entry
            if ghost_data and shell_data:
                # Update bot entry
                bot_entry.name = resource['metadata']['name']
                bot_entry.agent_name = shell_data.get('spec', {}).get('runtime')
                bot_entry.agent_config = model_data.get('spec', {}).get('modelConfig')
                bot_entry.system_prompt = ghost_data.get('spec', {}).get('systemPrompt')
                bot_entry.mcp_servers = ghost_data.get('spec', {}).get('mcpServers')
                
                db.commit()
    
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
        # Check if all referenced bots exist
        members = resource['spec']['members']
        for member in members:
            bot_name = member['botRef']['name']
            bot_namespace = member['botRef'].get('namespace', 'default')
            
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
        
        # Validate  pipeline workflow configuration
        collaboration_model = resource['spec']['collaborationModel']
        self._validate_pipeline_workflow(members, collaboration_model)
    
    def _validate_pipeline_workflow(self, members: List[Dict[str, Any]], collaboration_model: Dict[str, Any]) -> None:
        """Validate  pipeline workflow configuration"""
        if collaboration_model.get('name') == 'pipeline':
            config = collaboration_model.get('config')
            if not config or 'workflow' not in config:
                raise NotFoundException(
                    "pipeline collaboration model requires config.workflow"
                )
            
            workflow = config['workflow']
            if not isinstance(workflow, list):
                raise NotFoundException(
                    "config.workflow must be a list"
                )
            
            # Get all member names
            member_names = {member['name'] for member in members}
            
            # Validate each step
            for step in workflow:
                if not isinstance(step, dict):
                    raise NotFoundException(
                        "Each workflow step must be a dictionary"
                    )
                
                step_name = step.get('step')
                next_step = step.get('nextStep', '')
                
                if step_name not in member_names:
                    raise NotFoundException(
                        f"Workflow step '{step_name}' not found in team members"
                    )
                
                if next_step and next_step not in member_names:
                    raise NotFoundException(
                        f"Workflow nextStep '{next_step}' not found in team members"
                    )
    
    def _perform_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Create or update corresponding legacy team"""
        try:
            from app.services.team import team_service as legacy_team_service
            legacy_team_service.create_or_update_by_k_team_id(
                db=db,
                k_team_id=db_resource.id,
                user_id=user_id
            )
        except Exception as e:
            # Log error but don't interrupt the process
            print(f"Error creating legacy team: {str(e)}")
    
    def _update_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Update corresponding legacy team"""
        try:
            from app.services.team import team_service as legacy_team_service
            legacy_team_service.create_or_update_by_k_team_id(
                db=db,
                k_team_id=db_resource.id,
                user_id=user_id
            )
        except Exception as e:
            # Log error but don't interrupt the process
            print(f"Error updating legacy team: {str(e)}")


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
        # Check if referenced team exists
        team_name = resource['spec']['teamRef']['name']
        team_namespace = resource['spec']['teamRef'].get('namespace', 'default')
        
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
        workspace_name = resource['spec']['workspaceRef']['name']
        workspace_namespace = resource['spec']['workspaceRef'].get('namespace', 'default')
        
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
    
    def _perform_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Create or update corresponding legacy task"""
        try:
            from app.services.task import task_service as legacy_task_service
            legacy_task_service.create_or_update_by_k_task_id(
                db=db,
                k_task_id=db_resource.id,
                user_id=user_id
            )
        except Exception as e:
            # Log error but don't interrupt the process
            print(f"Error creating legacy task: {str(e)}")
    
    def _update_side_effects(self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]) -> None:
        """Update corresponding legacy task"""
        try:
            from app.services.task import task_service as legacy_task_service
            legacy_task_service.create_or_update_by_k_task_id(
                db=db,
                k_task_id=db_resource.id,
                user_id=user_id
            )
        except Exception as e:
            # Log error but don't interrupt the process
            print(f"Error updating legacy task: {str(e)}")
    
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
        
        # Build enhanced status field
        status = {
            'state': 'PENDING',
            'progress': 0,
            'result': None,
            'errorMessage': None,
            'startedAt': None,
            'completedAt': None,
            'subTasks': []
        }
        
        # Get database connection
        with self.get_db() as db:
            # Query corresponding Task based on Kind id
            task = db.query(Task).filter(Task.k_id == resource.id).first()
            
            # If corresponding Task is found, update status fields
            if task:
                status['state'] = task.status
                status['progress'] = task.progress
                status['result'] = task.result
                status['errorMessage'] = task.error_message
                status['startedAt'] = task.created_at
                status['completedAt'] = task.completed_at
                
                # Query all Subtasks for this Task
                subtasks = db.query(Subtask).filter(
                    Subtask.task_id == task.id
                ).order_by(Subtask.message_id.asc()).all()
                
                # Build subtasks array
                subtask_list = []
                for subtask in subtasks:
                    subtask_list.append({
                        'title': subtask.title,
                        'state': subtask.status,
                        'progress': subtask.progress,
                        'result': subtask.result
                    })
                
                status['subTasks'] = subtask_list
        
        # Update status in result
        result['status'] = status
        
        return result