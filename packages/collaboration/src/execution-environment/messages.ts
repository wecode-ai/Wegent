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
    "todo.execution_environment_preparing": "正在初始化环境",
    "todo.execution_environment_initialization_error": "环境初始化失败",
    "todo.execution_environment_uninitialized": "环境未初始化",
    "todo.execution_environment_configuration": "环境配置",
    "todo.execution_environment_configuration_description":
      "定义初始化执行环境时使用的代码来源和初始化命令。",
    "todo.execution_environment_repositories": "代码仓库",
    "todo.execution_environment_repositories_description":
      "添加仓库后，主仓库是智能体默认工作目录；不添加则创建空白工作目录。",
    "todo.execution_environment_no_repositories":
      "未添加代码仓库。初始化时会创建一个空白工作目录。",
    "todo.execution_environment_primary_repository": "主仓库",
    "todo.execution_environment_dependency_repository": "依赖仓库",
    "todo.add_repository": "添加仓库",
    "todo.repository_name": "名称",
    "todo.repository_path": "目录",
    "todo.repository_url": "Git 仓库",
    "todo.repository_select_placeholder": "选择仓库",
    "todo.repository_ref_placeholder": "选择分支或 Tag",
    "todo.execution_environment_repository_ref": "分支或 Tag",
    "todo.repositories_load_failed": "仓库列表加载失败，可直接填写仓库地址。",
    "todo.repository_branches_load_failed": "分支加载失败，可手动填写。",
    "todo.execution_environment_setup": "初始化步骤",
    "todo.execution_environment_setup_description":
      "步骤按顺序执行；工作目录为空时在主仓库执行，也可以指定任一仓库目录。",
    "todo.execution_environment_setup_without_repository_description":
      "步骤按顺序在空白环境中执行；工作目录为空时使用环境根目录。",
    "todo.add_setup_step": "添加步骤",
    "todo.no_setup_steps": "没有初始化步骤，仓库克隆完成后即可使用。",
    "todo.no_setup_steps_without_repository":
      "没有初始化步骤，空白工作目录创建后即可使用。",
    "todo.execution_environment_repository_incomplete":
      "请补全仓库的名称、Git 仓库和目录，或移除该仓库。",
    "todo.execution_environment_save_configuration": "保存配置",
    "todo.execution_environment_configuration_saved": "配置已保存",
    "todo.execution_environment_configuration_unsaved": "配置有未保存的修改",
    "todo.execution_environment_save_before_initialization":
      "配置有未保存的修改，请先保存配置再初始化环境。",
    "todo.execution_environment_create": "初始化环境",
    "todo.execution_environment_primary_repository_required":
      "请为已添加的代码仓库设置一个主仓库。",
    "todo.execution_environment_reinitialize": "重新初始化",
    "todo.project_environment_initialization": "设备环境初始化",
    "todo.execution_environment_required": "必需",
    "todo.execution_environment_required_description":
      "至少在一台在线设备上完成初始化，项目任务才能使用此环境运行。",
    "todo.execution_environment_readiness_pending": "待完成",
    "todo.execution_environment_readiness_ready": "已完成",
    "todo.issue_environment_notice_unassigned":
      "当前项目还没有可用的执行环境。Issue 仍可创建；智能体会等待环境就绪。",
    "todo.issue_environment_notice_offline":
      "项目环境已配置，但运行设备当前离线。Issue 仍可创建；智能体会等待设备上线。",
    "todo.issue_environment_notice_preparing":
      "项目环境正在初始化。Issue 仍可创建；智能体会在环境就绪后执行。",
    "todo.issue_environment_notice_error":
      "项目环境初始化失败。Issue 仍可创建；请修复环境后再启动智能体执行。",
    "todo.issue_environment_notice_unknown":
      "暂时无法检查项目执行环境。Issue 仍可创建。",
    "todo.issue_environment_notice_uninitialized":
      "项目运行设备尚未完成环境初始化。Issue 仍可创建；智能体会等待环境就绪。",
    "todo.issue_environment_notice_contact_manager":
      "如需初始化，请联系项目 Owner 或 Maintainer。",
    "todo.issue_environment_notice_configure": "去配置执行环境",
    "todo.issue_environment_notice_view": "查看执行环境",
    "todo.issue_environment_notice_retry": "重新检查",
    "todo.manage_execution_devices": "添加或启动设备",
    "todo.execution_environment_create_hint":
      "先保存配置，再在一台在线设备上初始化环境；未添加代码仓库时会创建空白工作目录。",
    "todo.execution_environment_blank_workspace_upgrade_required":
      "当前设备的 Executor 不支持空白执行环境，请升级或重启 Executor 后重试；也可以先添加一个主代码仓库。",
    "todo.execution_environment_initialized": "环境已初始化",
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
    "todo.execution_environment_preparing": "Initializing environment",
    "todo.execution_environment_initialization_error":
      "Environment initialization failed",
    "todo.execution_environment_uninitialized": "Environment not initialized",
    "todo.execution_environment_configuration": "Environment configuration",
    "todo.execution_environment_configuration_description":
      "Define the code source and commands used to initialize an execution environment.",
    "todo.execution_environment_repositories": "Code repositories",
    "todo.execution_environment_repositories_description":
      "When repositories are added, the primary repository is the agent's default working directory. Without one, initialization creates a blank working directory.",
    "todo.execution_environment_no_repositories":
      "No code repository added. Initialization will create a blank working directory.",
    "todo.execution_environment_primary_repository": "Primary repository",
    "todo.execution_environment_dependency_repository": "Dependency repository",
    "todo.add_repository": "Add repository",
    "todo.repository_name": "Name",
    "todo.repository_path": "Directory",
    "todo.repository_url": "Git repository",
    "todo.repository_select_placeholder": "Select a repository",
    "todo.repository_ref_placeholder": "Select a branch or tag",
    "todo.execution_environment_repository_ref": "Branch or tag",
    "todo.repositories_load_failed":
      "Failed to load repositories. You can still enter a repository URL.",
    "todo.repository_branches_load_failed":
      "Failed to load branches. You can still enter one.",
    "todo.execution_environment_setup": "Initialization steps",
    "todo.execution_environment_setup_description":
      "Steps run in order. An empty working directory uses the primary repository, or you can select a path inside any configured repository.",
    "todo.execution_environment_setup_without_repository_description":
      "Steps run in order in the blank environment. An empty working directory uses the environment root.",
    "todo.add_setup_step": "Add step",
    "todo.no_setup_steps":
      "No initialization steps. The environment is ready after repositories are cloned.",
    "todo.no_setup_steps_without_repository":
      "No initialization steps. The environment is ready after its blank working directory is created.",
    "todo.execution_environment_repository_incomplete":
      "Complete the repository name, Git repository, and directory, or remove the repository.",
    "todo.execution_environment_save_configuration": "Save configuration",
    "todo.execution_environment_configuration_saved": "Configuration saved",
    "todo.execution_environment_configuration_unsaved":
      "Configuration has unsaved changes",
    "todo.execution_environment_save_before_initialization":
      "Save the configuration changes before initializing the environment.",
    "todo.execution_environment_create": "Initialize environment",
    "todo.execution_environment_primary_repository_required":
      "Set one added code repository as the primary repository.",
    "todo.execution_environment_reinitialize": "Reinitialize",
    "todo.project_environment_initialization": "Device initialization",
    "todo.execution_environment_required": "Required",
    "todo.execution_environment_required_description":
      "Initialize this environment on at least one online device before project tasks can run with it.",
    "todo.execution_environment_readiness_pending": "Not completed",
    "todo.execution_environment_readiness_ready": "Completed",
    "todo.issue_environment_notice_unassigned":
      "This project has no available execution environment yet. You can still create the Issue; Agent work will wait for the environment.",
    "todo.issue_environment_notice_offline":
      "The project environment is configured, but its runtime device is offline. You can still create the Issue; Agent work will wait for the device.",
    "todo.issue_environment_notice_preparing":
      "The project environment is being initialized. You can still create the Issue; Agent work will start when it is ready.",
    "todo.issue_environment_notice_error":
      "Project environment initialization failed. You can still create the Issue; repair the environment before starting Agent work.",
    "todo.issue_environment_notice_unknown":
      "The project execution environment could not be checked. You can still create the Issue.",
    "todo.issue_environment_notice_uninitialized":
      "The project's runtime device has not finished environment initialization. You can still create the Issue; Agent work will wait for it.",
    "todo.issue_environment_notice_contact_manager":
      "Contact a project Owner or Maintainer to initialize it.",
    "todo.issue_environment_notice_configure": "Configure environment",
    "todo.issue_environment_notice_view": "View environment",
    "todo.issue_environment_notice_retry": "Check again",
    "todo.manage_execution_devices": "Add or start a device",
    "todo.execution_environment_create_hint":
      "Save the configuration, then initialize it on an online device. Without a code repository, initialization creates a blank working directory.",
    "todo.execution_environment_blank_workspace_upgrade_required":
      "This device's Executor does not support blank execution environments. Upgrade or restart the Executor and retry, or add a primary repository.",
    "todo.execution_environment_initialized": "Environment initialized",
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
