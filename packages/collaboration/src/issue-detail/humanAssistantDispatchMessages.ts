// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const humanAssistantDispatchMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': {
    'human_assistant.label': '默认助理',
    'human_assistant.ai_generated': 'AI 生成',
    'human_assistant.publisher': '发布者：{{name}}',
    'human_assistant.confirmed': '已确认',
    'human_assistant.unconfirmed': '待确认',
    'human_assistant.state.queued': '排队中',
    'human_assistant.state.waiting_device': '等待设备',
    'human_assistant.state.no_authorized_assistant': '待授权',
    'human_assistant.state.running': '运行中',
    'human_assistant.state.completed': '执行已完成',
    'human_assistant.state.failed': '执行失败',
    'human_assistant.state.cancelling': '正在取消',
    'human_assistant.state.cancelled': '已取消',
    'human_assistant.configure': '配置我的助理',
    'human_assistant.execution': '执行 #{{id}}',
    'human_assistant.reason.no_authorized_assistant': '请负责人授权默认助理处理当前项目。',
    'human_assistant.reason.waiting_device': '请负责人连接助理所在设备，连接恢复后继续处理。',
    'human_assistant.reason.device_offline': '助理设备离线，连接恢复后继续处理。',
    'human_assistant.reason.no_registered_device': '请负责人连接并注册助理所在设备。',
    'human_assistant.reason.permission_denied': '负责人当前没有执行此 Issue 的权限。',
    'human_assistant.reason.superseded': '负责人已变更。',
    'human_assistant.reason.issue_closed': 'Issue 已关闭。',
    'human_assistant.reason.cancelling': '正在停止这次助理派发。',
    'human_assistant.reason.cancelled': '这次助理派发已停止。',
    'human_assistant.reason.unavailable': '助理暂时无法继续处理，请负责人检查配置。',
  },
  en: {
    'human_assistant.label': 'Default assistant',
    'human_assistant.ai_generated': 'AI generated',
    'human_assistant.publisher': 'Published by {{name}}',
    'human_assistant.confirmed': 'Confirmed',
    'human_assistant.unconfirmed': 'Unconfirmed',
    'human_assistant.state.queued': 'Queued',
    'human_assistant.state.waiting_device': 'Waiting for device',
    'human_assistant.state.no_authorized_assistant': 'Authorization required',
    'human_assistant.state.running': 'Running',
    'human_assistant.state.completed': 'Execution completed',
    'human_assistant.state.failed': 'Execution failed',
    'human_assistant.state.cancelling': 'Cancelling',
    'human_assistant.state.cancelled': 'Cancelled',
    'human_assistant.configure': 'Configure my assistant',
    'human_assistant.execution': 'Execution #{{id}}',
    'human_assistant.reason.no_authorized_assistant':
      'The assignee must authorize their default assistant for this project.',
    'human_assistant.reason.waiting_device':
      'The assignee must connect their assistant device to resume processing.',
    'human_assistant.reason.device_offline':
      'The assistant device is offline. Processing resumes when it reconnects.',
    'human_assistant.reason.no_registered_device':
      'The assignee must connect and register their assistant device.',
    'human_assistant.reason.permission_denied':
      'The assignee currently lacks permission to execute this Issue.',
    'human_assistant.reason.superseded': 'The assignee has changed.',
    'human_assistant.reason.issue_closed': 'The Issue is closed.',
    'human_assistant.reason.cancelling': 'This assistant dispatch is stopping.',
    'human_assistant.reason.cancelled': 'This assistant dispatch has stopped.',
    'human_assistant.reason.unavailable':
      'The assistant cannot continue. The assignee should check its configuration.',
  },
}
