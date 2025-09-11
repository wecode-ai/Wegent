#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Docker executor for running tasks in Docker containers
"""

from email import utils
import json
import os
import subprocess
from typing import Any, Dict, List, Optional, Tuple
import requests
from shared.logger import setup_logger
from shared.status import TaskStatus
from executor_manager.executors.base import Executor
from executor_manager.executors.docker.utils import (
    build_callback_url,
    find_available_port,
    check_container_ownership,
    delete_container,
    get_container_ports,
    get_running_task_details,
)
from executor_manager.executors.docker.constants import (
    CONTAINER_OWNER,
    DEFAULT_DOCKER_HOST,
    DEFAULT_API_ENDPOINT,
    DEFAULT_TIMEZONE,
    DEFAULT_LOCALE,
    DOCKER_SOCKET_PATH,
    WORKSPACE_MOUNT_PATH,
    DEFAULT_PROGRESS_RUNNING,
    DEFAULT_PROGRESS_COMPLETE,
    DEFAULT_TASK_ID,
)

logger = setup_logger(__name__)


class DockerExecutor(Executor):
    """Docker executor for running tasks in Docker containers"""

    def __init__(self, subprocess_module=subprocess, requests_module=requests):
        """
        Initialize Docker executor with dependency injection for better testability
        
        Args:
            subprocess_module: Module for subprocess operations (default: subprocess)
            requests_module: Module for HTTP requests (default: requests)
        """
        self.subprocess = subprocess_module
        self.requests = requests_module
        
        # Check if Docker is available
        self._check_docker_availability()
    
    def _check_docker_availability(self) -> None:
        """Check if Docker is available on the system"""
        try:
            self.subprocess.run(["docker", "--version"], check=True, capture_output=True)
            logger.info("Docker is available")
        except (subprocess.SubprocessError, FileNotFoundError) as e:
            logger.error(f"Docker is not available: {e}")
            raise RuntimeError("Docker is not available")

    def submit_executor(
        self, task: Dict[str, Any], callback: Optional[callable] = None
    ) -> Dict[str, Any]:
        """
        Submit a Docker container for the given task.

        Args:
            task (Dict[str, Any]): Task information.
            callback (Optional[callable]): Optional callback function.

        Returns:
            Dict[str, Any]: Submission result with unified structure.
        """
        # 提取任务基本信息，避免重复获取
        task_info = self._extract_task_info(task)
        task_id = task_info["task_id"]
        subtask_id = task_info["subtask_id"]
        user_name = task_info["user_name"]
        executor_name = task_info["executor_name"]
        
        # 初始化执行状态
        execution_status = {
            "status": "success",
            "progress": DEFAULT_PROGRESS_RUNNING,
            "error_msg": "",
            "callback_status": TaskStatus.RUNNING.value,
            "executor_name": executor_name
        }
        
        try:
            # 根据是否已有容器名称决定执行路径
            if executor_name:
                self._execute_in_existing_container(task, execution_status)
            else:
                # 生成新的容器名称
                execution_status["executor_name"] = f"task-{user_name}-{task_id}-{subtask_id}"
                self._create_new_container(task, task_info, execution_status)
        except Exception as e:
            # 统一异常处理
            self._handle_execution_exception(e, task_id, execution_status)
        
        # 调用回调函数
        self._call_callback(
            callback,
            task_id,
            subtask_id,
            execution_status["executor_name"],
            execution_status["progress"],
            execution_status["callback_status"]
        )
        
        # 返回统一的结果结构
        return self._create_result_response(execution_status)
    
    def _extract_task_info(self, task: Dict[str, Any]) -> Dict[str, Any]:
        """提取任务的基本信息"""
        task_id = task.get("task_id", DEFAULT_TASK_ID)
        subtask_id = task.get("subtask_id", DEFAULT_TASK_ID)
        user_config = task.get("user") or {}
        user_name = user_config.get("name", "unknown")
        executor_name = task.get("executor_name")
        
        return {
            "task_id": task_id,
            "subtask_id": subtask_id,
            "user_name": user_name,
            "executor_name": executor_name
        }
    
    def _execute_in_existing_container(self, task: Dict[str, Any], status: Dict[str, Any]) -> None:
        """在已存在的容器中执行任务"""
        executor_name = status["executor_name"]
        port_info = self._get_container_port(executor_name)
        
        # 发送HTTP请求到容器
        response = self._send_task_to_container(task, DEFAULT_DOCKER_HOST, port_info)
        
        # 处理响应
        if response.json()["status"] == "success":
            status["progress"] = DEFAULT_PROGRESS_COMPLETE
            status["error_msg"] = response.json().get("error_msg", "")
    
    def _get_container_port(self, executor_name: str) -> int:
        """获取容器的端口信息"""
        port_result = get_container_ports(executor_name)
        logger.info(f"Container port info: {executor_name}, {port_result}")
        
        ports = port_result.get("ports", [])
        if not ports:
            raise ValueError(f"Executor name {executor_name} not found or has no ports")
        
        return ports[0].get("host_port")
    
    def _send_task_to_container(self, task: Dict[str, Any], host: str, port: int) -> requests.Response:
        """发送任务到容器的API端点"""
        endpoint = f"http://{host}:{port}{DEFAULT_API_ENDPOINT}"
        logger.info(f"Sending task to {endpoint}")
        return self.requests.post(endpoint, json=task)
    
    def _create_new_container(self, task: Dict[str, Any], task_info: Dict[str, Any], status: Dict[str, Any]) -> None:
        """创建新的Docker容器"""
        executor_name = status["executor_name"]
        task_id = task_info["task_id"]
        
        # 获取执行器镜像
        executor_image = self._get_executor_image(task)
        
        # 准备Docker命令
        cmd = self._prepare_docker_command(task, task_info, executor_name, executor_image)
        
        # 执行Docker命令
        logger.info(f"Starting Docker container for task {task_id}: {executor_name}")
        result = self.subprocess.run(cmd, check=True, capture_output=True, text=True)
        
        # 记录容器ID
        container_id = result.stdout.strip()
        logger.info(f"Started Docker container {executor_name} with ID {container_id}")
    
    def _get_executor_image(self, task: Dict[str, Any]) -> str:
        """获取执行器镜像名称"""
        executor_image = task.get("executor_image", os.getenv("EXECUTOR_IMAGE", ""))
        if not executor_image:
            raise ValueError("Executor image not provided")
        return executor_image
    
    def _prepare_docker_command(
        self,
        task: Dict[str, Any],
        task_info: Dict[str, Any],
        executor_name: str,
        executor_image: str
    ) -> List[str]:
        """准备Docker运行命令"""
        task_id = task_info["task_id"]
        subtask_id = task_info["subtask_id"]
        user_name = task_info["user_name"]
        
        # 转换任务为JSON字符串
        task_str = json.dumps(task)
        
        # 基本命令
        cmd = [
            "docker",
            "run",
            "-d",  # 后台运行模式
            "--name", executor_name,
            # 添加标签用于容器管理
            "--label", f"owner={CONTAINER_OWNER}",
            "--label", f"task_id={task_id}",
            "--label", f"subtask_id={subtask_id}",
            "--label", f"user={user_name}",
            "--label", f"subtask_next_id={task.get('subtask_next_id', '')}",
            # 环境变量
            "-e", f"TASK_INFO={task_str}",
            "-e", f"EXECUTOR_NAME={executor_name}",
            "-e", f"TZ={DEFAULT_TIMEZONE}",
            "-e", f"LANG={DEFAULT_LOCALE}",
            # 挂载
            "-v", f"{DOCKER_SOCKET_PATH}:{DOCKER_SOCKET_PATH}"
        ]
        
        # 添加工作空间挂载
        self._add_workspace_mount(cmd)
        
        # 添加网络配置
        self._add_network_config(cmd)
        
        # 添加端口映射
        port = find_available_port()
        logger.info(f"Assigned port {port} for container {executor_name}")
        cmd.extend(["-p", f"{port}:{port}", "-e", f"PORT={port}"])
        
        # 添加回调URL
        self._add_callback_url(cmd, task)
        
        # 添加执行器镜像
        cmd.append(executor_image)
        
        return cmd
    
    def _add_workspace_mount(self, cmd: List[str]) -> None:
        """添加工作空间挂载配置"""
        executor_workspace = os.getenv("EXECUTOR_WORKSPACE", "")  # 修正拼写错误
        if executor_workspace:
            cmd.extend(["-v", f"{executor_workspace}:{WORKSPACE_MOUNT_PATH}"])
    
    def _add_network_config(self, cmd: List[str]) -> None:
        """添加网络配置"""
        network = os.getenv("NETWORK", "")
        if network:
            cmd.extend(["--network", network])
    
    def _add_callback_url(self, cmd: List[str], task: Dict[str, Any]) -> None:
        """添加回调URL配置"""
        callback_url = build_callback_url(task)
        if callback_url:
            cmd.extend(["-e", f"CALLBACK_URL={callback_url}"])
    
    def _handle_execution_exception(self, exception: Exception, task_id: int, status: Dict[str, Any]) -> None:
        """统一处理执行过程中的异常"""
        if isinstance(exception, subprocess.CalledProcessError):
            logger.error(f"Docker run error for task {task_id}: {exception.stderr}")
            error_msg = f"Docker run error: {exception.stderr}"
        else:
            logger.error(f"Error for task {task_id}: {str(exception)}")
            error_msg = f"Error: {str(exception)}"
        
        status["status"] = "failed"
        status["progress"] = DEFAULT_PROGRESS_COMPLETE
        status["error_msg"] = error_msg
        status["callback_status"] = TaskStatus.FAILED.value
    
    def _create_result_response(self, status: Dict[str, Any]) -> Dict[str, Any]:
        """创建统一的返回结果结构"""
        result = {
            "status": status["status"],
            "executor_name": status["executor_name"]
        }
        
        if status["status"] != "success":
            result["error_msg"] = status["error_msg"]
            
        return result

    def delete_executor(self, executor_name: str) -> Dict[str, Any]:
        """
        Delete a Docker container.

        Args:
            executor_name (str): Name of the container to delete.

        Returns:
            Dict[str, Any]: Deletion result with unified structure.
        """
        try:
            # 检查容器是否存在且归属于executor_manager
            if not check_container_ownership(executor_name):
                return {
                    "status": "unauthorized",
                    "error_msg": f"Container '{executor_name}' is not owned by {CONTAINER_OWNER}",
                }

            # 删除容器
            return delete_container(executor_name)
        except Exception as e:
            logger.error(f"Error deleting container {executor_name}: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error deleting container: {str(e)}"
            }

    def get_executor_count(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get count of running Docker containers.

        Args:
            label_selector (Optional[str]): Label selector for filtering containers.
                                           If provided, will be used as additional filter.

        Returns:
            Dict[str, Any]: Count result.
        """
        try:
            result = get_running_task_details(label_selector)

            # 维持API向后兼容性
            if result["status"] == "success":
                result["running"] = len(result.get("task_ids", []))

            return result
        except Exception as e:
            logger.error(f"Error getting executor count: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error getting executor count: {str(e)}"
            }

    def get_current_task_ids(
        self, label_selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Get details of currently running tasks.
        
        Args:
            label_selector (Optional[str]): Label selector for filtering containers.
            
        Returns:
            Dict[str, Any]: Task details result.
        """
        try:
            return get_running_task_details(label_selector)
        except Exception as e:
            logger.error(f"Error getting current task IDs: {e}")
            return {
                "status": "failed",
                "error_msg": f"Error getting current task IDs: {str(e)}"
            }

    def _call_callback(
        self, callback, task_id, subtask_id, executor_name, progress, status
    ):
        """
        Call the provided callback function with task information.

        Args:
            callback (callable): Callback function to call
            task_id: Task identifier
            subtask_id: Subtask identifier
            executor_name (str): Name of the executor
            progress (int): Current progress value
            status (str): Current task status
        """
        if not callback:
            return
            
        try:
            callback(
                task_id=task_id,
                subtask_id=subtask_id,
                executor_name=executor_name,
                progress=progress,
                status=status,
            )
        except Exception as e:
            logger.error(f"Error in callback for task {task_id}: {e}")
