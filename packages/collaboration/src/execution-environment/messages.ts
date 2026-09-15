// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'

export const executionEnvironmentMessages: Record<
  CollaborationLocale,
  Readonly<Record<string, string>>
> = {
  'zh-CN': {
    'todo.execution_environment_online': '在线',
    'todo.execution_environment_offline': '离线',
    'todo.execution_environment_provisioning': '准备中',
    'todo.execution_environment_error': '异常',
    'todo.execution_environment_status_filter': '设备状态',
    'todo.execution_environment_all_statuses': '全部状态',
    'todo.execution_environment_no_matches': '没有符合当前状态的执行环境',
    'todo.select_workspace_execution_environment': '选择执行环境',
    'todo.workspace_shared': '空间共享',
    'todo.personal_resource': '我的资源',
  },
  en: {
    'todo.execution_environment_online': 'Online',
    'todo.execution_environment_offline': 'Offline',
    'todo.execution_environment_provisioning': 'Preparing',
    'todo.execution_environment_error': 'Error',
    'todo.execution_environment_status_filter': 'Device status',
    'todo.execution_environment_all_statuses': 'All statuses',
    'todo.execution_environment_no_matches':
      'No execution environments match this status',
    'todo.select_workspace_execution_environment':
      'Select an execution environment',
    'todo.workspace_shared': 'Shared by workspace',
    'todo.personal_resource': 'My resources',
  },
}
