import { useEffect, useMemo, useState } from 'react'
import { LibraryBig, Link2, ListTodo, Plus, Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

interface ProjectSpaceOption {
  key: string
  project: CloudProject
  items: CloudLoopItem[]
  api: DeliveryApi
}

interface TodoBindingPickerProps {
  apis: DeliveryApi[]
  runtimeTask?: RuntimeTaskAddress
  runtimeTaskTitle?: string | null
  currentProject: CloudProject | null
  currentItem: CloudLoopItem | null
  onClose: () => void
  onBound: (project: CloudProject | null, item: CloudLoopItem | null) => void
}

export function TodoBindingPicker({
  apis,
  runtimeTask,
  runtimeTaskTitle,
  currentProject,
  currentItem,
  onClose,
  onBound,
}: TodoBindingPickerProps) {
  const [projectOptions, setProjectOptions] = useState<ProjectSpaceOption[]>([])
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void Promise.allSettled(
      apis.map(async api => {
        const response = await api.listCloudProjects()
        return Promise.all(
          response.items.map(async project => {
            const items = await api
              .listLoopItems(project.id)
              .then(result => result.items)
              .catch(() => [])
            return {
              key: `${project.project_store}:${project.id}`,
              project,
              api,
              items,
            }
          })
        )
      })
    ).then(results => {
      if (!active) return
      const options = results.flatMap(result => (result.status === 'fulfilled' ? result.value : []))
      const uniqueOptions = options.filter(
        (option, index) => options.findIndex(candidate => candidate.key === option.key) === index
      )
      const currentProjectKey = currentProject
        ? `${currentProject.project_store}:${currentProject.id}`
        : null
      setProjectOptions(uniqueOptions)
      setProjectKey(
        uniqueOptions.some(option => option.key === currentProjectKey)
          ? currentProjectKey
          : (uniqueOptions[0]?.key ?? null)
      )
      if (uniqueOptions.length === 0 && results.some(result => result.status === 'rejected')) {
        const rejection = results.find(result => result.status === 'rejected')
        setError(
          rejection?.status === 'rejected' && rejection.reason instanceof Error
            ? rejection.reason.message
            : '加载任务失败'
        )
      }
    })
    return () => {
      active = false
    }
  }, [apis, currentProject])

  const selectedOption =
    projectOptions.find(option => option.key === projectKey) ?? projectOptions[0] ?? null
  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (selectedOption?.items ?? []).filter(
      item =>
        !normalized ||
        `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(normalized)
    )
  }, [query, selectedOption])

  const selectedProject = selectedOption?.project ?? null

  async function bindProject() {
    if (!selectedOption || saving) return
    setSaving(true)
    setError(null)
    try {
      if (runtimeTask) {
        await selectedOption.api.bindProjectTask(
          selectedOption.project.id,
          runtimeTask,
          runtimeTaskTitle
        )
      }
      onBound(selectedOption.project, null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '关联云项目失败')
    } finally {
      setSaving(false)
    }
  }

  async function bind(item: CloudLoopItem) {
    if (!selectedOption || saving || currentItem?.id === item.id) return
    setSaving(true)
    setError(null)
    try {
      if (runtimeTask) {
        await (runtimeTaskTitle
          ? selectedOption.api.bindTask(item.id, runtimeTask, runtimeTaskTitle)
          : selectedOption.api.bindTask(item.id, runtimeTask))
      }
      onBound(selectedOption.project, item)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '关联任务失败')
    } finally {
      setSaving(false)
    }
  }

  async function clearBinding() {
    if ((!currentProject && !currentItem) || saving) return
    if (!runtimeTask) {
      onBound(null, null)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const currentProjectKey = currentProject
        ? `${currentProject.project_store}:${currentProject.id}`
        : null
      const currentOption =
        projectOptions.find(option => option.key === currentProjectKey) ?? selectedOption
      if (!currentOption) throw new Error('关联的项目空间不可用')
      await currentOption.api.unbindCloudContext(runtimeTask)
      onBound(null, null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解除关联失败')
    } finally {
      setSaving(false)
    }
  }

  async function createAndBind() {
    if (!selectedOption || !title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const item = await selectedOption.api.createLoopItem(selectedOption.project.id, {
        title: title.trim(),
        status: 'inbox',
      })
      if (runtimeTask) {
        await (runtimeTaskTitle
          ? selectedOption.api.bindTask(item.id, runtimeTask, runtimeTaskTitle)
          : selectedOption.api.bindTask(item.id, runtimeTask))
      }
      onBound(selectedOption.project, item)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建并关联任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-system flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm">
      <section className="w-[480px] max-w-full overflow-hidden rounded-2xl bg-background shadow-2xl">
        <header className="flex items-center gap-2 px-5 pt-4">
          <Link2 className="h-4 w-4 text-text-secondary" />
          <h2 className="text-base font-semibold">关联项目空间</h2>
          <button
            type="button"
            data-testid="todo-binding-close"
            onClick={onClose}
            className="-mr-1 ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        {creating ? (
          <div className="space-y-3 p-4">
            <select
              data-testid="todo-binding-project"
              value={projectKey ?? ''}
              onChange={event => setProjectKey(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
            >
              {projectOptions.map(option => (
                <option key={option.key} value={option.key}>
                  {option.project.name}
                </option>
              ))}
            </select>
            <input
              autoFocus
              data-testid="todo-binding-new-title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="任务标题"
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-text-muted"
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border p-3">
              <LibraryBig className="h-4 w-4 shrink-0 text-text-muted" />
              <select
                data-testid="todo-binding-project"
                value={projectKey ?? ''}
                onChange={event => setProjectKey(event.target.value)}
                className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-sm outline-none focus:border-text-muted"
              >
                {projectOptions.map(option => (
                  <option key={option.key} value={option.key}>
                    {option.project.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="todo-binding-project-only"
                disabled={!selectedProject || saving}
                onClick={() => void bindProject()}
                className="h-9 rounded-lg bg-text-primary px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                仅关联项目
              </button>
            </div>
            <div className="relative border-b border-border p-3">
              <Search className="absolute left-6 top-[22px] h-4 w-4 text-text-muted" />
              <input
                data-testid="todo-binding-search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索我的任务"
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-text-muted"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {visibleItems.map(item => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`todo-binding-item-${item.id}`}
                  disabled={saving || currentItem?.id === item.id}
                  onClick={() => void bind(item)}
                  className="flex h-11 w-full items-center rounded-lg px-3 text-left hover:bg-hover disabled:opacity-50"
                >
                  <ListTodo className="mr-2 h-4 w-4 shrink-0 text-text-muted" />
                  <span className="w-20 shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="px-4 pb-2 text-xs text-destructive">{error}</p>}
        <footer className="flex h-12 items-center gap-2 border-t border-border px-3">
          {(currentProject || currentItem) && !creating && (
            <button
              type="button"
              data-testid="todo-binding-unbind"
              disabled={saving}
              onClick={() => void clearBinding()}
              className="h-8 rounded-lg px-3 text-xs text-text-secondary hover:bg-hover"
            >
              {runtimeTask ? '解除关联' : '清除选择'}
            </button>
          )}
          <span className="flex-1" />
          {creating ? (
            <>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="h-8 rounded-lg px-3 text-xs text-text-secondary hover:bg-hover"
              >
                返回
              </button>
              <button
                type="button"
                data-testid="todo-binding-create-confirm"
                disabled={!selectedOption || !title.trim() || saving}
                onClick={() => void createAndBind()}
                className="h-8 rounded-lg bg-text-primary px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                创建并关联
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="todo-binding-create"
              onClick={() => setCreating(true)}
              className="flex h-8 items-center gap-1 rounded-lg px-3 text-xs text-text-secondary hover:bg-hover"
            >
              <Plus className="h-3.5 w-3.5" /> 快速新建
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
