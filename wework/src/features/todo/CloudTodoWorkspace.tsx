import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Cloud,
  Copy,
  Ellipsis,
  GitBranch,
  Grid3X3,
  HardDrive,
  ListTodo,
  LockKeyhole,
  Plus,
  Search,
} from 'lucide-react'
import type {
  CloudLoopItem,
  CloudMyWorkItem,
  CloudProject,
  CloudProjectMember,
} from '@/api/deliveries'
import type { AITableField } from '@/api/aitable'
import { ApiError } from '@/api/http'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import {
  DesktopSidebarHeader,
  DesktopSidebarNavItem,
} from '@/components/layout/DesktopSidebarPrimitives'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import type {
  DeliveryApi,
  ProjectSpaceLocation,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { AITableView } from '@/features/todo/AITableView'
import type { ProjectWithTasks, User as UserProfile } from '@/types/api'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { CloudMyWorkView } from './CloudMyWorkView'
import {
  CloudTodoBoardCard,
  CloudTodoCardContent,
  type BoardCardDisplaySettings,
} from './CloudTodoBoardCard'
import { CloudProjectManageView } from './CloudProjectManageView'
import { CloudProjectsHome } from './CloudProjectsHome'
import { CloudFilesView } from './CloudFilesView'
import {
  ProjectSpaceChatSidebar,
  type ProjectSpaceChatLaunchRequest,
} from './ProjectSpaceChatSidebar'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { parseDingTalkAITableLink, repositoryProviderConfig } from './projectProviderConfig'
import { TaskSearchPanel } from './TaskSearchPanel'
import { TodoEditor } from './TodoEditor'
import { emptyTaskSearchFilters, type TaskSearchFilters } from './taskSearch'
import { boardStatusColorClasses, columnDotClasses, columns, reorderLaneItems } from './todoShared'

type ProjectView = 'board' | 'table' | 'files' | 'manage'
type RootView = 'projects' | 'my-work'
type ProjectTaskProvider = 'local' | 'github' | 'gitlab' | 'dingtalk_aitable'
type NativeBoardGroupBy = 'status' | 'priority' | 'assignee' | 'tag'

const nativeBoardGroupFields: AITableField[] = [
  { id: 'status', name: '状态', type: 'status', config: null, raw: {} },
  { id: 'priority', name: '优先级', type: 'singleSelect', config: null, raw: {} },
  { id: 'assignee', name: '负责人', type: 'user', config: null, raw: {} },
  { id: 'tag', name: '标签', type: 'tag', config: null, raw: {} },
]

const nativeBoardStatusColors: Record<
  CloudLoopItem['status'],
  'gray' | 'blue' | 'orange' | 'purple' | 'green'
> = {
  inbox: 'gray',
  pending: 'blue',
  in_progress: 'orange',
  in_review: 'purple',
  completed: 'green',
}

function aitableCellLabels(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return []
  return (Array.isArray(value) ? value : [value])
    .map(entry => {
      if (typeof entry === 'object' && entry !== null) {
        const object = entry as Record<string, unknown>
        return String(object.name ?? object.title ?? object.text ?? '')
      }
      return String(entry)
    })
    .filter(Boolean)
}

function AITableGroupFieldPicker({
  fields,
  value,
  onChange,
  testIdPrefix = 'dingtalk-board-group',
  searchPlaceholder = '搜索表格字段',
}: {
  fields: AITableField[]
  value: string
  onChange: (fieldId: string) => void
  testIdPrefix?: string
  searchPlaceholder?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = fields.find(field => field.id === value)
  const visibleFields = fields
    .filter(field => `${field.name} ${field.type}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => {
      const recommended = (field: AITableField) =>
        /状态|负责人|优先级|所属项目/.test(field.name) ? 0 : 1
      return recommended(left) - recommended(right)
    })

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={`${testIdPrefix}-by`}
        onClick={() => setOpen(current => !current)}
        className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted"
        aria-expanded={open}
      >
        <span className="max-w-32 truncate">{selected?.name ?? '选择分组字段'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-40 w-64 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-lg">
          <label className="flex h-8 items-center gap-2 rounded-lg bg-muted px-2.5 text-text-muted">
            <Search className="h-3.5 w-3.5" />
            <input
              autoFocus
              data-testid={`${testIdPrefix}-search`}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none"
            />
          </label>
          <div className="mt-1 max-h-72 overflow-y-auto overscroll-contain">
            {visibleFields.map(field => (
              <button
                key={field.id}
                type="button"
                data-testid={`${testIdPrefix}-option-${field.id}`}
                onClick={() => {
                  onChange(field.id)
                  setOpen(false)
                  setQuery('')
                }}
                className={cn(
                  'flex h-9 w-full items-center rounded-lg px-2.5 text-left text-sm hover:bg-muted',
                  field.id === value && 'bg-muted font-medium'
                )}
              >
                <span className="min-w-0 flex-1 truncate">{field.name}</span>
                <span className="ml-2 shrink-0 text-xs text-text-muted">{field.type}</span>
                {field.id === value ? <Check className="ml-2 h-3.5 w-3.5" /> : null}
              </button>
            ))}
            {visibleFields.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-text-muted">没有匹配字段</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

interface LocatedCloudProject extends CloudProject {
  location: ProjectSpaceLocation
}

interface AvailableProjectSpaceApi {
  api: DeliveryApi
  location: ProjectSpaceLocation
}

interface CloudTodoWorkspaceProps {
  user: UserProfile
  localProjects: ProjectWithTasks[]
  services: WorkbenchServices
}

const columnEmptyHints: Record<CloudLoopItem['status'], string> = {
  inbox: '新建或拖拽任务到这里收集',
  pending: '拖拽任务到这里等待开始',
  in_progress: '拖拽任务到这里开始处理',
  in_review: '等待确认的任务会显示在这里',
  completed: '已完成的任务会归档在这里',
}

function boardStatusFromDropId(id: string | number | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith('todo-column:')) return null
  return id.slice('todo-column:'.length) || null
}

function boardCardIdFromDropId(id: string | number | undefined): string | null {
  if (typeof id !== 'string' || !id.startsWith('todo-card:')) return null
  return id.slice('todo-card:'.length)
}

// Cards sit inside their lane dropzone, so both match under the pointer.
// Prefer the card target: dropping on a card inserts before it, dropping on
// the lane itself appends at the end.
const boardCollisionDetection: CollisionDetection = args => {
  const collisions = pointerWithin(args)
  const cardCollision = collisions.find(collision => boardCardIdFromDropId(collision.id))
  return cardCollision ? [cardCollision] : collisions.slice(0, 1)
}

function TodoColumnDropzone({ status, children }: { status: string; children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: `todo-column:${status}` })
  return (
    <div
      ref={setNodeRef}
      data-testid={`cloud-todo-column-dropzone-${status}`}
      className={cn(
        'min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-2 pt-2 transition-colors',
        isOver && 'rounded-xl bg-muted ring-1 ring-inset ring-focus/50'
      )}
    >
      {children}
    </div>
  )
}

// Placeholder shown while a project's items load. Renders the familiar board
// column layout with pulsing blocks instead of content, matching the modern
// skeleton ("留白加载") pattern.
function CloudTodoBoardSkeleton() {
  return (
    <div
      data-testid="cloud-todo-board-loading"
      aria-busy="true"
      className="flex h-full min-h-0 items-start gap-3.5 px-6"
    >
      {columns.map((column, columnIndex) => (
        <section
          key={column.status}
          className="flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5"
        >
          <header className="flex items-center px-2.5 pb-2 pt-1.5">
            <span className={cn('mr-2 h-2 w-2 rounded-full', columnDotClasses[column.status])} />
            <span className="text-sm font-semibold">{column.label}</span>
          </header>
          <div className="animate-pulse space-y-2 px-2 pb-2 pt-2">
            {Array.from({ length: columnIndex % 2 === 0 ? 2 : 1 }, (_, cardIndex) => (
              <div
                key={cardIndex}
                className="rounded-xl border border-border bg-background px-3 py-3 shadow-sm"
              >
                <div className="h-3 w-24 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 h-4 w-4/5 rounded-md bg-text-primary/10" />
                <div className="mt-2.5 flex items-center gap-2">
                  <div className="h-4 w-12 rounded-full bg-text-primary/10" />
                  <div className="ml-auto h-3 w-9 rounded-md bg-text-primary/10" />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function cloudProjectRequestError(cause: unknown): string {
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

function ProjectDialog({
  availableApis,
  defaultLocation,
  onClose,
  onCreated,
}: {
  availableApis: AvailableProjectSpaceApi[]
  defaultLocation: ProjectSpaceLocation
  onClose: () => void
  onCreated: (project: CloudProject, location: ProjectSpaceLocation) => void
}) {
  const { t } = useTranslation('common')
  const initialLocation =
    availableApis.find(option => option.location === defaultLocation)?.location ??
    availableApis[0]?.location ??
    'local'
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState<ProjectSpaceLocation>(initialLocation)
  const [taskProvider, setTaskProvider] = useState<ProjectTaskProvider>('local')
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [repositoryAddress, setRepositoryAddress] = useState('')
  const [token, setToken] = useState('')
  const [aitableUrl, setAitableUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const repositoryProvider = taskProvider === 'github' || taskProvider === 'gitlab'
  const isAITableProvider = taskProvider === 'dingtalk_aitable'
  const aitableLink = parseDingTalkAITableLink(aitableUrl)
  const canSubmit = Boolean(
    name.trim() &&
    (!repositoryProvider || repositoryAddress.trim()) &&
    (!isAITableProvider || aitableLink) &&
    !saving
  )

  async function submit() {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const selectedApi = availableApis.find(option => option.location === location)?.api
      if (!selectedApi) throw new Error('所选项目空间位置当前不可用')
      const providerConfig = isAITableProvider
        ? {
            base_id: aitableLink!.baseId,
            table_id: aitableLink!.tableId,
            source_url: aitableLink!.url,
            ...(aitableLink!.viewId ? { view_id: aitableLink!.viewId } : {}),
          }
        : repositoryProvider
          ? {
              ...repositoryProviderConfig(repositoryAddress, taskProvider),
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : {}
      const project = await selectedApi.createCloudProject({
        name: name.trim(),
        description: description.trim(),
        task_provider: taskProvider,
        provider_config: providerConfig,
        ...(location === 'cloud' ? { visibility } : {}),
      })
      onCreated(project, location)
    } catch (cause) {
      setError(cloudProjectRequestError(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="新建项目空间" width="wide" onClose={onClose}>
      <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5 pt-4">
        <label className="block text-sm font-medium text-text-primary">
          名称
          <input
            data-testid="cloud-project-name"
            value={name}
            onChange={event => {
              setName(event.target.value)
              setError(null)
            }}
            className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-base font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
            placeholder="例如：Wegent V4"
            autoFocus
          />
        </label>

        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-text-primary">保存位置</h3>
            <p className="text-xs text-text-muted">创建后不可更改</p>
          </div>
          <div
            className={cn(
              'mt-2 grid gap-2',
              availableApis.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
            )}
          >
            {availableApis.map(option => {
              const selected = location === option.location
              const isLocal = option.location === 'local'
              const LocationIcon = isLocal ? HardDrive : Cloud
              return (
                <button
                  key={option.location}
                  type="button"
                  data-testid={`cloud-project-location-${option.location}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setLocation(option.location)
                    setError(null)
                  }}
                  className={cn(
                    'flex min-h-16 items-start gap-3 rounded-xl border px-3 py-3 text-left transition',
                    selected
                      ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                      : 'border-border hover:bg-muted/40'
                  )}
                >
                  <LocationIcon className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">
                      {isLocal ? '本地空间' : '云端空间'}
                    </span>
                    <span className="mt-0.5 block text-xs leading-4 text-text-muted">
                      {isLocal
                        ? '保存在当前设备，可接入 GitHub 或 GitLab Issues'
                        : '保存在 Wegent 云端，可在不同设备访问'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        {location === 'cloud' && (
          <section>
            <h3 className="text-sm font-medium text-text-primary">
              {t('todo.project_visibility')}
            </h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(
                [
                  [
                    'private',
                    LockKeyhole,
                    t('todo.project_visibility_private'),
                    t('todo.project_visibility_private_description'),
                  ],
                  [
                    'public',
                    Cloud,
                    t('todo.project_visibility_public'),
                    t('todo.project_visibility_public_description'),
                  ],
                ] as const
              ).map(([value, VisibilityIcon, label, detail]) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`cloud-project-visibility-${value}`}
                  aria-pressed={visibility === value}
                  onClick={() => setVisibility(value)}
                  className={cn(
                    'rounded-xl border px-3 py-2.5 text-left transition',
                    visibility === value
                      ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                      : 'border-border hover:bg-muted/40'
                  )}
                >
                  <VisibilityIcon className="h-4 w-4 text-text-secondary" />
                  <span className="mt-2 block text-sm font-medium">{label}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{detail}</span>
                </button>
              ))}
            </div>
            {visibility === 'public' && (
              <p className="mt-2 text-xs leading-4 text-text-muted">
                {t('todo.project_visibility_public_notice')}
              </p>
            )}
          </section>
        )}

        <section>
          <h3 className="text-sm font-medium text-text-primary">任务来源</h3>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(
              [
                ['local', ListTodo, '内置任务', location === 'local' ? '保存在本机' : '保存在云端'],
                ['github', GitBranch, 'GitHub', '读取 Issues'],
                ['gitlab', GitBranch, 'GitLab', '读取 Issues'],
                ['dingtalk_aitable', Grid3X3, '钉钉多维表格', '同步表格记录'],
              ] as const
            ).map(([value, ProviderIcon, label, detail]) => (
              <button
                key={value}
                type="button"
                data-testid={`cloud-project-task-provider-${value}`}
                aria-pressed={taskProvider === value}
                onClick={() => {
                  setTaskProvider(value)
                  setError(null)
                }}
                className={cn(
                  'rounded-xl border px-3 py-2.5 text-left transition',
                  taskProvider === value
                    ? 'border-text-primary bg-muted/70 ring-1 ring-text-primary/10'
                    : 'border-border hover:bg-muted/40'
                )}
              >
                <ProviderIcon className="h-4 w-4 text-text-secondary" />
                <span className="mt-2 block text-sm font-medium">{label}</span>
                <span className="mt-0.5 block text-xs text-text-muted">{detail}</span>
              </button>
            ))}
          </div>
        </section>

        {repositoryProvider && (
          <section className="space-y-4 rounded-xl bg-muted/40 p-3">
            <label className="block text-sm font-medium text-text-primary">
              仓库地址
              <input
                data-testid="cloud-project-provider-repository"
                value={repositoryAddress}
                onChange={event => {
                  setRepositoryAddress(event.target.value)
                  setError(null)
                }}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
                placeholder={
                  taskProvider === 'github'
                    ? 'https://github.com/owner/repository'
                    : 'https://gitlab.com/group/project'
                }
              />
              <span className="mt-1.5 block text-xs font-normal text-text-muted">
                支持 HTTPS、SSH 或 owner/repository 格式；自托管地址会自动识别。
              </span>
            </label>
            <label className="block text-sm font-medium text-text-primary">
              访问令牌
              <span className="ml-1 text-xs font-normal text-text-muted">可选</span>
              <div className="relative mt-2">
                <LockKeyhole className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-muted" />
                <input
                  data-testid="cloud-project-provider-token"
                  type="password"
                  autoComplete="new-password"
                  value={token}
                  onChange={event => setToken(event.target.value)}
                  className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
                  placeholder="私有仓库需要访问令牌"
                />
              </div>
              <span className="mt-1.5 block text-xs font-normal text-text-muted">
                {location === 'cloud'
                  ? '令牌会加密保存在 Wegent Backend，并安全下发给本地 Executor。'
                  : '令牌会加密保存在当前设备，不会写入项目文件。'}
              </span>
            </label>
          </section>
        )}

        {isAITableProvider && (
          <section className="space-y-4 rounded-xl bg-muted/40 p-3">
            <label className="block text-sm font-medium text-text-primary">
              多维表格链接
              <input
                data-testid="cloud-project-aitable-url"
                value={aitableUrl}
                onChange={event => {
                  setAitableUrl(event.target.value)
                  setError(null)
                }}
                className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                placeholder="粘贴 alidocs.dingtalk.com 多维表格链接"
              />
              {aitableUrl && !aitableLink ? (
                <span className="mt-1.5 block text-xs font-normal text-destructive">
                  无法识别这个链接，请复制打开多维表格后的完整浏览器地址。
                </span>
              ) : (
                <span className="mt-1.5 block text-xs font-normal text-text-muted">
                  将自动识别表格和当前数据表，无需查找内部 ID。
                </span>
              )}
            </label>
            <p className="text-xs text-text-muted">
              表格读写统一由本机 Executor 通过 DWS
              执行。创建后连接钉钉账号，并确保该账号已获得此表格权限。
            </p>
          </section>
        )}

        <label className="block text-sm font-medium text-text-primary">
          说明
          <span className="ml-1 text-xs font-normal text-text-muted">可选</span>
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
            className="mt-2 h-20 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm font-normal text-text-primary outline-none transition focus:border-focus focus:ring-2 focus:ring-focus/15"
            placeholder="这个项目空间用于什么？"
          />
        </label>

        {error && (
          <p
            className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-text-primary transition hover:bg-muted"
        >
          取消
        </button>
        <button
          type="button"
          data-testid="cloud-project-create-confirm"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="h-8 rounded-lg bg-text-primary px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50"
        >
          {saving ? '正在创建…' : '创建项目'}
        </button>
      </footer>
    </Modal>
  )
}

export function CloudTodoWorkspace({ user, localProjects, services }: CloudTodoWorkspaceProps) {
  const { t } = useTranslation('common')
  const projectSpaceApis = useMemo(() => {
    if (services.projectSpaceApis) return services.projectSpaceApis
    return {
      cloud: services.deliveryApi,
      defaultLocation: 'cloud' as const,
    }
  }, [services])
  const availableProjectSpaceApis = useMemo(
    () =>
      (['local', 'cloud'] as const).flatMap(location => {
        const api = projectSpaceApis[location]
        return api ? [{ api, location }] : []
      }),
    [projectSpaceApis]
  )
  const [projects, setProjects] = useState<LocatedCloudProject[]>([])
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>({})
  const [projectMembers, setProjectMembers] = useState<Record<string, CloudProjectMember[]>>({})
  // Every project's loop items, cached for the projects-home overview
  // (stats, recent activity). Keyed by project id.
  const [projectItems, setProjectItems] = useState<Record<string, CloudLoopItem[]>>({})
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [items, setItems] = useState<CloudLoopItem[]>([])
  // Which project's items are currently in `items`. Anything else rendered on
  // the board would be stale, so the board shows the skeleton instead.
  const [itemsProjectId, setItemsProjectId] = useState<string | null>(null)
  const [myWork, setMyWork] = useState<CloudMyWorkItem[]>([])
  const [rootView, setRootView] = useState<RootView>('projects')
  const [projectView, setProjectView] = useState<ProjectView>('board')
  const [selectedItem, setSelectedItem] = useState<CloudLoopItem | null>(null)
  // Items of the detail drawer's project when it differs from the board project,
  // so the drawer can stay open without switching the board view.
  const [detailItems, setDetailItems] = useState<CloudLoopItem[]>([])
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createTodoOpen, setCreateTodoOpen] = useState(false)
  const [createTodoParent, setCreateTodoParent] = useState<CloudLoopItem | null>(null)
  const [createTodoStatus, setCreateTodoStatus] = useState<CloudLoopItem['status']>('inbox')
  const [boardParentId, setBoardParentId] = useState<string | null>(null)
  const [projectAssistantOpen, setProjectAssistantOpen] = useState(false)
  const [conversationLaunchRequest, setConversationLaunchRequest] =
    useState<ProjectSpaceChatLaunchRequest | null>(null)
  const [aitableFields, setAitableFields] = useState<AITableField[]>([])
  const [aitableGroupFieldId, setAitableGroupFieldId] = useState('')
  const [aitableGroupFilter, setAitableGroupFilter] = useState('')
  const [aitableBoardQuery, setAitableBoardQuery] = useState('')
  const [nativeGroupBy, setNativeGroupBy] = useState<NativeBoardGroupBy>('status')
  const [nativeGroupFilter, setNativeGroupFilter] = useState('')
  const [nativeBoardQuery, setNativeBoardQuery] = useState('')
  const [groupScopeBusy, setGroupScopeBusy] = useState(false)
  const [activeDragItemId, setActiveDragItemId] = useState<string | null>(null)
  const boardSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [projectSearchOpen, setProjectSearchOpen] = useState(false)
  const [projectSearchQuery, setProjectSearchQuery] = useState('')
  const [projectSearchFilters, setProjectSearchFilters] =
    useState<TaskSearchFilters>(emptyTaskSearchFilters)
  const projectHeaderRef = useRef<HTMLElement>(null)
  const projectHeaderContentRef = useRef<HTMLDivElement>(null)
  const projectHeaderTabsRef = useRef<HTMLElement>(null)
  const projectHeaderAskAiRef = useRef<HTMLButtonElement>(null)
  const projectHeaderSearchRef = useRef<HTMLButtonElement>(null)
  const projectHeaderTagRef = useRef<HTMLSpanElement>(null)
  const projectHeaderAddRef = useRef<HTMLButtonElement>(null)
  const projectHeaderNaturalWidthsRef = useRef({
    tabs: 0,
    askAi: 0,
    search: 0,
    tag: 0,
    add: 0,
  })
  const [projectHeaderLevel, setProjectHeaderLevel] = useState(0)

  useLayoutEffect(() => {
    const header = projectHeaderRef.current
    const content = projectHeaderContentRef.current
    if (!header || !content) return

    const compute = () => {
      if (header.clientWidth <= 0) return
      const style = getComputedStyle(header)
      const base =
        header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const rememberWidth = (
        key: keyof typeof projectHeaderNaturalWidthsRef.current,
        el: HTMLElement | null
      ) => {
        const measured = el?.getBoundingClientRect().width ?? 0
        if (measured > projectHeaderNaturalWidthsRef.current[key]) {
          projectHeaderNaturalWidthsRef.current[key] = measured
        }
        return projectHeaderNaturalWidthsRef.current[key] > 0
          ? projectHeaderNaturalWidthsRef.current[key] + 8
          : 0
      }
      const contentW = content.scrollWidth
      const tabsW = rememberWidth('tabs', projectHeaderTabsRef.current)
      const askAiW = projectAssistantOpen
        ? 0
        : rememberWidth('askAi', projectHeaderAskAiRef.current)
      const searchW = rememberWidth('search', projectHeaderSearchRef.current)
      const tagW = rememberWidth('tag', projectHeaderTagRef.current)
      const addW = rememberWidth('add', projectHeaderAddRef.current)
      const tabsDropdownW = 96
      const compactControlW = 48

      const usedAt = (lv: number): number => {
        let used = contentW + 8
        used += lv < 2 ? tabsW : tabsDropdownW
        used += lv >= 1 ? compactControlW : searchW
        used += lv >= 1 ? (tagW > 0 ? compactControlW : 0) : tagW
        if (!projectAssistantOpen) used += lv >= 1 ? compactControlW : askAiW
        used += lv >= 1 ? compactControlW : addW
        return used
      }

      let next = 0
      while (next < 2 && usedAt(next) > base) next += 1
      setProjectHeaderLevel(next)
    }

    compute()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(compute)
    observer.observe(header)
    return () => observer.disconnect()
  }, [items, projectAssistantOpen, projectHeaderLevel, projectView, selectedProjectId])

  const [loading, setLoading] = useState(true)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [copiedProjectId, setCopiedProjectId] = useState<string | null>(null)
  const [projectMenuId, setProjectMenuId] = useState<string | null>(null)
  const [renameProject, setRenameProject] = useState<LocatedCloudProject | null>(null)
  const [renameProjectName, setRenameProjectName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [archiveProject, setArchiveProject] = useState<LocatedCloudProject | null>(null)
  const [archiveItem, setArchiveItem] = useState<CloudLoopItem | null>(null)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState<string | null>(null)
  useEffect(() => {
    if (projectMenuId === null) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('[data-cloud-project-menu-root]')
      ) {
        setProjectMenuId(null)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProjectMenuId(null)
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [projectMenuId])
  // Applies a freshly fetched board snapshot. `boardError` distinguishes a
  // loaded-but-empty project (renders empty columns) from a failed fetch
  // (renders the skeleton plus the error banner instead of an empty board).
  const applyBoardItems = useCallback(
    (projectId: string, fetchedItems: CloudLoopItem[], error: string | null) => {
      setItems(fetchedItems)
      setItemsProjectId(projectId)
      setBoardError(error)
    },
    []
  )
  const selectedProject = projects.find(project => project.id === selectedProjectId) ?? null
  const apiForProjectId = useCallback(
    (projectId: string) => {
      const project = projects.find(candidate => candidate.id === projectId)
      if (project?.task_provider === 'dingtalk_aitable' && projectSpaceApis.local) {
        return projectSpaceApis.local
      }
      return (
        (project ? projectSpaceApis[project.location] : undefined) ??
        services.deliveryApi ??
        availableProjectSpaceApis[0]?.api
      )
    },
    [availableProjectSpaceApis, projectSpaceApis, projects, services.deliveryApi]
  )
  const selectedProjectApi = selectedProject ? apiForProjectId(selectedProject.id) : undefined
  const isAITableProject = selectedProject?.task_provider === 'dingtalk_aitable'
  const boardCardDisplay: BoardCardDisplaySettings = {
    showAssignee: selectedProject?.card_display?.show_assignee ?? true,
    showPriority: selectedProject?.card_display?.show_priority ?? true,
    showTags: selectedProject?.card_display?.show_tags ?? true,
    showDate: selectedProject?.card_display?.show_date ?? true,
  }
  const personalGroupKey = selectedProject
    ? `wework-board-group:${user.id}:${selectedProject.id}`
    : null
  const nativeStatuses =
    selectedProject?.board_config?.statuses ??
    columns.map(column => ({
      id: column.status,
      name: column.label,
      color: nativeBoardStatusColors[column.status],
    }))

  useEffect(() => {
    if (!selectedProject || isAITableProject) return
    const personal = personalGroupKey ? localStorage.getItem(personalGroupKey) : null
    // The selected project changes the external localStorage key we synchronize from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNativeGroupBy(
      personal === 'status' ||
        personal === 'priority' ||
        personal === 'assignee' ||
        personal === 'tag'
        ? personal
        : (selectedProject.board_config?.group_by ?? 'status')
    )
  }, [isAITableProject, personalGroupKey, selectedProject])

  const selectedGroupField = aitableFields.find(field => field.id === aitableGroupFieldId)
  const configuredGroupValues = Array.isArray(selectedGroupField?.config?.options)
    ? selectedGroupField.config.options.flatMap(option => aitableCellLabels(option))
    : []
  const aitableGroupValues = Array.from(
    new Set([
      ...configuredGroupValues,
      ...items.flatMap(item => aitableCellLabels(item.source_cells?.[aitableGroupFieldId])),
      ...(items.some(item => !aitableCellLabels(item.source_cells?.[aitableGroupFieldId]).length)
        ? ['未设置']
        : []),
    ])
  )
  // Distinct tags across the project (registry plus item usage), used by the
  // board tag grouping and filter.
  const availableTags = Array.from(
    new Set([...(selectedProject?.tags ?? []), ...items.flatMap(item => item.tags ?? [])])
  ).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  const boardColumns = isAITableProject
    ? aitableGroupValues.map((groupValue, index) => ({
        key: `field-${aitableGroupFieldId}-${groupValue}`,
        label: groupValue,
        status: 'inbox' as CloudLoopItem['status'],
        sourceStatus: null,
        groupValue,
        dotClass: ['bg-zinc-400', 'bg-indigo-500', 'bg-amber-500', 'bg-violet-500'][index % 4],
      }))
    : nativeGroupBy === 'priority'
      ? (['none', 'low', 'medium', 'high', 'urgent'] as const).map(priority => ({
          key: `priority-${priority}`,
          label: priority === 'none' ? '普通' : priority,
          status: 'inbox',
          sourceStatus: null,
          groupValue: priority,
          dotClass: columnDotClasses[priority] ?? 'bg-zinc-400',
        }))
      : nativeGroupBy === 'assignee'
        ? [
            ...Array.from(
              new Map(
                [
                  ...(selectedProject ? (projectMembers[selectedProject.id] ?? []) : []),
                  ...items.flatMap(item =>
                    item.assignee_user_id && item.assignee_name
                      ? [{ user_id: item.assignee_user_id, user_name: item.assignee_name }]
                      : []
                  ),
                ].map(member => [member.user_id, member])
              ).values()
            ).map(member => ({
              key: `assignee-${member.user_id}`,
              label: member.user_name,
              status: 'inbox',
              sourceStatus: null,
              groupValue: String(member.user_id),
              dotClass: 'bg-indigo-500',
            })),
            {
              key: 'assignee-unassigned',
              label: '未指定',
              status: 'inbox',
              sourceStatus: null,
              groupValue: '',
              dotClass: 'bg-zinc-400',
            },
          ]
        : nativeGroupBy === 'tag'
          ? [
              ...availableTags.map(tag => ({
                key: `tag-${tag}`,
                label: tag,
                status: 'inbox' as CloudLoopItem['status'],
                sourceStatus: null,
                groupValue: tag,
                dotClass: 'bg-zinc-400',
              })),
              {
                key: 'tag-untagged',
                label: '无标签',
                status: 'inbox' as CloudLoopItem['status'],
                sourceStatus: null,
                groupValue: '',
                dotClass: 'bg-zinc-400',
              },
            ]
          : nativeStatuses.map(status => ({
              key: status.id,
              label: status.name,
              status: status.id,
              sourceStatus: null,
              groupValue: status.id,
              dotClass:
                boardStatusColorClasses[status.color] ??
                columnDotClasses[status.id] ??
                'bg-zinc-400',
            }))
  const aitableApi = isAITableProject ? services.aitableApi : undefined

  useEffect(() => {
    if (!isAITableProject || !selectedProject || !aitableApi) return
    let active = true
    void aitableApi
      .describe(selectedProject.id)
      .then(description => {
        if (!active) return
        setAitableFields(description.fields)
        const mapping = selectedProject.provider_config.board_mapping
        const mappedStatus =
          typeof mapping === 'object' && mapping !== null
            ? (mapping as Record<string, unknown>).status_field_id
            : null
        const defaultField =
          description.fields.find(field => field.id === mappedStatus) ??
          description.fields.find(field => /select|member|checkbox/i.test(field.type)) ??
          description.fields[0]
        setAitableGroupFieldId(current =>
          description.fields.some(field => field.id === current)
            ? current
            : (defaultField?.id ?? '')
        )
      })
      .catch(cause => {
        if (active) setBoardError(cause instanceof Error ? cause.message : '读取钉钉字段失败')
      })
    return () => {
      active = false
    }
  }, [aitableApi, isAITableProject, selectedProject])

  useEffect(() => {
    if (!services.aitableApi) return
    let active = true
    for (const project of projects) {
      if (project.task_provider === 'dingtalk_aitable') {
        void services.aitableApi
          .configureProject(project)
          .then(async () => {
            const api = projectSpaceApis.local
            if (!api) return
            const response = await api.listLoopItems(project.id)
            if (!active) return
            setProjectCounts(current => ({ ...current, [project.id]: response.items.length }))
            setProjectItems(current => ({ ...current, [project.id]: response.items }))
          })
          .catch(() => {})
      }
    }
    return () => {
      active = false
    }
  }, [projectSpaceApis.local, projects, services.aitableApi])
  const canCreateBoardTask = selectedProject !== null
  // Only render board items that belong to the selected project. On a project
  // switch this flips to the skeleton in the same render, before the fetch.
  // `boardError` distinguishes a failed fetch (skeleton stays) from a
  // successfully loaded but empty project (renders the empty columns).
  const boardItemsLoading =
    selectedProject !== null &&
    (itemsProjectId !== selectedProjectId || (items.length === 0 && !boardError))
  const selectedItemApi = selectedItem ? apiForProjectId(selectedItem.cloud_project_id) : undefined
  // Source for the detail drawer / creation dialog when the selected todo lives
  // in a project other than the one shown on the board.
  const detailAllItems =
    selectedItem && selectedItem.cloud_project_id !== selectedProjectId ? detailItems : items
  const createTodoProject = createTodoParent
    ? (projects.find(project => project.id === createTodoParent.cloud_project_id) ?? null)
    : selectedProject
  const createTodoApi = createTodoProject ? apiForProjectId(createTodoProject.id) : undefined
  const boardParent = items.find(item => item.id === boardParentId) ?? null
  const boardLayerCount = items.filter(item => item.parent_id === boardParentId).length
  const boardBreadcrumb: CloudLoopItem[] = []
  let breadcrumbItem = boardParent
  const breadcrumbIds = new Set<string>()
  while (breadcrumbItem && !breadcrumbIds.has(breadcrumbItem.id)) {
    boardBreadcrumb.unshift(breadcrumbItem)
    breadcrumbIds.add(breadcrumbItem.id)
    breadcrumbItem = items.find(candidate => candidate.id === breadcrumbItem?.parent_id) ?? null
  }

  function selectProject(projectId: string | null) {
    setSelectedProjectId(projectId)
    setProjectView('board')
    setBoardParentId(null)
    setNativeGroupFilter('')
    setNativeBoardQuery('')
    setProjectSearchOpen(false)
    setProjectSearchQuery('')
    setProjectSearchFilters(emptyTaskSearchFilters)
  }

  async function renameSelectedProject() {
    if (!renameProject) return
    const api = apiForProjectId(renameProject.id)
    if (!api) throw new Error('项目空间接口当前不可用')
    setRenameBusy(true)
    setRenameError(null)
    try {
      const updated = await api.updateCloudProject(renameProject.id, {
        name: renameProjectName.trim(),
        version: renameProject.version,
      })
      setProjects(current =>
        current.map(project =>
          project.id === updated.id ? { ...updated, location: project.location } : project
        )
      )
      setRenameProject(null)
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : '修改项目名称失败')
    } finally {
      setRenameBusy(false)
    }
  }

  async function confirmArchiveProject() {
    if (!archiveProject || archiveBusy) return
    const api = apiForProjectId(archiveProject.id)
    if (!api) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      await api.archiveCloudProject(archiveProject.id, archiveProject.version)
      setProjects(current => current.filter(project => project.id !== archiveProject.id))
      setProjectCounts(current => {
        const next = { ...current }
        delete next[archiveProject.id]
        return next
      })
      if (selectedProjectId === archiveProject.id) selectProject(null)
      setArchiveProject(null)
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : '归档项目失败')
    } finally {
      setArchiveBusy(false)
    }
  }

  async function confirmArchiveItem() {
    if (!archiveItem || archiveBusy) return
    const api = apiForProjectId(archiveItem.cloud_project_id)
    if (!api) return
    setArchiveBusy(true)
    setArchiveError(null)
    try {
      await api.archiveLoopItem(archiveItem.id)
      const archivedIds = new Set([archiveItem.id])
      let changed = true
      while (changed) {
        changed = false
        for (const candidate of items) {
          if (
            candidate.parent_id &&
            archivedIds.has(candidate.parent_id) &&
            !archivedIds.has(candidate.id)
          ) {
            archivedIds.add(candidate.id)
            changed = true
          }
        }
      }
      setItems(current => current.filter(item => !archivedIds.has(item.id)))
      setProjectItems(current => ({
        ...current,
        [archiveItem.cloud_project_id]: (current[archiveItem.cloud_project_id] ?? []).filter(
          item => !archivedIds.has(item.id)
        ),
      }))
      setProjectCounts(current => ({
        ...current,
        [archiveItem.cloud_project_id]: Math.max(
          0,
          (current[archiveItem.cloud_project_id] ?? 0) - archivedIds.size
        ),
      }))
      if (boardParentId && archivedIds.has(boardParentId)) setBoardParentId(null)
      if (selectedItem && archivedIds.has(selectedItem.id)) setSelectedItem(null)
      setArchiveItem(null)
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : '归档任务失败')
    } finally {
      setArchiveBusy(false)
    }
  }

  useEffect(() => {
    const handleGlobalSearchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setGlobalSearchOpen(true)
      } else if (event.key === 'Escape') {
        setGlobalSearchOpen(false)
        setProjectSearchOpen(false)
      }
    }
    window.addEventListener('keydown', handleGlobalSearchShortcut)
    return () => window.removeEventListener('keydown', handleGlobalSearchShortcut)
  }, [])

  function openTodoCreation(
    parent: CloudLoopItem | null,
    status: CloudLoopItem['status'] = 'inbox'
  ) {
    setCreateTodoParent(parent)
    setCreateTodoStatus(status)
    setCreateTodoOpen(true)
  }

  useEffect(() => {
    let active = true
    void Promise.all(
      availableProjectSpaceApis.map(async ({ api, location }) => {
        let response
        try {
          response = await api.listCloudProjects()
        } catch {
          return { details: [], projects: [] }
        }
        const projects = response.items.map(project => ({ ...project, location }))
        const details = await Promise.all(
          projects.map(async project => {
            const [loopItemsResult, membersResult] = await Promise.allSettled([
              api.listLoopItems(project.id),
              api.listCloudProjectMembers(project.id),
            ])
            const loopItems =
              loopItemsResult.status === 'fulfilled' ? loopItemsResult.value.items : []
            const members = membersResult.status === 'fulfilled' ? membersResult.value : []
            return [project.id, loopItems.length, members, loopItems] as const
          })
        )
        return { details, projects }
      })
    )
      .then(results => {
        if (!active) return
        const details = results.flatMap(result => result.details)
        setProjects(results.flatMap(result => result.projects))
        setProjectCounts(Object.fromEntries(details.map(([id, count]) => [id, count])))
        setProjectMembers(Object.fromEntries(details.map(([id, , members]) => [id, members])))
        setProjectItems(Object.fromEntries(details.map(([id, , , loopItems]) => [id, loopItems])))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [availableProjectSpaceApis])
  useEffect(() => {
    if (!selectedProjectId || !selectedProjectApi) return
    let active = true
    const refreshItems = () => {
      const prepare =
        selectedProject?.task_provider === 'dingtalk_aitable' && services.aitableApi
          ? services.aitableApi.configureProject(selectedProject)
          : Promise.resolve()
      void prepare
        .then(() => selectedProjectApi.listLoopItems(selectedProjectId))
        .then(response => {
          if (!active) return
          applyBoardItems(selectedProjectId, response.items, null)
          // Keep the projects-home cache in sync with the board fetch.
          setProjectItems(current => ({ ...current, [selectedProjectId]: response.items }))
          // Only sync the open drawer when it belongs to this project; a drawer
          // opened from another view (e.g. my work) must not be closed here.
          setSelectedItem(current =>
            current && current.cloud_project_id === selectedProjectId
              ? (response.items.find(item => item.id === current.id) ?? null)
              : current
          )
        })
        .catch(error => {
          console.error('[Wework project board] issue refresh failed', {
            projectId: selectedProjectId,
            error,
          })
          if (!active) return
          applyBoardItems(
            selectedProjectId,
            [],
            error instanceof Error ? error.message : '任务加载失败'
          )
        })
    }
    refreshItems()
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshItems()
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [applyBoardItems, selectedProject, selectedProjectApi, selectedProjectId, services.aitableApi])
  useEffect(() => {
    if (rootView !== 'my-work' && !(rootView === 'projects' && !selectedProjectId)) return
    void Promise.all(availableProjectSpaceApis.map(({ api }) => api.listMyWork())).then(responses =>
      setMyWork(responses.flatMap(response => response.items))
    )
  }, [availableProjectSpaceApis, rootView, selectedProjectId])
  // Load the drawer project's items when the drawer shows a todo from a project
  // other than the one on the board, so subtasks and parent options stay correct.
  useEffect(() => {
    if (!selectedItem || selectedItem.cloud_project_id === selectedProjectId) return
    const detailApi = apiForProjectId(selectedItem.cloud_project_id)
    if (!detailApi) return
    let active = true
    void detailApi.listLoopItems(selectedItem.cloud_project_id).then(response => {
      if (active) setDetailItems(response.items)
    })
    return () => {
      active = false
    }
  }, [apiForProjectId, selectedItem, selectedProjectId])

  function openTaskConversation(item: CloudLoopItem) {
    selectProject(item.cloud_project_id)
    setConversationLaunchRequest({
      id: Date.now(),
      item: {
        id: item.id,
        title: item.title,
        description: item.description,
        status: item.status,
      },
      localProjectId: null,
    })
    setSelectedItem(null)
    setProjectAssistantOpen(true)
  }

  async function moveItem(itemId: string, columnKey: string, beforeItemId: string | null = null) {
    const item = items.find(candidate => candidate.id === itemId)
    const column = boardColumns.find(candidate => candidate.key === columnKey)
    if (!item || !column || item.can_edit === false || isAITableProject) return
    const reordered =
      nativeGroupBy === 'status'
        ? reorderLaneItems(items, itemId, column.status, beforeItemId)
        : null
    const previousItems = items
    if (reordered) {
      setItems(reordered.items)
    } else {
      setItems(current =>
        current.map(candidate => {
          if (candidate.id !== itemId) return candidate
          if (nativeGroupBy === 'priority') {
            return { ...candidate, priority: column.groupValue as CloudLoopItem['priority'] }
          }
          if (nativeGroupBy === 'assignee') {
            return {
              ...candidate,
              assignee_user_id: column.groupValue ? Number(column.groupValue) : null,
            }
          }
          return { ...candidate, tags: column.groupValue ? [column.groupValue] : [] }
        })
      )
    }
    setBoardError(null)
    try {
      const itemApi = apiForProjectId(item.cloud_project_id)
      if (!itemApi) throw new Error('项目空间当前不可用')
      const update =
        nativeGroupBy === 'status'
          ? { status: column.status }
          : nativeGroupBy === 'priority'
            ? { priority: column.groupValue as CloudLoopItem['priority'] }
            : nativeGroupBy === 'assignee'
              ? { assignee_user_id: column.groupValue ? Number(column.groupValue) : null }
              : { tags: column.groupValue ? [column.groupValue] : [] }
      const updated = await itemApi.updateLoopItem(item.id, { version: item.version, ...update })
      setItems(current =>
        current.map(candidate => (candidate.id === updated.id ? updated : candidate))
      )
      setSelectedItem(current => (current?.id === updated.id ? updated : current))
      if (reordered) {
        await itemApi.reorderLoopItems(item.cloud_project_id, {
          parent_id: item.parent_id,
          status: column.status,
          item_ids: reordered.laneIds,
        })
      }
    } catch (cause) {
      setItems(previousItems)
      setBoardError(cause instanceof Error ? cause.message : '移动任务失败')
    }
  }

  function finishBoardDrop(event: DragEndEvent) {
    setActiveDragItemId(null)
    const activeId = String(event.active.id)
    const beforeCardId = boardCardIdFromDropId(event.over?.id)
    if (beforeCardId) {
      if (beforeCardId === activeId) return
      const target = items.find(candidate => candidate.id === beforeCardId)
      const targetColumn = target
        ? boardColumns.find(column => {
            if (nativeGroupBy === 'priority') return target.priority === column.groupValue
            if (nativeGroupBy === 'assignee') {
              return String(target.assignee_user_id ?? '') === column.groupValue
            }
            if (nativeGroupBy === 'tag') {
              return column.groupValue
                ? (target.tags ?? []).includes(column.groupValue)
                : !(target.tags ?? []).length
            }
            return target.status === column.status
          })
        : null
      if (targetColumn) void moveItem(activeId, targetColumn.key, beforeCardId)
      return
    }
    const status = boardStatusFromDropId(event.over?.id)
    if (status) {
      const column = boardColumns.find(candidate => candidate.key === status)
      if (column) void moveItem(activeId, column.key)
    }
  }

  function savePersonalGroupBy(groupBy: NativeBoardGroupBy) {
    setNativeGroupBy(groupBy)
    setNativeGroupFilter('')
    if (personalGroupKey) localStorage.setItem(personalGroupKey, groupBy)
  }

  async function saveGlobalGroupBy() {
    if (!selectedProject || groupScopeBusy) return
    const projectApi = projectSpaceApis[selectedProject.location] ?? selectedProjectApi
    if (!projectApi) return
    setGroupScopeBusy(true)
    setBoardError(null)
    try {
      const updated = await projectApi.updateCloudProject(selectedProject.id, {
        version: selectedProject.version,
        board_config: {
          group_by: nativeGroupBy,
          statuses: nativeStatuses,
        },
      })
      if (personalGroupKey) localStorage.removeItem(personalGroupKey)
      setProjects(current =>
        current.map(project =>
          project.id === updated.id ? { ...updated, location: project.location } : project
        )
      )
    } catch (cause) {
      setBoardError(cause instanceof Error ? cause.message : '保存全局分组失败')
    } finally {
      setGroupScopeBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'absolute inset-0 z-content flex min-h-0 w-full overflow-hidden bg-background text-text-primary'
      )}
      data-testid="cloud-todo-workspace"
    >
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className={cn(
            'relative shrink-0 overflow-hidden border-r border-black/[0.08] bg-[rgb(var(--color-sidebar))] transition-[width,background-color] duration-200',
            sidebarCollapsed ? 'w-0 border-r-0' : 'w-[240px]'
          )}
        >
          <div className="flex h-full w-[240px] flex-col px-1.5 pt-1.5">
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
                  <button
                    type="button"
                    data-testid="cloud-search-toggle"
                    onClick={() => setGlobalSearchOpen(true)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500"
                    title={t('workbench.search')}
                    aria-label={t('workbench.search')}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </>
              }
            />
            <nav className="space-y-0.5">
              <DesktopSidebarNavItem
                icon={Cloud}
                label="项目空间"
                selected={rootView === 'projects'}
                onClick={() => {
                  setRootView('projects')
                  selectProject(null)
                  setSelectedItem(null)
                }}
              />
              <DesktopSidebarNavItem
                icon={CircleUserRound}
                label="我的工作"
                testId="cloud-my-work"
                selected={rootView === 'my-work'}
                onClick={() => setRootView('my-work')}
              />
            </nav>
            <div className="mt-6 flex h-[30px] items-center px-2.5 text-xs font-medium text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
              项目空间
              <button
                type="button"
                data-testid="cloud-project-add"
                onClick={() => setCreateProjectOpen(true)}
                className="ml-auto h-6 w-6 rounded-md hover:bg-muted"
              >
                <Plus className="mx-auto h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
              {projects.map(project => {
                const ProjectLocationIcon = project.location === 'local' ? HardDrive : Cloud
                return (
                  <div
                    key={project.id}
                    data-cloud-project-menu-root
                    className={cn(
                      'group relative flex h-[30px] w-full items-center rounded-[10px] px-0 text-base leading-5',
                      rootView === 'projects' && selectedProjectId === project.id
                        ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
                        : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
                    )}
                  >
                    <button
                      type="button"
                      data-testid={`cloud-sidebar-project-${project.id}`}
                      onClick={() => {
                        selectProject(project.id)
                        setRootView('projects')
                        setProjectView('board')
                        setSelectedItem(null)
                      }}
                      className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 text-base"
                    >
                      <ProjectLocationIcon className="h-4 w-4 shrink-0 text-[rgb(var(--color-sidebar-text-muted))]" />
                      <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                    </button>
                    {projectCounts[project.id] ? (
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center text-xs text-[rgb(var(--color-sidebar-text-muted))] group-hover:hidden">
                        {projectCounts[project.id]}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`cloud-sidebar-project-more-${project.id}`}
                      onClick={() => {
                        setProjectMenuId(current => (current === project.id ? null : project.id))
                      }}
                      className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-muted))] transition hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] focus:flex group-hover:flex"
                      aria-expanded={projectMenuId === project.id}
                      aria-label={t('todo.project_actions', '项目操作')}
                    >
                      <Ellipsis className="h-3.5 w-3.5" />
                    </button>
                    {projectMenuId === project.id ? (
                      <div
                        data-testid={`cloud-sidebar-project-menu-${project.id}`}
                        role="menu"
                        className="absolute right-0 top-8 z-30 w-36 rounded-lg border border-border bg-background p-1 shadow-md"
                      >
                        {project.created_by_user_id === user.id ||
                        project.access_role === 'Owner' ||
                        project.access_role === 'Maintainer' ? (
                          <>
                            <button
                              type="button"
                              data-testid={`cloud-sidebar-rename-project-${project.id}`}
                              onClick={() => {
                                setRenameProject(project)
                                setRenameProjectName(project.name)
                                setRenameError(null)
                                setProjectMenuId(null)
                              }}
                              role="menuitem"
                              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                            >
                              <span className="w-3.5 text-center" aria-hidden="true">
                                Aa
                              </span>
                              修改项目名称
                            </button>
                            <button
                              type="button"
                              data-testid={`cloud-sidebar-archive-project-${project.id}`}
                              onClick={() => {
                                setArchiveError(null)
                                setArchiveProject(project)
                                setProjectMenuId(null)
                              }}
                              role="menuitem"
                              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-red-600 hover:bg-muted"
                            >
                              <span className="w-3.5 text-center" aria-hidden="true">
                                ×
                              </span>
                              归档项目
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          data-testid={`cloud-sidebar-copy-project-id-${project.id}`}
                          onClick={() => {
                            void copyTextToClipboard(String(project.id)).then(() => {
                              setCopiedProjectId(project.id)
                              window.setTimeout(() => setCopiedProjectId(null), 2000)
                            })
                            setProjectMenuId(null)
                          }}
                          role="menuitem"
                          className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
                        >
                          {copiedProjectId === project.id ? (
                            <Check className="h-3.5 w-3.5 text-green-600" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          {copiedProjectId === project.id
                            ? t('todo.project_id_copied', '项目 ID 已复制')
                            : t('todo.copy_project_id', '复制项目 ID')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!selectedProject && (
            <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
          )}
          {sidebarCollapsed && (
            <div
              data-testid="cloud-todo-collapsed-chrome-controls"
              className="absolute left-2 top-0 z-20 flex h-[38px] items-center gap-1"
            >
              <DesktopWindowControls
                sidebarCollapsed
                onToggleSidebar={() => setSidebarCollapsed(false)}
                className="gap-1"
                toggleTestId="cloud-todo-expand-sidebar"
              />
            </div>
          )}
          {rootView === 'my-work' ? (
            <CloudMyWorkView
              items={myWork}
              // Open the detail drawer in place instead of jumping to the board.
              onSelectItem={item => {
                if (item.can_view_detail !== false) setSelectedItem(item)
              }}
            />
          ) : loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              正在加载项目空间…
            </div>
          ) : !selectedProject && projects.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center">
              <Cloud className="h-8 w-8 text-text-muted" />
              <h1 className="mt-4 text-heading-md font-semibold">创建第一个项目空间</h1>
              <p className="mt-2 text-sm text-text-muted">
                共享任务、文件与交付，让成员和 AI 在不同本地工作区协作。
              </p>
              <button
                type="button"
                onClick={() => setCreateProjectOpen(true)}
                className="mt-5 h-8 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
              >
                新建项目空间
              </button>
            </div>
          ) : !selectedProject ? (
            <CloudProjectsHome
              projects={projects}
              projectCounts={projectCounts}
              projectMembers={projectMembers}
              projectItems={projectItems}
              myWork={myWork}
              searchQuery=""
              onCreateProject={() => setCreateProjectOpen(true)}
              onSelectProject={projectId => selectProject(projectId)}
              onManageProject={projectId => {
                selectProject(projectId)
                setProjectView('manage')
              }}
              onSelectItem={item => {
                if (item.can_view_detail !== false) setSelectedItem(item)
              }}
              onOpenMyWork={() => setRootView('my-work')}
            />
          ) : (
            <>
              <header
                ref={projectHeaderRef}
                data-testid="cloud-project-header"
                className={cn(
                  'relative z-10 flex h-[52px] shrink-0 items-center border-b border-border bg-background pr-6',
                  sidebarCollapsed ? 'pl-[240px]' : 'pl-6'
                )}
              >
                <MacOSTitleBarDragRegion className="absolute inset-0 z-0 h-full w-full" />
                <div
                  ref={projectHeaderContentRef}
                  className="relative z-10 flex min-w-0 items-center"
                >
                  {selectedProject.location === 'local' ? (
                    <HardDrive className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : (
                    <Cloud className="h-4 w-4 shrink-0 text-text-muted" />
                  )}
                  <span className="ml-2 min-w-0 truncate text-base font-semibold">
                    {selectedProject.name}
                  </span>
                  <span className="ml-2 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-muted">
                    {selectedProject.location === 'local' ? '本地' : '云端'}
                  </span>
                </div>
                {projectHeaderLevel < 2 ? (
                  <nav
                    ref={projectHeaderTabsRef}
                    className="relative z-10 ml-8 flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
                  >
                    <button
                      type="button"
                      data-testid="cloud-project-board-view"
                      onClick={() => setProjectView('board')}
                      className={cn(
                        'rounded-md px-3.5 py-1 text-sm',
                        projectView === 'board'
                          ? 'bg-background font-medium text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      )}
                    >
                      看板
                    </button>
                    {isAITableProject && aitableApi ? (
                      <button
                        type="button"
                        data-testid="cloud-project-table-view"
                        onClick={() => setProjectView('table')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'table'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        数据视图
                      </button>
                    ) : null}
                    {selectedProject.access_role !== 'RestrictedAnalyst' && (
                      <button
                        type="button"
                        onClick={() => setProjectView('files')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'files'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        文件
                      </button>
                    )}
                    {['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner') && (
                      <button
                        type="button"
                        data-testid="cloud-project-manage-view"
                        onClick={() => setProjectView('manage')}
                        className={cn(
                          'rounded-md px-3.5 py-1 text-sm',
                          projectView === 'manage'
                            ? 'bg-background font-medium text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        )}
                      >
                        管理
                      </button>
                    )}
                  </nav>
                ) : (
                  <span
                    ref={projectHeaderTabsRef}
                    className="relative z-10 ml-2 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary"
                  >
                    <select
                      aria-label="视图切换"
                      value={projectView}
                      onChange={event => setProjectView(event.target.value as ProjectView)}
                      className="h-8 cursor-pointer bg-transparent text-xs outline-none"
                    >
                      <option value="board">看板</option>
                      {isAITableProject && aitableApi ? (
                        <option value="table">数据视图</option>
                      ) : null}
                      {selectedProject.access_role !== 'RestrictedAnalyst' ? (
                        <option value="files">文件</option>
                      ) : null}
                      {['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner') ? (
                        <option value="manage">管理</option>
                      ) : null}
                    </select>
                    <ChevronDown className="h-3 w-3" />
                  </span>
                )}
                <span className="flex-1" />
                {selectedProject && !projectAssistantOpen ? (
                  <button
                    ref={projectHeaderAskAiRef}
                    type="button"
                    data-testid="cloud-project-ask-ai"
                    aria-label="与 AI 沟通"
                    title="与 AI 沟通"
                    onClick={() => {
                      setConversationLaunchRequest(null)
                      setProjectAssistantOpen(true)
                    }}
                    className="relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary transition hover:bg-muted"
                  >
                    <Bot className="h-3.5 w-3.5" />
                    {projectHeaderLevel < 1 ? '与 AI 沟通' : null}
                  </button>
                ) : null}
                {projectView === 'board' && (
                  <>
                    <button
                      ref={projectHeaderSearchRef}
                      type="button"
                      data-testid="cloud-project-task-search-toggle"
                      aria-label="搜索任务"
                      title="搜索任务"
                      onClick={() => setProjectSearchOpen(current => !current)}
                      className="relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary transition hover:bg-muted"
                    >
                      <Search className="h-3.5 w-3.5" />
                      {projectHeaderLevel < 1 ? '搜索任务' : null}
                    </button>
                    {projectSearchOpen && (
                      <TaskSearchPanel
                        items={items}
                        members={projectMembers[selectedProject.id] ?? []}
                        query={projectSearchQuery}
                        filters={projectSearchFilters}
                        tags={availableTags}
                        onQueryChange={setProjectSearchQuery}
                        onFiltersChange={setProjectSearchFilters}
                        onSelect={item => {
                          if (item.can_view_detail === false) return
                          setSelectedItem(item)
                          setProjectSearchOpen(false)
                        }}
                      />
                    )}
                    {canCreateBoardTask && (
                      <button
                        ref={projectHeaderAddRef}
                        type="button"
                        data-testid="cloud-todo-add"
                        aria-label="新建任务"
                        title="新建任务"
                        onClick={() =>
                          openTodoCreation(projectView === 'board' ? boardParent : null)
                        }
                        className="relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {projectHeaderLevel < 1 ? '新建任务' : null}
                      </button>
                    )}
                  </>
                )}
              </header>
              {projectView === 'files' && selectedProjectApi ? (
                <CloudFilesView api={selectedProjectApi} project={selectedProject} />
              ) : projectView === 'table' && isAITableProject && aitableApi ? (
                <AITableView api={aitableApi} project={selectedProject} />
              ) : projectView === 'manage' && selectedProjectApi ? (
                <CloudProjectManageView
                  api={projectSpaceApis[selectedProject.location] ?? selectedProjectApi}
                  aitableApi={aitableApi}
                  dwsApi={services.dwsApi}
                  project={selectedProject}
                  boardCardDisplay={boardCardDisplay}
                  onProjectUpdated={updated =>
                    setProjects(current =>
                      current.map(project =>
                        project.id === updated.id
                          ? { ...updated, location: project.location }
                          : project
                      )
                    )
                  }
                />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col pb-6 pt-4">
                  {isAITableProject ? (
                    <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
                      <AITableGroupFieldPicker
                        fields={aitableFields}
                        value={aitableGroupFieldId}
                        onChange={fieldId => {
                          setAitableGroupFieldId(fieldId)
                          setAitableGroupFilter('')
                        }}
                      />
                      <span className="relative inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary">
                        {aitableGroupFilter || `全部${selectedGroupField?.name ?? '记录'}`}
                        <ChevronDown className="ml-2 h-3 w-3" />
                        <select
                          data-testid="dingtalk-board-assignee-filter"
                          value={aitableGroupFilter}
                          onChange={event => setAitableGroupFilter(event.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="分组值筛选"
                        >
                          <option value="">全部</option>
                          {aitableGroupValues.map(name => (
                            <option key={name} value={name}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </span>
                      <label className="flex h-8 min-w-52 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
                        <Search className="h-3.5 w-3.5" />
                        <input
                          data-testid="dingtalk-board-search"
                          value={aitableBoardQuery}
                          onChange={event => setAitableBoardQuery(event.target.value)}
                          placeholder="搜索记录"
                          className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
                        />
                      </label>
                      <span className="ml-auto text-xs text-text-muted">
                        数据由钉钉托管 · AI 可直接管理
                      </span>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2 px-6 pb-3">
                      <AITableGroupFieldPicker
                        fields={nativeBoardGroupFields}
                        value={nativeGroupBy}
                        testIdPrefix="cloud-board-group"
                        searchPlaceholder="搜索分组字段"
                        onChange={fieldId => savePersonalGroupBy(fieldId as NativeBoardGroupBy)}
                      />
                      <label className="relative inline-flex h-8 cursor-pointer items-center rounded-lg border border-border bg-background px-3 text-xs text-text-secondary hover:bg-muted">
                        <span data-testid="cloud-board-group-filter-label">
                          {nativeGroupFilter
                            ? boardColumns.find(column => column.key === nativeGroupFilter)?.label
                            : `全部${nativeBoardGroupFields.find(field => field.id === nativeGroupBy)?.name ?? '任务'}`}
                        </span>
                        <ChevronDown className="ml-2 h-3 w-3" />
                        <select
                          data-testid="cloud-board-group-filter"
                          value={nativeGroupFilter}
                          onChange={event => setNativeGroupFilter(event.target.value)}
                          className="absolute inset-0 cursor-pointer opacity-0"
                          aria-label="分组值筛选"
                        >
                          <option value="">全部</option>
                          {boardColumns.map(column => (
                            <option key={column.key} value={column.key}>
                              {column.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex h-8 min-w-52 items-center gap-2 rounded-lg border border-border px-2.5 text-xs text-text-muted focus-within:border-focus">
                        <Search className="h-3.5 w-3.5" />
                        <input
                          data-testid="cloud-board-search"
                          value={nativeBoardQuery}
                          onChange={event => setNativeBoardQuery(event.target.value)}
                          placeholder="搜索任务"
                          className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
                        />
                      </label>
                      {personalGroupKey && localStorage.getItem(personalGroupKey) ? (
                        <button
                          type="button"
                          data-testid="cloud-board-save-global"
                          disabled={
                            groupScopeBusy ||
                            !['Owner', 'Maintainer'].includes(
                              selectedProject.access_role ?? 'Owner'
                            )
                          }
                          onClick={() => void saveGlobalGroupBy()}
                          className="h-8 rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
                        >
                          应用到全局
                        </button>
                      ) : null}
                    </div>
                  )}
                  <nav
                    data-testid="cloud-todo-board-breadcrumb"
                    aria-label="任务层级"
                    className="px-6"
                  >
                    {boardParent ? (
                      <>
                        <div className="flex h-7 items-center gap-1 text-xs">
                          <button
                            type="button"
                            onClick={() => setBoardParentId(null)}
                            className="rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary"
                          >
                            顶层任务
                          </button>
                          {boardBreadcrumb.map(parent => (
                            <span key={parent.id} className="flex min-w-0 items-center gap-1">
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                              <button
                                type="button"
                                data-testid={`cloud-todo-board-breadcrumb-${parent.id}`}
                                onClick={() => setBoardParentId(parent.id)}
                                className={cn(
                                  'max-w-48 truncate rounded-lg px-2 py-1 text-text-secondary hover:bg-muted hover:text-text-primary',
                                  parent.id === boardParentId && 'font-medium text-text-primary'
                                )}
                              >
                                {parent.title}
                              </button>
                            </span>
                          ))}
                        </div>
                        <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
                          <h1 className="text-heading-sm font-semibold">{boardParent.title}</h1>
                          <span className="text-xs text-text-muted">
                            {boardLayerCount} 个任务 · 仅显示当前层的直接子任务
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-baseline gap-3 px-2 pb-3.5 pt-1.5">
                        <h1 className="text-heading-sm font-semibold">
                          {isAITableProject ? '父任务' : '顶层任务'}
                        </h1>
                        <span className="text-xs text-text-muted">
                          {boardLayerCount} {isAITableProject ? '条记录' : '个任务'}
                        </span>
                      </div>
                    )}
                  </nav>
                  {boardError && (
                    <p className="mx-6 mb-2 text-xs text-destructive" role="alert">
                      {boardError}
                    </p>
                  )}
                  {boardItemsLoading ? (
                    <div className="min-h-0 flex-1 overflow-x-auto">
                      <CloudTodoBoardSkeleton />
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-x-auto">
                      <DndContext
                        sensors={boardSensors}
                        collisionDetection={boardCollisionDetection}
                        onDragStart={event => setActiveDragItemId(String(event.active.id))}
                        onDragCancel={() => setActiveDragItemId(null)}
                        onDragEnd={finishBoardDrop}
                      >
                        <div className="flex h-full min-h-0 items-start gap-3.5 px-6">
                          {boardColumns.map(column => {
                            const columnItems = items.filter(
                              item =>
                                item.parent_id === boardParentId &&
                                (!isAITableProject ||
                                  !column.groupValue ||
                                  (column.groupValue === '未设置'
                                    ? !aitableCellLabels(item.source_cells?.[aitableGroupFieldId])
                                        .length
                                    : aitableCellLabels(
                                        item.source_cells?.[aitableGroupFieldId]
                                      ).includes(column.groupValue))) &&
                                (isAITableProject ||
                                  (nativeGroupBy === 'status'
                                    ? item.status === column.status
                                    : nativeGroupBy === 'priority'
                                      ? item.priority === column.groupValue
                                      : nativeGroupBy === 'assignee'
                                        ? String(item.assignee_user_id ?? '') === column.groupValue
                                        : column.groupValue
                                          ? (item.tags ?? []).includes(column.groupValue)
                                          : !(item.tags ?? []).length)) &&
                                (isAITableProject ||
                                  !nativeGroupFilter ||
                                  column.key === nativeGroupFilter) &&
                                (isAITableProject ||
                                  !nativeBoardQuery.trim() ||
                                  `${item.title} ${item.description ?? ''}`
                                    .toLowerCase()
                                    .includes(nativeBoardQuery.trim().toLowerCase())) &&
                                (!aitableGroupFilter || column.groupValue === aitableGroupFilter) &&
                                (!aitableBoardQuery.trim() ||
                                  `${item.title} ${item.description ?? ''}`
                                    .toLowerCase()
                                    .includes(aitableBoardQuery.trim().toLowerCase()))
                            )
                            return (
                              <section
                                key={column.key}
                                data-testid={`cloud-todo-column-${column.key}`}
                                className="group flex max-h-full w-[292px] shrink-0 flex-col rounded-2xl bg-muted p-0.5"
                              >
                                <header className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
                                  <span className="flex min-w-0 items-center">
                                    <span
                                      className={cn('mr-2 h-2 w-2 rounded-full', column.dotClass)}
                                    />
                                    <span className="text-sm font-semibold">{column.label}</span>
                                    <span className="ml-2 text-xs text-text-muted">
                                      {columnItems.length}
                                    </span>
                                  </span>
                                  {canCreateBoardTask &&
                                    !isAITableProject &&
                                    nativeGroupBy === 'status' && (
                                      <button
                                        type="button"
                                        data-testid={`cloud-todo-column-add-${column.key}`}
                                        onClick={() => openTodoCreation(boardParent, column.status)}
                                        className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 group-hover:opacity-100"
                                        aria-label={`在${column.label}中新建任务`}
                                      >
                                        <Plus className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                </header>
                                <TodoColumnDropzone status={column.key}>
                                  {columnItems.map(item => (
                                    <CloudTodoBoardCard
                                      key={item.id}
                                      item={item}
                                      childCount={
                                        items.filter(child => child.parent_id === item.id).length
                                      }
                                      onClick={() => {
                                        if (item.can_view_detail !== false) setSelectedItem(item)
                                      }}
                                      onAddChild={() => openTodoCreation(item)}
                                      onOpenChildren={() => setBoardParentId(item.id)}
                                      onArchive={() => {
                                        setArchiveError(null)
                                        setArchiveItem(item)
                                      }}
                                      display={boardCardDisplay}
                                      dragDisabled={isAITableProject}
                                      archiveDisabled={selectedProject.task_provider !== 'local'}
                                    />
                                  ))}
                                  {columnItems.length === 0 && columnEmptyHints[column.status] && (
                                    <div className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-text-muted">
                                      {columnEmptyHints[column.status]}
                                    </div>
                                  )}
                                </TodoColumnDropzone>
                                {canCreateBoardTask &&
                                  !isAITableProject &&
                                  nativeGroupBy === 'status' && (
                                    <div className="shrink-0 px-2 pb-2">
                                      <button
                                        type="button"
                                        data-testid={`cloud-todo-column-bottom-add-${column.key}`}
                                        onClick={() => openTodoCreation(boardParent, column.status)}
                                        className="flex h-9 w-full items-center gap-2 rounded-xl border border-dashed border-transparent bg-muted px-2.5 text-sm text-text-muted hover:border-border hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
                                        aria-label={`在${column.label}中新建任务`}
                                      >
                                        <Plus className="h-4 w-4" />
                                        新建任务
                                      </button>
                                    </div>
                                  )}
                              </section>
                            )
                          })}
                        </div>
                        <DragOverlay dropAnimation={null}>
                          {activeDragItemId ? (
                            <div className="w-[272px] rotate-1 rounded-xl border border-border bg-background p-3 text-left shadow-lg">
                              <CloudTodoCardContent
                                item={items.find(item => item.id === activeDragItemId)!}
                                display={boardCardDisplay}
                              />
                            </div>
                          ) : null}
                        </DragOverlay>
                      </DndContext>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </main>
        {selectedProject && projectAssistantOpen ? (
          <ProjectSpaceChatSidebar
            key={`${selectedProject.id}:${conversationLaunchRequest?.id ?? 'project'}`}
            project={selectedProject}
            localProjects={localProjects}
            launchRequest={conversationLaunchRequest}
            onClose={() => {
              setProjectAssistantOpen(false)
              setConversationLaunchRequest(null)
            }}
          />
        ) : null}
      </div>

      {globalSearchOpen && (
        <GlobalTodoSearch
          projects={projects}
          projectItems={projectItems}
          projectMembers={projectMembers}
          query={globalSearchQuery}
          onQueryChange={setGlobalSearchQuery}
          onClose={() => setGlobalSearchOpen(false)}
          onSelectProject={projectId => {
            selectProject(projectId)
            setRootView('projects')
            setProjectView('board')
            setSelectedItem(null)
            setGlobalSearchOpen(false)
          }}
          onSelectItem={(projectId, item) => {
            if (item.can_view_detail === false) return
            selectProject(projectId)
            setRootView('projects')
            setProjectView('board')
            setSelectedItem(item)
            setGlobalSearchOpen(false)
          }}
        />
      )}
      {selectedItem && selectedItem.can_view_detail !== false && selectedItemApi && (
        <TodoEditor
          key={`${selectedItem.id}:${selectedItem.version}`}
          mode="edit"
          api={selectedItemApi}
          aitableApi={
            projects.find(project => project.id === selectedItem.cloud_project_id)
              ?.task_provider === 'dingtalk_aitable'
              ? services.aitableApi
              : undefined
          }
          item={selectedItem}
          project={projects.find(project => project.id === selectedItem.cloud_project_id)}
          allItems={detailAllItems}
          onClose={() => setSelectedItem(null)}
          onAddChild={() => openTodoCreation(selectedItem)}
          onStartConversation={() => openTaskConversation(selectedItem)}
          onUpdated={updated => {
            setItems(current => current.map(item => (item.id === updated.id ? updated : item)))
            setDetailItems(current =>
              current.map(item => (item.id === updated.id ? updated : item))
            )
            setMyWork(current =>
              current.map(entry => (entry.id === updated.id ? { ...entry, ...updated } : entry))
            )
            setSelectedItem(updated)
          }}
        />
      )}
      {createProjectOpen && (
        <ProjectDialog
          availableApis={availableProjectSpaceApis}
          defaultLocation={projectSpaceApis.defaultLocation}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(project, location) => {
            const locatedProject = { ...project, location }
            const projectApi = projectSpaceApis[location]
            setProjects(current => [locatedProject, ...current])
            if (projectApi) {
              void projectApi
                .listCloudProjectMembers(project.id)
                .then(members =>
                  setProjectMembers(current => ({ ...current, [project.id]: members }))
                )
            }
            selectProject(project.id)
            setCreateProjectOpen(false)
          }}
        />
      )}
      {createTodoOpen && createTodoProject && createTodoApi && (
        <TodoEditor
          mode="create"
          api={createTodoApi}
          project={createTodoProject}
          initialParent={createTodoParent}
          initialStatus={createTodoStatus}
          allItems={createTodoParent ? detailAllItems : items}
          onClose={() => {
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
          }}
          onCreated={item => {
            if (item.cloud_project_id === selectedProjectId) {
              setItems(current => [...current, item])
            } else {
              setDetailItems(current => [...current, item])
            }
            setProjectCounts(current => ({
              ...current,
              [item.cloud_project_id]: (current[item.cloud_project_id] ?? 0) + 1,
            }))
            setCreateTodoOpen(false)
            setCreateTodoParent(null)
          }}
        />
      )}
      {renameProject && (
        <Modal title="修改项目名称" onClose={() => !renameBusy && setRenameProject(null)}>
          <div className="px-5 pb-5 pt-4">
            <label className="block text-sm font-medium text-text-secondary">
              项目名称
              <input
                data-testid="cloud-project-rename-input"
                value={renameProjectName}
                autoFocus
                onFocus={event => event.currentTarget.select()}
                onChange={event => {
                  setRenameProjectName(event.target.value)
                  setRenameError(null)
                }}
                className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
              />
            </label>
            <p className="mt-2 text-xs text-text-muted">新名称会显示在项目空间和看板侧栏中。</p>
            {renameError ? <p className="mt-3 text-xs text-red-600">{renameError}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameProject(null)}
                disabled={renameBusy}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                data-testid="cloud-project-rename-confirm"
                disabled={!renameProjectName.trim() || renameBusy}
                onClick={() => void renameSelectedProject()}
                className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
              >
                {renameBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {(archiveProject || archiveItem) && (
        <Modal
          title={archiveProject ? '归档项目？' : '归档任务？'}
          onClose={() => {
            if (archiveBusy) return
            setArchiveProject(null)
            setArchiveItem(null)
            setArchiveError(null)
          }}
        >
          <div className="px-5 pb-5 pt-4">
            <p className="text-sm leading-5 text-text-secondary">
              {archiveProject
                ? `“${archiveProject.name}”及其中任务将从项目列表中隐藏。`
                : `“${archiveItem?.title}”${items.some(item => item.parent_id === archiveItem?.id) ? '及其子任务' : ''}将从看板中隐藏。`}
            </p>
            <p className="mt-2 text-xs text-text-muted">归档数据会保留，不会立即永久删除。</p>
            {archiveError ? <p className="mt-3 text-xs text-red-600">{archiveError}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                data-testid="cloud-archive-cancel"
                disabled={archiveBusy}
                onClick={() => {
                  setArchiveProject(null)
                  setArchiveItem(null)
                  setArchiveError(null)
                }}
                className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                data-testid={
                  archiveProject ? 'cloud-project-archive-confirm' : 'cloud-todo-archive-confirm'
                }
                disabled={archiveBusy}
                onClick={() => {
                  void (archiveProject ? confirmArchiveProject() : confirmArchiveItem())
                }}
                className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {archiveBusy ? '归档中…' : '确认归档'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
