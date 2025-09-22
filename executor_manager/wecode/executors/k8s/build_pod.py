import os
import yaml
from jinja2 import Environment, FileSystemLoader
import sys
import os

from executor_manager.config.config import EXECUTOR_ENV


def build_pod_configuration(
    username, executor_name, namespace, task_str, image, task_id, mode
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
    
    # Load the template
    template = env.get_template('pod_template.yaml')
    
    # Prepare template parameters
    template_params = {
        'username': username,
        'executor_name': executor_name,
        'namespace': namespace,
        'task_str': task_str,
        'image': image,
        'task_id': task_id,
        'mode': mode,
        'executor_env': EXECUTOR_ENV
    }
    
    # Render the template
    rendered_yaml = template.render(**template_params)
    
    # Parse YAML back to dictionary
    pod_config = yaml.safe_load(rendered_yaml)
    
    return pod_config
