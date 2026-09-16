// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from "../i18n";

export const executionEnvironmentMessages: Record<
  CollaborationLocale,
  Readonly<Record<string, string>>
> = {
  "zh-CN": {
    "todo.execution_environment_online": "在线",
    "todo.execution_environment_offline": "离线",
    "todo.execution_environment_provisioning": "准备中",
    "todo.execution_environment_error": "异常",
    "todo.execution_environment_ready": "环境已就绪",
    "todo.execution_environment_preparing": "正在创建环境",
    "todo.execution_environment_initialization_error": "环境创建失败",
    "todo.execution_environment_uninitialized": "尚未创建环境",
    "todo.execution_environment_configuration": "环境配置",
    "todo.execution_environment_configuration_description":
      "定义创建执行环境时使用的代码来源和初始化命令。",
    "todo.execution_environment_repositories": "代码仓库",
    "todo.execution_environment_repositories_description":
      "主仓库是智能体默认工作目录；其他仓库会克隆到同一环境下的独立目录。",
    "todo.execution_environment_primary_repository": "主仓库",
    "todo.execution_environment_dependency_repository": "依赖仓库",
    "todo.add_repository": "添加仓库",
    "todo.repository_name": "名称",
    "todo.repository_path": "目录",
    "todo.repository_url": "Git 仓库",
    "todo.execution_environment_setup": "初始化步骤",
    "todo.execution_environment_setup_description":
      "步骤按顺序执行；工作目录为空时在主仓库执行，也可以指定任一仓库目录。",
    "todo.add_setup_step": "添加步骤",
    "todo.no_setup_steps": "没有初始化步骤，仓库克隆完成后即可使用。",
    "todo.execution_environment_create": "创建环境",
    "todo.execution_environment_reinitialize": "重新创建",
    "todo.execution_environment_create_hint":
      "填写配置后，在一台在线设备上点击“创建环境”；创建过程会同时保存配置并完成初始化。",
    "todo.execution_environment_status_filter": "状态",
    "todo.execution_environment_all_statuses": "全部",
    "todo.execution_environment_no_matches": "没有符合当前状态的执行环境",
    "todo.no_available_execution_environments": "没有可添加的在线执行环境",
    "todo.select_workspace_execution_environment": "选择设备",
    "todo.select_execution_device": "选择设备",
    "todo.add_execution_environment": "添加设备",
    "todo.add_execution_device": "添加设备",
    "todo.execution_device_add_failed": "添加设备失败",
    "todo.configured_project_execution_environments": "运行设备",
    "todo.configured_workspace_execution_environments": "运行设备",
    "todo.local_device": "本地设备",
    "todo.cloud_host": "云主机",
    "todo.workspace_shared": "空间共享",
    "todo.personal_resource": "我的资源",
  },
  en: {
    "todo.execution_environment_online": "Online",
    "todo.execution_environment_offline": "Offline",
    "todo.execution_environment_provisioning": "Preparing",
    "todo.execution_environment_error": "Error",
    "todo.execution_environment_ready": "Environment ready",
    "todo.execution_environment_preparing": "Creating environment",
    "todo.execution_environment_initialization_error":
      "Environment creation failed",
    "todo.execution_environment_uninitialized": "No environment",
    "todo.execution_environment_configuration": "Environment configuration",
    "todo.execution_environment_configuration_description":
      "Define the code source and initialization commands used to create an execution environment.",
    "todo.execution_environment_repositories": "Code repositories",
    "todo.execution_environment_repositories_description":
      "The primary repository is the agent's default working directory. Other repositories are cloned into separate paths in the same environment.",
    "todo.execution_environment_primary_repository": "Primary repository",
    "todo.execution_environment_dependency_repository": "Dependency repository",
    "todo.add_repository": "Add repository",
    "todo.repository_name": "Name",
    "todo.repository_path": "Directory",
    "todo.repository_url": "Git repository",
    "todo.execution_environment_setup": "Initialization steps",
    "todo.execution_environment_setup_description":
      "Steps run in order. An empty working directory uses the primary repository, or you can select a path inside any configured repository.",
    "todo.add_setup_step": "Add step",
    "todo.no_setup_steps":
      "No initialization steps. The environment is ready after repositories are cloned.",
    "todo.execution_environment_create": "Create environment",
    "todo.execution_environment_reinitialize": "Recreate",
    "todo.execution_environment_create_hint":
      "Complete the configuration, then create the environment on an online device. Creation saves the configuration and initializes it.",
    "todo.execution_environment_status_filter": "Status",
    "todo.execution_environment_all_statuses": "All",
    "todo.execution_environment_no_matches":
      "No execution environments match this status",
    "todo.no_available_execution_environments":
      "No online execution environments available to add",
    "todo.select_workspace_execution_environment": "Select a device",
    "todo.select_execution_device": "Select a device",
    "todo.add_execution_environment": "Add device",
    "todo.add_execution_device": "Add device",
    "todo.execution_device_add_failed": "Failed to add device",
    "todo.configured_project_execution_environments": "Runtime devices",
    "todo.configured_workspace_execution_environments": "Runtime devices",
    "todo.local_device": "Local device",
    "todo.cloud_host": "Cloud host",
    "todo.workspace_shared": "Shared by workspace",
    "todo.personal_resource": "My resources",
  },
};
