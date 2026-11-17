import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus } from 'lucide-react'
import type { CollaborationMember, ProjectCreateTarget } from '@wegent/collaboration'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TransientNotice } from '@/components/common/TransientNotice'
import { TitlebarActionsPortal } from '@/components/topnav/TitlebarActionsPortal'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { User } from '@/types/api'
import { createLocalWorkspaceApi } from './localWorkspaceApi'
import { ProjectSpaceCreateDialog } from './ProjectSpaceCreateDialog'
import { projectSpaceContentRoute } from './projectSpaceRoute'

export function TaskBoardProjectCreateAction({
  services,
  user,
  active = true,
}: {
  services: WorkbenchServices
  user: User
  active?: boolean
}) {
  const { t, i18n } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const clearNotice = useCallback(() => setNotice(null), [])
  const onMembersConfigured = useCallback(
    async (_projectId: string, members: CollaborationMember[]) => {
      setNotice(
        t('workbench.project_create_members_confirmed', {
          members: members.map(member => member.user_name).join(', '),
        })
      )
    },
    [t]
  )
  const targets = useMemo(() => {
    const local = createLocalWorkspaceApi(
      services.projectSpaceApis?.local ?? services.projectSpaceDetailServices?.local?.deliveryApi,
      Number(user.id),
      user.user_name,
      user.email ?? null,
      services.projectSpaceDetailServices?.local,
      i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
    )
    const available: ProjectCreateTarget[] = []
    if (local) available.push({ location: 'local', create: local.projects.create })
    const cloud = services.sharedWorkspaceApi
    if (cloud) {
      available.push({ location: 'cloud', create: input => cloud.projects.create(input) })
    }
    return available
  }, [i18n.language, services, user.email, user.id, user.user_name])
  return (
    <>
      {active && (
        <TitlebarActionsPortal>
          <ActionMenu
            ariaLabel={t('workbench.more', '更多')}
            testId="task-board-header-more"
            placement="bottom-end"
            triggerClassName="electron-titlebar-interactive-region flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:h-8 md:w-8"
            items={[
              {
                label: t('todo.new_project_space', '新建项目空间'),
                icon: Plus,
                testId: 'task-board-create-project-space',
                onSelect: () => setOpen(true),
              },
            ]}
          />
        </TitlebarActionsPortal>
      )}
      {open && (
        <ProjectSpaceCreateDialog
          targets={targets}
          defaultLocation={services.projectSpaceApis?.defaultLocation ?? 'cloud'}
          api={services.sharedWorkspaceApi}
          user={user}
          onMembersConfigured={onMembersConfigured}
          onClose={() => setOpen(false)}
          onCreated={(project, location) => {
            setOpen(false)
            navigateTo(
              projectSpaceContentRoute({
                projectId: project.id,
                projectStore: location === 'local' ? 'local' : 'backend',
              })
            )
          }}
        />
      )}
      {notice &&
        createPortal(<TransientNotice message={notice} onClear={clearNotice} />, document.body)}
    </>
  )
}
