import type { CollaborationTranslate } from '../i18n'
import type { CollaborationIssueCardLabels } from './model'

export const boardCardMessages: Record<'zh-CN' | 'en', Record<string, string>> = {
  'zh-CN': {
    'todo.project_actions': '项目操作',
    'todo.current_conversation_goal': '当前会话目标',
    'todo.current_conversation_goal_loading': '正在加载会话目标…',
    'todo.current_conversation_goal_load_failed': '无法加载会话目标，请重试',
    'todo.view_task_progress': '查看进展',
    'todo.view_task_progress_named': '查看进展：{{title}}',
    'todo.task_progress_empty': '暂无任务进展详情',
    'todo.configure_execution_action': '去配置',
    'todo.configure_execution_for_item': '配置“{{title}}”的运行环境',
    'todo.task_progress_count': '{{count}} 个任务',
    'board.card.needs_configuration': '待配置',
    'board.card.archive': '归档任务',
    'board.group.search': '搜索分组字段',
    'board.group.choose': '选择分组字段',
    'board.group.empty': '没有匹配字段',
    'board.card.assignee': '负责人',
    'board.card.unassigned': '未指定',
    'board.card.priority.none': '普通',
    'board.card.priority.low': '低',
    'board.card.priority.medium': '中',
    'board.card.priority.high': '高',
    'board.card.priority.urgent': '紧急',
  },
  en: {
    'todo.project_actions': 'Project actions',
    'todo.current_conversation_goal': 'Current conversation goal',
    'todo.current_conversation_goal_loading': 'Loading conversation goal…',
    'todo.current_conversation_goal_load_failed':
      'Could not load the conversation goal. Try again.',
    'todo.view_task_progress': 'View progress',
    'todo.view_task_progress_named': 'View progress: {{title}}',
    'todo.task_progress_empty': 'No task progress details',
    'todo.configure_execution_action': 'Configure',
    'todo.configure_execution_for_item': 'Configure the runtime for “{{title}}”',
    'todo.task_progress_count': '{{count}} tasks',
    'board.card.needs_configuration': 'Needs configuration',
    'board.card.archive': 'Archive task',
    'board.group.search': 'Search grouping fields',
    'board.group.choose': 'Choose grouping field',
    'board.group.empty': 'No matching fields',
    'board.card.assignee': 'Assignee',
    'board.card.unassigned': 'Unassigned',
    'board.card.priority.none': 'Normal',
    'board.card.priority.low': 'Low',
    'board.card.priority.medium': 'Medium',
    'board.card.priority.high': 'High',
    'board.card.priority.urgent': 'Urgent',
  },
}
export function createIssueBoardCardLabels(
  t: CollaborationTranslate
): CollaborationIssueCardLabels {
  return {
    assignee: t('board.card.assignee'),
    unassigned: t('board.card.unassigned'),
    priority: {
      none: t('board.card.priority.none'),
      low: t('board.card.priority.low'),
      medium: t('board.card.priority.medium'),
      high: t('board.card.priority.high'),
      urgent: t('board.card.priority.urgent'),
    },
  }
}
