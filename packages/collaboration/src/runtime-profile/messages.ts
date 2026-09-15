// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationLocale } from '../i18n'

export const runtimeProfileMessages: Record<
  CollaborationLocale,
  Readonly<Record<string, string>>
> = {
  'zh-CN': {
    'runtimeSettings.noModels': '没有可用模型，请先在模型管理中添加模型。',
    'runtimeSettings.executionBlocked':
      '缺少设备或模型配置，本次执行已被拦住，尚未启动。',
    'runtimeSettings.executionConfigure': '配置并继续执行',
    'runtimeSettings.executionTitle': '配置本次执行',
    'runtimeSettings.executionDescription':
      '选择设备和模型。保存后，本次任务将进入执行队列；项目和智能体的默认配置不会改变。',
    'runtimeSettings.executionSave': '保存配置并继续执行',
    'runtimeSettings.executionSaved': '配置已保存，任务将按审批设置继续执行。',
    'runtimeSettings.executionChanged': '执行状态已改变，请刷新任务后重试。',
    'runtimeSettings.ownerRequired': '需要由本次执行的所属用户配置设备和模型。',
    'runtimeSettings.agentTitle': '智能体执行配置',
    'runtimeSettings.agentDescription':
      '此配置用于该智能体之后的新任务。已等待配置的任务需在任务提示处点击「配置并继续执行」。',
    'runtimeSettings.agentSave': '保存智能体默认配置',
    'runtimeSettings.agentSaved': '智能体默认配置已保存。',
    'runtimeSettings.agentMissing': '缺少模型配置，任务将等待配置后才能执行',
    'runtimeSettings.agentConfigure': '配置设备和模型',
    'runtimeSettings.configure': '立即配置',
    'runtimeSettings.back': '返回执行配置',
    'runtimeSettings.done': '返回原页面',
    'runtimeSettings.unavailable': '当前客户端不支持配置执行环境',
    'runtimeSettings.loadFailed': '加载执行配置失败',
    'runtimeSettings.saveFailed': '保存执行配置失败',
    'runtimeSettings.title': '我的默认执行配置',
    'runtimeSettings.description':
      'AI 调度器使用这里的设备和模型来拆分、分配和推进任务；步骤智能体仍使用各自的配置。此设置仅影响你在当前项目中的执行。',
    'runtimeSettings.missing':
      '尚未配置完整的设备和模型，AI 调度器无法启动。请在下方选择或新建执行配置。',
    'runtimeSettings.profile': '执行配置',
    'runtimeSettings.select': '选择执行配置',
    'runtimeSettings.incomplete': '缺少设备或模型',
    'runtimeSettings.create': '新建配置',
    'runtimeSettings.name': '配置名称',
    'runtimeSettings.device': '执行设备',
    'runtimeSettings.selectDevice': '选择执行设备',
    'runtimeSettings.model': '模型',
    'runtimeSettings.selectModel': '选择模型',
    'runtimeSettings.noDevices':
      '项目没有可用的在线执行设备。请先添加执行环境。',
    'runtimeSettings.configureEnvironments': '配置执行环境',
    'runtimeSettings.saving': '保存中…',
    'runtimeSettings.createAndUse': '创建并设为默认',
    'runtimeSettings.use': '设为项目默认',
    'runtimeSettings.saved': '已设为当前项目默认配置。可返回原页面继续操作。',
    'runtimeSettings.workflowMissing':
      'AI 调度器缺少设备或模型配置，任务尚未启动。请前往「项目设置 → 分配与调度 → 我的默认执行配置」完成配置。',
    'runtimeSettings.waiting': '等待配置',
  },
  en: {
    'runtimeSettings.noModels': 'No models available. Add a model in model management first.',
    'runtimeSettings.executionBlocked':
      'Device or model configuration is missing. This execution is blocked and has not started.',
    'runtimeSettings.executionConfigure': 'Configure and continue',
    'runtimeSettings.executionTitle': 'Configure this execution',
    'runtimeSettings.executionDescription':
      'Select a device and model. Saving queues this execution without changing project or agent defaults.',
    'runtimeSettings.executionSave': 'Save and continue execution',
    'runtimeSettings.executionSaved':
      'Configuration saved. The task will proceed according to its approval settings.',
    'runtimeSettings.executionChanged':
      'Execution state changed. Refresh the task and try again.',
    'runtimeSettings.ownerRequired':
      'The execution owner needs to configure its device and model.',
    'runtimeSettings.agentTitle': 'Agent execution settings',
    'runtimeSettings.agentDescription':
      'These settings apply to new tasks assigned to this agent. For existing blocked tasks, use Configure and continue on the task.',
    'runtimeSettings.agentSave': 'Save agent defaults',
    'runtimeSettings.agentSaved': 'Agent defaults saved.',
    'runtimeSettings.agentMissing':
      'Model missing. Tasks cannot execute until configured.',
    'runtimeSettings.agentConfigure': 'Configure device and model',
    'runtimeSettings.configure': 'Configure now',
    'runtimeSettings.back': 'Back to execution settings',
    'runtimeSettings.done': 'Back to page',
    'runtimeSettings.unavailable':
      'Execution settings are unavailable in this client',
    'runtimeSettings.loadFailed': 'Could not load execution settings',
    'runtimeSettings.saveFailed': 'Could not save execution settings',
    'runtimeSettings.title': 'My default execution settings',
    'runtimeSettings.description':
      'The AI coordinator uses this device and model to plan, assign, and advance work. Step agents keep their own settings. This default applies only to your executions in this project.',
    'runtimeSettings.missing':
      'A device and model are required before the AI coordinator can start. Select or create execution settings below.',
    'runtimeSettings.profile': 'Execution settings',
    'runtimeSettings.select': 'Select execution settings',
    'runtimeSettings.incomplete': 'Device or model missing',
    'runtimeSettings.create': 'New configuration',
    'runtimeSettings.name': 'Configuration name',
    'runtimeSettings.device': 'Execution device',
    'runtimeSettings.selectDevice': 'Select an execution device',
    'runtimeSettings.model': 'Model',
    'runtimeSettings.selectModel': 'Select a model',
    'runtimeSettings.noDevices':
      'This project has no available online devices. Add an execution environment first.',
    'runtimeSettings.configureEnvironments': 'Configure execution environments',
    'runtimeSettings.saving': 'Saving…',
    'runtimeSettings.createAndUse': 'Create and set as default',
    'runtimeSettings.use': 'Set as project default',
    'runtimeSettings.saved':
      'Project default saved. Return to the original page to continue.',
    'runtimeSettings.workflowMissing':
      'The AI coordinator has no complete device and model configuration. Work has not started. Open Project settings → Assignment and dispatch → My default execution settings.',
    'runtimeSettings.waiting': 'Waiting for configuration',
  },
}
