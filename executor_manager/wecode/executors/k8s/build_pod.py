# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
import os
import yaml
from jinja2 import Environment, FileSystemLoader

from executor_manager.config.config import EXECUTOR_ENV

def to_nice_yaml(value, indent=2):
    if isinstance(value, dict) and "name" in value:
        value = {k: v for k, v in value.items() if k != "name"}
    return yaml.dump(
        value,
        default_flow_style=False,
        indent=indent,
        sort_keys=False
    ).rstrip()

def build_pod_configuration(
    username, executor_name, namespace, task, image, task_id, mode
):
    """
    Build Kubernetes pod configuration using YAML template

    Args:
        username: Username for the pod
        executor_name: Name for the Kubernetes pod
        namespace: Namespace for the pod
        task_str: Task information string
        image: Container image to use
        task_id: ID of the task
        mode: Team mode

    Returns:
        dict: Kubernetes pod configuration
    """
    # Get the directory where this file is located
    current_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Setup Jinja2 environment
    env = Environment(loader=FileSystemLoader(current_dir))
    env.filters["to_nice_yaml"] = to_nice_yaml

    # Load the template
    template = env.get_template('pod_template.yaml')
    
    volumes_info = build_pod_volumes(task)
    # Prepare template parameters
    template_params = {
        'username': username,
        'executor_name': executor_name,
        'namespace': namespace,
        'task_str': json.dumps(task),
        'image': image,
        'task_id': task_id,
        'mode': mode,
        'executor_env': EXECUTOR_ENV,
        'volumes': volumes_info.get("volumes", []),
        'volume_mounts': volumes_info.get("volume_mounts", [])
    }
    
    # Render the template
    rendered_yaml = template.render(**template_params)
    
    # Parse YAML back to dictionary
    pod_config = yaml.safe_load(rendered_yaml)
    
    return pod_config

def build_pod_volumes(task):
        """
        Build Kubernetes pod volumes configuration for Git SSH access
        
        Args:
            task: Task dictionary containing user information
            
        Returns:
            dict: Volume mounts and volumes configuration
        """
        user_info = task.get("user", {})
        user_name = user_info.get("name", "").replace("_", "--")
        git_domain = user_info.get("git_domain", "")
        
        # Supported Git domains
        supported_domains = ["git.intra.weibo.com", "git.staff.sina.com.cn", "gitlab.weibo.cn"]
        
        if git_domain in supported_domains:
            # Base volume mounts (id_rsa.pub is always needed)
            volume_mounts = [
                {
                    "mountPath": "/root/.ssh/id_rsa.pub",
                    "name": "git-ssh",
                    "readOnly": True,
                    "subPath": "id_rsa.pub",
                }
            ]
            
            # Add domain-specific SSH config
            volume_mounts.append({
                "mountPath": f"/root/.ssh/{git_domain}",
                "name": "git-ssh",
                "readOnly": True,
                "subPath": git_domain,
            })
            
            return {
                "volume_mounts": volume_mounts,
                "volumes": [
                    {
                        "name": "git-ssh",
                        "secret": {
                            "defaultMode": 400,
                            "secretName": f"wecode-secret-{user_name}",
                        },
                    }
                ],
            }
        else:
            return {}
