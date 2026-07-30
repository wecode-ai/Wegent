import { Check, Cloud, Copy, HardDrive, Plus, Search, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CloudLoopItem, CloudMyWorkItem, CloudProjectMember } from '@/api/deliveries'
import { formatRelativeSidebarTime } from '@/components/layout/runtimeSidebarTime'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { memberAvatarClasses, memberNameById } from './todoShared'

export interface ProjectsHomeProject {
  id: string
  name: string
  location: 'local' | 'cloud'
  updated_at: string
}

interface CloudProjectsHomeProps {
  projects: ProjectsHomeProject[]
  projectCounts: Record<string, number>
  projectMembers: Record<string, CloudProjectMember[]>
  projectItems: Record<string, CloudLoopItem[]>
  myWork: CloudMyWorkItem[]
  searchQuery: string
  onCreateProject: () => void
  onSelectProject: (projectId: string) => void
  onManageProject: (projectId: string) => void
  onSelectItem: (item: CloudMyWorkItem) => void
  onOpenMyWork: () => void
}

const MAX_RECENT_ACTIVITY = 5
const MAX_MY_TODOS = 5
// The home "all spaces" preview shows this many rows and scrolls for the rest.
const HOME_VISIBLE_SPACE_ROWS = 5
const SPACE_ROW_HEIGHT_PX = 45
const WEEK_MS = 7 * 86_400_000

function isWithinLastWeek(timestamp: string | null | undefined, nowMs: number): boolean {
  if (!timestamp) return false
  const valueMs = new Date(timestamp).getTime()
  return !Number.isNaN(valueMs) && valueMs >= nowMs - WEEK_MS
}

function matchesQuery(project: ProjectsHomeProject, query: string): boolean {
  if (!query) return true
  return project.name.toLowerCase().includes(query)
}

interface ProjectSpaceRowProps {
  project: ProjectsHomeProject
  members: CloudProjectMember[]
  openLabel: string
  manageLabel: string
  localLabel: string
  taskCountLabel: string
  memberCountLabel: string
  onOpen: () => void
  onManage?: () => void
}

function ProjectSpaceRow({
  project,
  members,
  openLabel,
  manageLabel,
  localLabel,
  taskCountLabel,
  memberCountLabel,
  onOpen,
  onManage,
}: ProjectSpaceRowProps) {
  const LocationIcon = project.location === 'local' ? HardDrive : Cloud
  const { t } = useTranslation('common')
  const [copied, setCopied] = useState(false)

  const copyProjectId = async () => {
    await copyTextToClipboard(String(project.id))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group grid h-11 w-full cursor-pointer grid-cols-[minmax(0,1fr)_64px_84px_108px] items-center border-b border-border px-2 text-left transition hover:bg-muted/60"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <LocationIcon className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="truncate text-sm font-medium">{project.name}</span>
      </span>
      <span className="text-xs text-text-muted">{taskCountLabel}</span>
      <span className="text-xs text-text-muted">{project.updated_at.slice(5, 10)}</span>
      <span className="flex items-center">
        {onManage ? (
          <span className="hidden items-center gap-1 group-hover:flex">
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onOpen()
              }}
              className="rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted"
            >
              {openLabel}
            </button>
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onManage()
              }}
              className="rounded-md px-2 py-1 text-xs text-text-secondary transition hover:bg-muted"
            >
              {manageLabel}
            </button>
          </span>
        ) : null}
        <span className={cn('flex items-center', onManage && 'group-hover:hidden')}>
          {project.location === 'local' ? (
            <span className="text-xs text-text-muted">{localLabel}</span>
          ) : (
            <>
              {members.slice(0, 2).map((member, memberIndex) => (
                <span
                  key={member.user_id}
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background ring-2 ring-background',
                    memberAvatarClasses[memberIndex % memberAvatarClasses.length],
                    memberIndex > 0 && '-ml-1'
                  )}
                >
                  {member.user_name.slice(0, 1).toUpperCase()}
                </span>
              ))}
              <span className="ml-1.5 text-xs text-text-muted">{memberCountLabel}</span>
            </>
          )}
        </span>
        <button
          type="button"
          data-testid={`cloud-project-copy-id-${project.id}`}
          onClick={event => {
            event.stopPropagation()
            void copyProjectId()
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-muted hover:text-text-primary"
          aria-label={
            copied
              ? t('todo.project_id_copied', '项目 ID 已复制')
              : t('todo.copy_project_id', '复制项目 ID')
          }
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </span>
    </div>
  )
}

export function CloudProjectsHome({
  projects,
  projectCounts,
  projectMembers,
  projectItems,
  myWork,
  searchQuery,
  onCreateProject,
  onSelectProject,
  onManageProject,
  onSelectItem,
  onOpenMyWork,
}: CloudProjectsHomeProps) {
  const { t } = useTranslation('common')
  const query = searchQuery.trim().toLowerCase()
  const visibleProjects = useMemo(
    () => projects.filter(project => matchesQuery(project, query)),
    [projects, query]
  )

  const allItems = useMemo(() => Object.values(projectItems).flat(), [projectItems])
  const completedCount = useMemo(
    () => allItems.filter(item => item.status === 'completed').length,
    [allItems]
  )
  const inProgressCount = useMemo(
    () => allItems.filter(item => item.status === 'in_progress').length,
    [allItems]
  )
  // "This week" stats are computed against a single timestamp captured at
  // mount; Date.now() is not allowed during render by react-hooks/purity.
  const [nowMs] = useState(() => Date.now())
  const weeklyNewCount = useMemo(() => {
    return allItems.filter(item => isWithinLastWeek(item.created_at, nowMs)).length
  }, [allItems, nowMs])
  const weeklyCompletedCount = useMemo(() => {
    return allItems.filter(
      item => item.status === 'completed' && isWithinLastWeek(item.completed_at, nowMs)
    ).length
  }, [allItems, nowMs])

  const recentActivity = useMemo(
    () =>
      [...allItems]
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, MAX_RECENT_ACTIVITY),
    [allItems]
  )
  const myTodos = useMemo(
    () => myWork.filter(item => item.status !== 'completed').slice(0, MAX_MY_TODOS),
    [myWork]
  )
  const sortedProjects = useMemo(
    () => [...visibleProjects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [visibleProjects]
  )

  const [manageOpen, setManageOpen] = useState(false)
  const [manageQuery, setManageQuery] = useState('')
  const manageProjects = useMemo(
    () => sortedProjects.filter(project => matchesQuery(project, manageQuery.trim().toLowerCase())),
    [sortedProjects, manageQuery]
  )

  const stats = [
    { label: t('todo.home_stat_projects', '项目空间总数'), value: projects.length },
    { label: t('todo.home_stat_total_items', '总任务数'), value: allItems.length },
    { label: t('todo.home_stat_completed', '已完成任务'), value: completedCount },
    { label: t('todo.home_stat_week_new', '本周新增'), value: weeklyNewCount },
    { label: t('todo.home_stat_week_completed', '本周完成'), value: weeklyCompletedCount },
    { label: t('todo.home_stat_in_progress', '进行中'), value: inProgressCount },
  ]

  const statusLabels: Record<CloudLoopItem['status'], string> = {
    inbox: t('todo.status_inbox', '收集箱'),
    pending: t('todo.status_pending', '待开始'),
    in_progress: t('todo.status_in_progress', '进行中'),
    in_review: t('todo.status_in_review', '待确认'),
    completed: t('todo.status_completed', '已完成'),
  }

  const projectNameById = useMemo(
    () => new Map(projects.map(project => [String(project.id), project.name])),
    [projects]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[880px]">
        <div className="flex items-start">
          <div>
            <h1 className="text-heading-md font-semibold">{t('todo.projects_home', '项目空间')}</h1>
            <p className="mt-1 text-sm text-text-muted">
              {t('todo.projects_home_subtitle', '跨项目的个人工作台与项目空间概览')}
            </p>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="cloud-projects-home-create"
            onClick={onCreateProject}
            className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" /> {t('todo.new_project_space', '新建项目空间')}
          </button>
        </div>

        <div className="mt-6 grid grid-cols-6 gap-3">
          {stats.map(stat => (
            <div key={stat.label} className="rounded-xl border border-border px-4 py-3.5">
              <div className="text-heading-md font-semibold">{stat.value}</div>
              <div className="mt-0.5 text-xs text-text-muted">{stat.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-7 grid grid-cols-2 gap-9">
          <section>
            <header className="mb-1 flex items-center text-sm font-semibold">
              {t('todo.home_recent_activity', '最近动态')}
              <button
                type="button"
                onClick={onOpenMyWork}
                className="ml-auto text-xs font-normal text-text-muted transition hover:text-text-primary"
              >
                {t('todo.home_view_all', '全部')} →
              </button>
            </header>
            {recentActivity.length === 0 ? (
              <p className="px-2 py-3 text-sm text-text-muted">
                {t('todo.home_no_activity', '暂无动态')}
              </p>
            ) : (
              recentActivity.map((item, itemIndex) => {
                const projectId = String(item.cloud_project_id)
                const actorName =
                  memberNameById(projectMembers[projectId] ?? [], item.assignee_user_id) ??
                  item.created_by_user_name ??
                  memberNameById(projectMembers[projectId] ?? [], item.created_by_user_id) ??
                  t('todo.home_activity_someone', '有人')
                const actionLabel =
                  item.status === 'completed'
                    ? t('todo.home_activity_completed', '完成了任务')
                    : t('todo.home_activity_updated', '更新了任务')
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectProject(projectId)}
                    className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2.5 text-left transition hover:bg-muted/60"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-background',
                        memberAvatarClasses[itemIndex % memberAvatarClasses.length]
                      )}
                    >
                      {actorName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        <span className="font-medium">
                          {actorName} {actionLabel}「{item.title}」
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-text-muted">
                        {projectNameById.get(projectId) ?? ''} · {statusLabels[item.status]}
                      </span>
                    </span>
                    <span className="mt-0.5 shrink-0 text-xs text-text-muted">
                      {formatRelativeSidebarTime(item.updated_at)}
                    </span>
                  </button>
                )
              })
            )}
          </section>

          <section>
            <header className="mb-1 flex items-center text-sm font-semibold">
              {t('todo.home_my_todos', '待我处理')}
              <button
                type="button"
                data-testid="cloud-projects-home-my-work"
                onClick={onOpenMyWork}
                className="ml-auto text-xs font-normal text-text-muted transition hover:text-text-primary"
              >
                {t('todo.my_work', '我的工作')} →
              </button>
            </header>
            {myTodos.length === 0 ? (
              <p className="px-2 py-3 text-sm text-text-muted">
                {t('todo.home_no_todos', '暂无待处理事项')}
              </p>
            ) : (
              myTodos.map(item => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`cloud-projects-home-todo-${item.id}`}
                  onClick={() => onSelectItem(item)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-muted/60"
                >
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      item.status === 'in_review' ? 'bg-violet-500' : 'bg-indigo-500'
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                  <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                    {item.project_key}
                  </span>
                </button>
              ))
            )}
          </section>
        </div>

        <section className="mt-8">
          <header className="mb-1 flex items-center text-sm font-semibold">
            {t('todo.home_all_spaces', '全部空间')}
            <button
              type="button"
              data-testid="cloud-projects-home-manage"
              onClick={() => {
                setManageQuery('')
                setManageOpen(true)
              }}
              className="ml-auto inline-flex items-center gap-1 text-xs font-normal text-text-muted transition hover:text-text-primary"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t('todo.home_manage', '管理')}
            </button>
          </header>
          <div
            className="overflow-y-auto border-t border-border"
            style={{ maxHeight: HOME_VISIBLE_SPACE_ROWS * SPACE_ROW_HEIGHT_PX }}
          >
            {sortedProjects.map(project => (
              <ProjectSpaceRow
                key={project.id}
                project={project}
                members={projectMembers[project.id] ?? []}
                openLabel={t('todo.home_open', '打开')}
                manageLabel={t('todo.home_manage', '管理')}
                localLabel={t('todo.location_local', '本地')}
                taskCountLabel={t('todo.home_task_count', '{{count}} 任务', {
                  count: projectCounts[project.id] ?? 0,
                })}
                memberCountLabel={t('todo.home_member_count', '{{count}} 人', {
                  count: (projectMembers[project.id] ?? []).length,
                })}
                onOpen={() => onSelectProject(project.id)}
              />
            ))}
          </div>
        </section>

        <p className="mt-5 text-xs text-text-muted">
          {t(
            'todo.projects_home_footnote',
            '本地空间保存在当前设备；云端空间可与项目成员共享任务、文件和交付。'
          )}
        </p>
      </div>

      {manageOpen && (
        <Modal
          title={t('todo.home_manage_title', '管理项目空间')}
          width="wide"
          onClose={() => setManageOpen(false)}
        >
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-4">
            <div className="relative shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
              <input
                autoFocus
                data-testid="cloud-projects-manage-search"
                value={manageQuery}
                onChange={event => setManageQuery(event.target.value)}
                placeholder={t('todo.home_manage_search', '搜索项目空间')}
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none transition focus:border-text-muted"
              />
            </div>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto border-t border-border">
              {manageProjects.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-text-muted">
                  {t('todo.home_manage_empty', '没有匹配的项目空间')}
                </p>
              ) : (
                manageProjects.map(project => (
                  <ProjectSpaceRow
                    key={project.id}
                    project={project}
                    members={projectMembers[project.id] ?? []}
                    openLabel={t('todo.home_open', '打开')}
                    manageLabel={t('todo.home_manage', '管理')}
                    localLabel={t('todo.location_local', '本地')}
                    taskCountLabel={t('todo.home_task_count', '{{count}} 任务', {
                      count: projectCounts[project.id] ?? 0,
                    })}
                    memberCountLabel={t('todo.home_member_count', '{{count}} 人', {
                      count: (projectMembers[project.id] ?? []).length,
                    })}
                    onOpen={() => {
                      setManageOpen(false)
                      onSelectProject(project.id)
                    }}
                    onManage={() => {
                      setManageOpen(false)
                      onManageProject(project.id)
                    }}
                  />
                ))
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
