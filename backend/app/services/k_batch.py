# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Batch operation service for Kubernetes-style API
"""
from typing import Dict, Any, List
from app.services.kind import kind_service
from app.core.exceptions import ValidationException


class BatchService:
    """Service for batch operations"""
    
    def __init__(self):
        # List of supported resource types
        self.supported_kinds = [
            'Ghost',
            'Model',
            'Shell',
            'Bot',
            'Team',
            'Workspace',
            'Task',
        ]
    
    def apply_resources(self, user_id: int, resources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Apply multiple resources (create or update)"""
        results = []
        
        for resource in resources:
            try:
                kind = resource.get('kind')
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")
                
                if kind not in self.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")
                
                # Check if resource exists
                namespace = resource['metadata']['namespace']
                name = resource['metadata']['name']
                existing = kind_service.get_resource(user_id, kind, namespace, name)
                
                if existing:
                    # Update existing resource
                    resource_id = kind_service.update_resource(user_id, kind, namespace, name, resource)
                    results.append({
                        'kind': kind,
                        'name': name,
                        'namespace': namespace,
                        'operation': 'updated',
                        'success': True
                    })
                else:
                    # Create new resource
                    resource_id = kind_service.create_resource(user_id, kind, resource)
                    results.append({
                        'kind': kind,
                        'name': name,
                        'namespace': namespace,
                        'operation': 'created',
                        'success': True
                    })
                    
            except Exception as e:
                results.append({
                    'kind': kind if 'kind' in locals() else 'unknown',
                    'name': resource.get('metadata', {}).get('name', 'unknown'),
                    'namespace': resource.get('metadata', {}).get('namespace', 'default'),
                    'operation': 'failed',
                    'success': False,
                    'error': str(e)
                })
        
        return results
    
    def delete_resources(self, user_id: int, resources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Delete multiple resources"""
        results = []
        
        for resource in resources:
            try:
                kind = resource.get('kind')
                if not kind:
                    raise ValidationException("Resource must have 'kind' field")
                
                if kind not in self.supported_kinds:
                    raise ValidationException(f"Unsupported resource kind: {kind}")
                
                namespace = resource['metadata']['namespace']
                name = resource['metadata']['name']
                
                kind_service.delete_resource(user_id, kind, namespace, name)
                results.append({
                    'kind': kind,
                    'name': name,
                    'namespace': namespace,
                    'operation': 'deleted',
                    'success': True
                })
                
            except Exception as e:
                results.append({
                    'kind': kind if 'kind' in locals() else 'unknown',
                    'name': resource.get('metadata', {}).get('name', 'unknown'),
                    'namespace': resource.get('metadata', {}).get('namespace', 'default'),
                    'operation': 'failed',
                    'success': False,
                    'error': str(e)
                })
        
        return results


# Create service instance
batch_service = BatchService()