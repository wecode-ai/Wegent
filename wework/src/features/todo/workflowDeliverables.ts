import type { DeliverableRequirement, DeliverableValueType } from '@/api/deliveries'

export function createWorkflowDeliverableRequirement(
  requirements: DeliverableRequirement[]
): DeliverableRequirement {
  let index = requirements.length + 1
  while (requirements.some(requirement => requirement.id === `deliverable-${index}`)) index += 1
  return {
    id: `deliverable-${index}`,
    name: '',
    description: '',
    value_type: 'file',
    file_constraints: {
      accepted_types: [],
      min_files: 1,
      max_files: 1,
    },
  }
}

export function workflowDeliverableTypeLabel(
  type: DeliverableValueType,
  t: (key: string, fallback: string) => string
): string {
  if (type === 'text') return t('todo.deliverable_type_text', '文本')
  if (type === 'file') return t('todo.deliverable_type_file', '文件')
  if (type === 'code_snapshot') return t('todo.deliverable_type_code_snapshot', '代码快照')
  if (type === 'git_branch') return t('todo.deliverable_type_git_branch', 'Git 分支')
  if (type === 'pull_request') return t('todo.deliverable_type_pull_request', 'PR/MR')
  return t('todo.deliverable_type_url', '链接')
}
