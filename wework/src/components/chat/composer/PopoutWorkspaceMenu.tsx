import { DshContributionSlotSurface } from '@/features/dsh-runtime/DshContributionSlotSurface'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { useTranslation } from '@/hooks/useTranslation'
import type { ProjectWithTasks } from '@/types/api'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { composerIconActionDensity, controlPopup } from '@wegent/collaboration/controls/recipes'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { Tooltip } from '@wegent/collaboration/controls/Tooltip'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import { Ellipsis, Folder, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

interface PopoutWorkspaceMenuProps {
  currentProjectId?: number
  disabled?: boolean
  extensionContext?: object
  projectName?: string | null
  projects: ProjectWithTasks[]
  onSelectProject(projectId: number | null): void
}

export function PopoutWorkspaceMenu({
  currentProjectId,
  disabled = false,
  extensionContext = {},
  projectName,
  projects,
  onSelectProject,
}: PopoutWorkspaceMenuProps) {
  const { t } = useTranslation('common')
  const theme = useCollaborationPortalTheme()
  const [open, setOpen] = useState(false)
  const closeMenu = () => setOpen(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label={t('workbench.popout_workspace_menu')}>
        <PopoverTrigger
          disabled={disabled}
          data-testid="composer-project-menu-button"
          aria-label={t('workbench.popout_workspace_menu')}
          className={
            composerIconActionDensity +
            ' flex shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/40 data-[disabled]:opacity-40'
          }
        >
          <Ellipsis aria-hidden="true" className="h-4 w-4" />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        {...theme}
        data-testid="popout-workspace-menu"
        aria-label={t('workbench.popout_workspace_menu')}
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={8}
        className={`${theme.className} ${controlPopup} w-80 p-2`}
      >
        <SearchableSelect
          value={currentProjectId == null ? '' : String(currentProjectId)}
          testId="popout-workspace-project-button"
          menuTestId="popout-workspace-project-submenu"
          searchTestId="popout-workspace-project-search"
          accessibleLabel={t('workbench.popout_workspace_menu_project')}
          searchPlaceholder={t('workbench.search_projects', '搜索项目')}
          emptyLabel={t('workbench.no_projects', '没有匹配项目')}
          className="w-full"
          triggerContent={
            <>
              <span>{t('workbench.popout_workspace_menu_project')}</span>
              <Folder className="h-4 w-4" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">
                {projectName || t('workbench.popout_workspace_menu_no_project')}
              </span>
            </>
          }
          options={[
            {
              value: '',
              label: t('workbench.popout_workspace_menu_no_project'),
              testId: 'popout-workspace-no-project-option',
            },
            ...projects.map(project => ({
              value: String(project.id),
              label: project.name,
              testId: `popout-workspace-project-option-${project.id}`,
            })),
          ]}
          onChange={value => {
            onSelectProject(value ? Number(value) : null)
            closeMenu()
          }}
        />
        <DshContributionSlotSurface
          attachedClassName="contents"
          props={{ closeMenu, context: extensionContext }}
          slot={WEWORK_DSH_SLOTS.workspaceMenuSection}
        />
        <div className="mt-2 flex min-h-11 items-center justify-between gap-4 border-t border-border px-2 pt-2 text-sm">
          <span>{t('workbench.popout_workspace_menu_permission')}</span>
          <span className="flex items-center gap-2 text-warning">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            {t('workbench.popout_workspace_menu_full_access')}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
