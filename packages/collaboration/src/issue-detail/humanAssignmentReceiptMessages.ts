// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export const humanAssignmentReceiptMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': {
    'human_assignment_receipt.label': '默认助理',
    'human_assignment_receipt.state.queued': '等待接单',
    'human_assignment_receipt.state.running': '助理已接单',
    'human_assignment_receipt.state.waiting_user': '待你处理',
    'human_assignment_receipt.state.completed': '处理已完成',
    'human_assignment_receipt.state.failed': '处理失败',
    'human_assignment_receipt.state.cancelling': '正在取消',
    'human_assignment_receipt.state.waiting_device': '等待设备',
    'human_assignment_receipt.state.blocked_policy': '未自动接单',
    'human_assignment_receipt.state.cancelled': '已取消',
    'human_assignment_receipt.state.superseded': '已改派',
    'human_assignment_receipt.configure': '配置我的助理',
    'human_assignment_receipt.open_task': '查看助理会话',
    'human_assignment_receipt.open_delivery': '查看交付',
    'human_assignment_receipt.reason.assistant_disabled':
      '默认助理已暂停，请负责人在助理设置中恢复接收。',
    'human_assignment_receipt.reason.project_not_authorized':
      '请负责人在助理设置的连接中添加当前项目。',
    'human_assignment_receipt.reason.automatic_disabled':
      '请负责人在当前项目连接的处理方式中启用自动处理。',
    'human_assignment_receipt.reason.tag_mismatch':
      'Issue 标签不匹配，请负责人检查项目连接中的限定任务标签。',
    'human_assignment_receipt.reason.no_authorized_assistant':
      '请负责人配置默认助理并授权处理当前项目。',
    'human_assignment_receipt.reason.waiting_device':
      '助理设备不可用，请负责人连接设备；恢复连接后继续处理。',
    'human_assignment_receipt.reason.device_state_unavailable':
      '暂时无法读取助理设备状态，请负责人检查设备连接。',
    'human_assignment_receipt.reason.device_offline': '助理设备离线，请负责人恢复设备连接。',
    'human_assignment_receipt.reason.no_registered_device': '请负责人连接并注册助理所在设备。',
    'human_assignment_receipt.reason.permission_denied':
      '负责人当前没有执行此 Issue 的权限，请联系项目管理员。',
    'human_assignment_receipt.reason.superseded': '负责人已变更。',
    'human_assignment_receipt.reason.issue_closed': 'Issue 已关闭。',
    'human_assignment_receipt.reason.cancelled': '这次助理接单已取消。',
    'human_assignment_receipt.reason.cancelling': '正在停止这次助理接单。',
    'human_assignment_receipt.reason.unavailable': '助理暂时无法继续处理，请负责人检查配置。',
    'human_assistant.ai_generated': 'AI 生成',
    'human_assistant.publisher': '发布者：{{name}}',
    'human_assistant.confirmed': '已确认',
    'human_assistant.unconfirmed': '待确认',
    'human_assistant.execution': '执行 #{{id}}',
  },
  en: {
    'human_assignment_receipt.label': 'Default assistant',
    'human_assignment_receipt.state.queued': 'Awaiting acceptance',
    'human_assignment_receipt.state.running': 'Accepted by assistant',
    'human_assignment_receipt.state.waiting_user': 'Needs your input',
    'human_assignment_receipt.state.completed': 'Work completed',
    'human_assignment_receipt.state.failed': 'Work failed',
    'human_assignment_receipt.state.cancelling': 'Cancelling',
    'human_assignment_receipt.state.waiting_device': 'Waiting for device',
    'human_assignment_receipt.state.blocked_policy': 'Automatic acceptance blocked',
    'human_assignment_receipt.state.cancelled': 'Cancelled',
    'human_assignment_receipt.state.superseded': 'Reassigned',
    'human_assignment_receipt.configure': 'Configure my assistant',
    'human_assignment_receipt.open_task': 'Open assistant conversation',
    'human_assignment_receipt.open_delivery': 'View delivery',
    'human_assignment_receipt.reason.assistant_disabled':
      'The default assistant is paused. The assignee can resume intake in assistant settings.',
    'human_assignment_receipt.reason.project_not_authorized':
      'The assignee must add this project under assistant settings → Connections.',
    'human_assignment_receipt.reason.automatic_disabled':
      'The assignee must enable automatic processing in this project connection’s handling settings.',
    'human_assignment_receipt.reason.tag_mismatch':
      'Issue tags do not match. The assignee can review tag filters in the project connection.',
    'human_assignment_receipt.reason.no_authorized_assistant':
      'The assignee must configure a default assistant and authorize this project.',
    'human_assignment_receipt.reason.waiting_device':
      'The assistant device is unavailable. The assignee must connect it; processing resumes when it reconnects.',
    'human_assignment_receipt.reason.device_state_unavailable':
      'The assistant device status is unavailable. The assignee should check its connection.',
    'human_assignment_receipt.reason.device_offline':
      'The assistant device is offline. The assignee must reconnect it.',
    'human_assignment_receipt.reason.no_registered_device':
      'The assignee must connect and register the assistant device.',
    'human_assignment_receipt.reason.permission_denied':
      'The assignee cannot execute this Issue. Contact the project administrator.',
    'human_assignment_receipt.reason.superseded': 'The assignee has changed.',
    'human_assignment_receipt.reason.issue_closed': 'The Issue is closed.',
    'human_assignment_receipt.reason.cancelled': 'This assistant assignment was cancelled.',
    'human_assignment_receipt.reason.cancelling': 'This assistant assignment is stopping.',
    'human_assignment_receipt.reason.unavailable':
      'The assistant cannot continue. The assignee should check its configuration.',
    'human_assistant.ai_generated': 'AI generated',
    'human_assistant.publisher': 'Published by {{name}}',
    'human_assistant.confirmed': 'Confirmed',
    'human_assistant.unconfirmed': 'Unconfirmed',
    'human_assistant.execution': 'Execution #{{id}}',
  },
}
