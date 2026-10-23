// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'

export const executionEnvironmentMessages: Record<
  CollaborationLocale,
  Readonly<Record<string, string>>
> = {
  'zh-CN': {
    'todo.runner_environment_not_authorized':
      '机器人没有符合配置且获项目授权的执行环境。请在项目设置中检查执行环境授权，并检查机器人的环境选择。',
    'todo.device_catalog_local_failed': '本地设备加载失败',
    'todo.device_catalog_cloud_failed': '云端设备加载失败',
    'todo.device_catalog_loading_more': '正在加载其他设备…',
    'todo.device_catalog_empty': '尚未添加设备',
    'todo.workspace_execution_environments_intro': '管理共享给空间内项目的执行环境。',
    'todo.project_execution_environments_intro':
      '选择此项目可以使用的执行环境，项目目录会在首次运行时自动准备。',
    'todo.project_available_environments': '项目可用环境',
    'todo.execution_environment_empty_hint': '通过「添加设备」选择可以运行任务的设备。',
    'todo.execution_environments_load_failed': '加载执行环境失败',
    'todo.project_direct': '项目直接添加',
    'todo.execution_environment_preparation': '项目准备',
    'todo.execution_environment_preparation_summary':
      '{{repositories}} 个仓库 · {{steps}} 个初始化步骤',
    'todo.execution_environment_preparation_default':
      '默认使用空白工作目录，可按需添加仓库和初始化命令。',
    'todo.execution_environment_setup_directory': '工作目录（留空使用默认目录）',
    'todo.workspace_policy': '任务工作区',
    'todo.workspace_policy_isolated': '独立工作树（推荐）',
    'todo.workspace_policy_shared': '共享项目目录',
    'todo.workspace_policy_description':
      'Git 仓库的新任务默认使用独立工作树；无仓库时使用环境目录。共享目录中的并行任务可能相互覆盖。修改仅影响新任务，无需重新初始化环境。',
    'todo.execution_environment_online': '在线',
    'todo.execution_environment_offline': '离线',
    'todo.execution_environment_provisioning': '准备中',
    'todo.execution_environment_error': '异常',
    'todo.execution_environment_preparing': '正在准备项目目录',
    'todo.execution_environment_initialization_error': '项目准备失败',
    'todo.execution_environment_repositories': '代码仓库',
    'todo.show_advanced_options': '高级选项',
    'todo.hide_advanced_options': '收起高级选项',
    'todo.execution_environment_repositories_description':
      '添加仓库后，主仓库是智能体默认工作目录；不添加则创建空白工作目录。',
    'todo.execution_environment_no_repositories': '未添加代码仓库，将使用空白工作目录。',
    'todo.execution_environment_primary_repository': '主仓库',
    'todo.execution_environment_dependency_repository': '依赖仓库',
    'todo.add_repository': '添加仓库',
    'todo.repository_name': '名称',
    'todo.repository_path': '目录',
    'todo.repository_url': 'Git 仓库',
    'todo.repository_select_placeholder': '选择仓库',
    'todo.repository_ref_placeholder': '选择分支或 Tag',
    'todo.execution_environment_repository_ref': '分支或 Tag',
    'todo.repositories_load_failed': '仓库列表加载失败，可直接填写仓库地址。',
    'todo.repository_branches_load_failed': '分支加载失败，可手动填写。',
    'todo.execution_environment_setup': '初始化步骤',
    'todo.execution_environment_setup_description':
      '步骤按顺序执行；工作目录为空时在主仓库执行，也可以指定任一仓库目录。',
    'todo.execution_environment_setup_without_repository_description':
      '步骤按顺序在空白环境中执行；工作目录为空时使用环境根目录。',
    'todo.add_setup_step': '添加步骤',
    'todo.no_setup_steps': '没有初始化步骤，仓库克隆完成后即可使用。',
    'todo.no_setup_steps_without_repository': '没有初始化步骤，空白工作目录创建后即可使用。',
    'todo.execution_environment_repository_incomplete':
      '请补全仓库的名称、Git 仓库和目录，或移除该仓库。',
    'todo.execution_environment_save_configuration': '保存配置',
    'todo.execution_environment_configuration_saved': '配置已保存',
    'todo.execution_environment_configuration_unsaved': '配置有未保存的修改',
    'todo.execution_environment_save_before_initialization':
      '配置有未保存的修改，请先保存配置再准备项目目录。',
    'todo.execution_environment_primary_repository_required':
      '请为已添加的代码仓库设置一个主仓库。',
    'todo.execution_environment_prepare_ahead': '提前准备项目目录',
    'todo.issue_environment_notice_offline':
      '运行设备离线，暂时无法执行 AI 任务。可以继续创建和人工处理 Issue。',
    'todo.issue_environment_notice_unknown':
      '暂时无法检查项目执行环境，不影响创建和人工处理 Issue。',
    'todo.issue_environment_notice_contact_manager':
      '如需配置执行环境，请联系项目 Owner 或 Maintainer。',
    'todo.issue_environment_notice_configure': '去配置执行环境',
    'todo.issue_environment_notice_view': '查看执行环境',
    'todo.issue_environment_notice_retry': '重新检查',
    'todo.manage_execution_devices': '添加或启动设备',
    'todo.execution_environment_blank_workspace_upgrade_required':
      '当前设备的 Executor 不支持空白执行环境，请升级或重启 Executor 后重试；也可以先添加一个主代码仓库。',
    'todo.execution_environment_status_filter': '状态',
    'todo.execution_environment_all_statuses': '全部',
    'todo.execution_environment_no_matches': '没有符合当前状态的执行环境',
    'todo.no_available_execution_environments': '没有可添加的在线执行环境',
    'todo.select_workspace_execution_environment': '选择设备',
    'todo.select_execution_device': '选择设备',
    'todo.add_execution_environment': '添加设备',
    'todo.add_execution_device': '添加设备',
    'todo.execution_device_add_failed': '添加设备失败',
    'todo.configured_workspace_execution_environments': '共享环境',
    'todo.local_device': '本地设备',
    'todo.cloud_host': '云主机',
    'todo.workspace_shared': '空间共享',
    'todo.personal_resource': '我的资源',
    'todo.execution_environment_share_and_add': '共享并添加',
    'todo.execution_environment_checking_sharing': '正在检查共享状态',
    'todo.execution_environment_sharing_unknown': '共享状态未确认',
    'todo.execution_environment_share_scope_hint':
      '共享后，空间成员可为其他项目授权使用；仍使用此环境的账号和额度。',
    'todo.execution_environment_share_failed': '共享环境失败：{{reason}}',
    'todo.execution_environment_shared_add_failed':
      '环境已共享到空间，但添加到项目失败：{{reason}}。请重试添加。',
    'todo.execution_environment_workspace_share_required':
      '环境尚未共享给项目所属空间，请刷新后选择“共享并添加”。',
    'todo.execution_environment_already_shared': '环境已共享给空间，请刷新后重试添加。',
    'todo.execution_environment_already_added': '环境已添加到项目，请刷新列表。',
    'todo.execution_environment_owned_not_found': '个人环境不存在或已失去所有权，请刷新设备列表。',
    'todo.execution_environment_not_found': '环境不存在或已停用，请刷新设备列表。',
    'todo.execution_environment_workspace_not_found':
      '空间不存在或你已失去访问权限，请联系空间管理员。',
    'todo.execution_environment_workspace_required': '项目尚未加入空间，请先配置所属空间。',
    'todo.execution_environment_permission_denied': '没有操作权限，请联系空间或项目管理员。',
  },
  en: {
    'todo.runner_environment_not_authorized':
      'No project-authorized execution environment matches this agent. Check execution environment authorization in Project settings and the agent’s environment selection.',
    'todo.device_catalog_local_failed': 'Failed to load local devices',
    'todo.device_catalog_cloud_failed': 'Failed to load cloud devices',
    'todo.device_catalog_loading_more': 'Loading more devices…',
    'todo.device_catalog_empty': 'No devices added yet',
    'todo.workspace_execution_environments_intro':
      'Manage execution environments shared with projects in this workspace.',
    'todo.project_execution_environments_intro':
      'Choose runners for this project. Project directories are prepared automatically on first use.',
    'todo.project_available_environments': 'Available environments',
    'todo.execution_environment_empty_hint': 'Use Add device to choose a runner for tasks.',
    'todo.execution_environments_load_failed': 'Failed to load execution environments',
    'todo.project_direct': 'Added to project',
    'todo.execution_environment_preparation': 'Project setup',
    'todo.execution_environment_preparation_summary':
      'Repositories: {{repositories}} · Initialization steps: {{steps}}',
    'todo.execution_environment_preparation_default':
      'Uses a blank working directory. Add repositories and initialization commands as needed.',
    'todo.execution_environment_setup_directory': 'Working directory (blank uses the default)',
    'todo.workspace_policy': 'Task workspace',
    'todo.workspace_policy_isolated': 'Isolated worktree (recommended)',
    'todo.workspace_policy_shared': 'Shared project directory',
    'todo.workspace_policy_description':
      'New Git tasks use isolated worktrees; environments without a repository use their directory. Parallel tasks in a shared directory may overwrite each other. Changes affect new tasks only and do not require reinitialization.',
    'todo.execution_environment_online': 'Online',
    'todo.execution_environment_offline': 'Offline',
    'todo.execution_environment_provisioning': 'Preparing',
    'todo.execution_environment_error': 'Error',
    'todo.execution_environment_preparing': 'Preparing project directory',
    'todo.execution_environment_initialization_error': 'Project preparation failed',
    'todo.execution_environment_repositories': 'Code repositories',
    'todo.show_advanced_options': 'Advanced options',
    'todo.hide_advanced_options': 'Hide advanced options',
    'todo.execution_environment_repositories_description':
      "When repositories are added, the primary repository is the agent's default working directory. Without one, initialization creates a blank working directory.",
    'todo.execution_environment_no_repositories':
      'No code repository added. A blank working directory will be used.',
    'todo.execution_environment_primary_repository': 'Primary repository',
    'todo.execution_environment_dependency_repository': 'Dependency repository',
    'todo.add_repository': 'Add repository',
    'todo.repository_name': 'Name',
    'todo.repository_path': 'Directory',
    'todo.repository_url': 'Git repository',
    'todo.repository_select_placeholder': 'Select a repository',
    'todo.repository_ref_placeholder': 'Select a branch or tag',
    'todo.execution_environment_repository_ref': 'Branch or tag',
    'todo.repositories_load_failed':
      'Failed to load repositories. You can still enter a repository URL.',
    'todo.repository_branches_load_failed': 'Failed to load branches. You can still enter one.',
    'todo.execution_environment_setup': 'Initialization steps',
    'todo.execution_environment_setup_description':
      'Steps run in order. An empty working directory uses the primary repository, or you can select a path inside any configured repository.',
    'todo.execution_environment_setup_without_repository_description':
      'Steps run in order in the blank environment. An empty working directory uses the environment root.',
    'todo.add_setup_step': 'Add step',
    'todo.no_setup_steps':
      'No initialization steps. The environment is ready after repositories are cloned.',
    'todo.no_setup_steps_without_repository':
      'No initialization steps. The environment is ready after its blank working directory is created.',
    'todo.execution_environment_repository_incomplete':
      'Complete the repository name, Git repository, and directory, or remove the repository.',
    'todo.execution_environment_save_configuration': 'Save configuration',
    'todo.execution_environment_configuration_saved': 'Configuration saved',
    'todo.execution_environment_configuration_unsaved': 'Configuration has unsaved changes',
    'todo.execution_environment_save_before_initialization':
      'Save the configuration changes before preparing the project directory.',
    'todo.execution_environment_primary_repository_required':
      'Set one added code repository as the primary repository.',
    'todo.execution_environment_prepare_ahead': 'Prepare project directory ahead of time',
    'todo.issue_environment_notice_offline':
      'The runtime device is offline, so AI tasks cannot run. You can still create and handle Issues manually.',
    'todo.issue_environment_notice_unknown':
      'The project execution environment could not be checked. You can still create and handle Issues manually.',
    'todo.issue_environment_notice_contact_manager':
      'Contact a project Owner or Maintainer to configure a runner.',
    'todo.issue_environment_notice_configure': 'Configure environment',
    'todo.issue_environment_notice_view': 'View environment',
    'todo.issue_environment_notice_retry': 'Check again',
    'todo.manage_execution_devices': 'Add or start a device',
    'todo.execution_environment_blank_workspace_upgrade_required':
      "This device's Executor does not support blank execution environments. Upgrade or restart the Executor and retry, or add a primary repository.",
    'todo.execution_environment_status_filter': 'Status',
    'todo.execution_environment_all_statuses': 'All',
    'todo.execution_environment_no_matches': 'No execution environments match this status',
    'todo.no_available_execution_environments': 'No online execution environments available to add',
    'todo.select_workspace_execution_environment': 'Select a device',
    'todo.select_execution_device': 'Select a device',
    'todo.add_execution_environment': 'Add device',
    'todo.add_execution_device': 'Add device',
    'todo.execution_device_add_failed': 'Failed to add device',
    'todo.configured_workspace_execution_environments': 'Shared environments',
    'todo.local_device': 'Local device',
    'todo.cloud_host': 'Cloud host',
    'todo.workspace_shared': 'Shared by workspace',
    'todo.personal_resource': 'My resources',
    'todo.execution_environment_share_and_add': 'Share and add',
    'todo.execution_environment_checking_sharing': 'Checking sharing status',
    'todo.execution_environment_sharing_unknown': 'Sharing status unavailable',
    'todo.execution_environment_share_scope_hint':
      'Workspace members can authorize this environment for other projects. Its account and quota remain in use.',
    'todo.execution_environment_share_failed': 'Failed to share the environment: {{reason}}',
    'todo.execution_environment_shared_add_failed':
      'The environment was shared with the workspace, but could not be added to the project: {{reason}}. Retry adding it.',
    'todo.execution_environment_workspace_share_required':
      'This environment is not shared with the project’s workspace. Refresh, then select “Share and add”.',
    'todo.execution_environment_already_shared':
      'The environment is already shared with the workspace. Refresh and retry adding it.',
    'todo.execution_environment_already_added':
      'The environment is already available in the project. Refresh the list.',
    'todo.execution_environment_owned_not_found':
      'The personal environment no longer exists or belongs to you. Refresh the device list.',
    'todo.execution_environment_not_found':
      'The environment no longer exists or is disabled. Refresh the device list.',
    'todo.execution_environment_workspace_not_found':
      'The workspace no longer exists or you have lost access. Contact a workspace administrator.',
    'todo.execution_environment_workspace_required':
      'The project is not attached to a workspace. Configure its workspace first.',
    'todo.execution_environment_permission_denied':
      'You do not have permission. Contact a workspace or project administrator.',
  },
}
