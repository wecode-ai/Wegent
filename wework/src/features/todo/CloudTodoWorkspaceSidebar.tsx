import { Check, Cloud, Copy, Ellipsis, HardDrive, Plus, Search } from 'lucide-react'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import { ProjectSpaceSidebar } from '@wegent/collaboration'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { DesktopSidebarAccount } from '@/components/layout/DesktopSidebarAccount'
import { DesktopSidebarHeader } from '@/components/layout/DesktopSidebarPrimitives'
import { Tooltip } from '@/components/ui/tooltip'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { projectSpaceKey, projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import type { CloudTodoWorkspaceViewModel } from './CloudTodoWorkspaceView'
export function CloudTodoWorkspaceSidebar({ model }: { model: CloudTodoWorkspaceViewModel }) {
  const {
    user,
    embedded,
    onOpenSettings,
    onLogout,
    t,
    projects,
    selectedProjectRef,
    collaborationProjectCounts,
    isMyTasksBoard,
    setProjectView,
    setSelectedItem,
    setCreateProjectOpen,
    createTodoOpen,
    setCreateTodoOpen,
    issueComposerOpen,
    setIssueComposerOpen,
    setGlobalSearchOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    setRenameProject,
    setRenameProjectName,
    setRenameError,
    archiveBusy,
    setArchiveProject,
    setArchiveError,
    selectProject,
    openIssueCreation,
  } = model
  return (
    <>
      {!embedded ? (
        <aside
          className={cn(
            'relative shrink-0 overflow-hidden border-r border-border bg-[rgb(var(--color-sidebar))] transition-[width,background-color] duration-200 wework:border-black/[0.08]',
            sidebarCollapsed ? 'w-0 border-r-0' : 'w-[240px]'
          )}
        >
          <ProjectSpaceSidebar
            header={
              <DesktopSidebarHeader
                actionsTestId="cloud-todo-sidebar-chrome-controls"
                actions={
                  <>
                    <DesktopWindowControls
                      sidebarCollapsed={false}
                      onToggleSidebar={() => setSidebarCollapsed(true)}
                      className="gap-0"
                      toggleTestId="cloud-todo-collapse-sidebar"
                    />
                    <Tooltip label={t('workbench.search')} side="bottom" align="end">
                      <button
                        type="button"
                        data-testid="cloud-search-toggle"
                        onClick={() => setGlobalSearchOpen(true)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none keyboard:focus-visible:ring-1 keyboard:focus-visible:ring-focus wework:keyboard:focus-visible:ring-blue-500"
                        aria-label={t('workbench.search')}
                      >
                        <Search className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </>
                }
              />
            }
            navItems={[
              {
                icon: <Plus className="h-4 w-4 text-current" />,
                label: isMyTasksBoard
                  ? t('todo.new_task', '新建任务')
                  : t('todo.new_issue', '新建 Issue'),
                testId: 'cloud-create-issue',
                selected: issueComposerOpen || createTodoOpen,
                onClick: () => openIssueCreation(),
              },
            ]}
            sectionLabel={t('todo.boards', '看板')}
            addLabel={t('todo.new_project_space', '新建项目空间')}
            addIcon={<Plus className="mx-auto h-3.5 w-3.5" />}
            onAdd={() => setCreateProjectOpen(true)}
            onSelectProject={spaceKey => {
              const project = projects.find(
                candidate => projectSpaceKey(projectSpaceRef(candidate)) === spaceKey
              )
              if (!project) return
              setIssueComposerOpen(false)
              setCreateTodoOpen(false)
              selectProject(project)
              setProjectView('board')
              setSelectedItem(null)
            }}
            labels={{
              actions: t('todo.project_actions', '项目操作'),
              archive: '归档项目',
              copied: t('todo.project_id_copied', '项目 ID 已复制'),
              copyId: t('todo.copy_project_id', '复制项目 ID'),
              rename: '修改项目名称',
            }}
            moreIcon={<Ellipsis className="h-3.5 w-3.5" />}
            checkIcon={<Check className="h-3.5 w-3.5 text-success wework:text-green-600" />}
            copyIcon={<Copy className="h-3.5 w-3.5" />}
            projects={projects.map(project => {
              const ProjectLocationIcon = project.location === 'local' ? HardDrive : Cloud
              const spaceKey = projectSpaceKey(projectSpaceRef(project))
              return {
                actionsAvailable: !isDefaultWorkItemProject(project),
                canManage:
                  !isDefaultWorkItemProject(project) &&
                  (project.created_by_user_id === user.id ||
                    project.access_role === 'Owner' ||
                    project.access_role === 'Maintainer'),
                count: collaborationProjectCounts[spaceKey],
                icon: (
                  <ProjectLocationIcon className="h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]" />
                ),
                id: String(project.id),
                key: spaceKey,
                name: project.name,
                selected: sameProjectSpace(selectedProjectRef, projectSpaceRef(project)),
                archiveDisabled: archiveBusy,
                onArchive: () => {
                  setArchiveError(null)
                  setArchiveProject(project)
                },
                onCopyId: () => copyTextToClipboard(String(project.id)),
                onRename: () => {
                  setRenameProject(project)
                  setRenameProjectName(project.name)
                  setRenameError(null)
                },
              }
            })}
            renderTooltip={({ align, children, className, label, side }) => (
              <Tooltip label={label} side={side} align={align} className={className}>
                {children}
              </Tooltip>
            )}
            account={
              onOpenSettings && onLogout ? (
                <DesktopSidebarAccount
                  user={user}
                  onOpenSettings={onOpenSettings}
                  onLogout={onLogout}
                />
              ) : null
            }
          />
        </aside>
      ) : null}
    </>
  )
}
