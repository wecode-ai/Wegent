import { useMemo, type ComponentProps } from 'react'
import {
  ProjectCreateDialog,
  projectCreateLabels,
  type CollaborationMember,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { ApiError } from '@/api/http'
import { createProjectResourceSetup } from '@/features/collaboration/createProjectResourceSetup'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import type { User } from '@/types/api'
import { CloudTodoModal } from './CloudTodoModal'
import { parseDingTalkAITableLink } from './projectProviderConfig'

type ProjectSpaceCreateDialogProps = Pick<
  ComponentProps<typeof ProjectCreateDialog>,
  'targets' | 'defaultLocation' | 'onClose' | 'onCreated'
> & {
  api?: SharedWorkspaceApi
  user: Pick<User, 'id' | 'user_name'>
  onMembersConfigured?: (projectId: string, members: CollaborationMember[]) => Promise<void>
}

const membersConfigured = async () => undefined

function projectRequestError(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : '创建项目空间失败'
  }
  if (cause.status === 422) {
    const payload = cause.detail as { errors?: Array<{ loc?: string[]; msg?: string }> } | undefined
    const fieldError = payload?.errors?.[0]
    return fieldError?.msg
      ? `${fieldError.loc?.at(-1) ?? '参数'}：${fieldError.msg}`
      : '项目标识只能包含 2–16 位字母和数字'
  }
  if (cause.status === 404) {
    return '项目空间接口返回 404，请重启当前分支的 Backend 后重试'
  }
  return cause.message || `创建项目空间失败（HTTP ${cause.status}）`
}

export function ProjectSpaceCreateDialog({
  api,
  user,
  onMembersConfigured = membersConfigured,
  ...props
}: ProjectSpaceCreateDialogProps) {
  const { t, i18n } = useTranslation('common')
  const resourceSetup = useMemo(
    () =>
      createProjectResourceSetup(
        api,
        { id: Number(user.id), name: user.user_name },
        onMembersConfigured,
        t('workbench.project_create_members_verification_failed')
      ),
    [api, onMembersConfigured, t, user.id, user.user_name]
  )
  return (
    <ProjectCreateDialog
      {...props}
      resourceSetup={resourceSetup}
      allowDingTalkAITable
      labels={projectCreateLabels[i18n.language.startsWith('zh') ? 'zh-CN' : 'en']}
      host={{
        renderModal: ({ title, children, onClose, closeLabel }) => (
          <CloudTodoModal title={title} width="wide" onClose={onClose} closeLabel={closeLabel}>
            {children}
          </CloudTodoModal>
        ),
        parseDingTalkAITableLink,
        formatError: projectRequestError,
        track: event => {
          if (event === 'created') {
            track('feature_action_completed', { domain: 'project_space', action: 'create' })
          } else {
            track('operation_failed', { operation: 'project_space_action' })
          }
        },
      }}
    />
  )
}
