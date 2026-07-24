import { useEffect, useMemo, useState } from 'react'
import { LibraryBig, Link2, ListTodo, Plus, Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeTaskAddress } from '@/types/api'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

interface TodoBindingPickerProps {
  api: DeliveryApi
  runtimeTask?: RuntimeTaskAddress
  runtimeTaskTitle?: string | null
  currentProject: CloudProject | null
  currentItem: CloudLoopItem | null
  onClose: () => void
  onBound: (project: CloudProject | null, item: CloudLoopItem | null) => void
}

export function TodoBindingPicker({
  api,
  runtimeTask,
  runtimeTaskTitle,
  currentProject,
  currentItem,
  onClose,
  onBound,
}: TodoBindingPickerProps) {
  const [projects, setProjects] = useState<CloudProject[]>([])
  const [items, setItems] = useState<CloudLoopItem[]>([])
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api
      .listCloudProjects()
      .then(async response => {
        const groups = await Promise.all(
          response.items.map(project => api.listLoopItems(project.id).then(result => result.items))
        )
        if (!active) return
        setProjects(response.items)
        setProjectId(currentProject?.id ?? response.items[0]?.id ?? null)
        setItems(groups.flat())
      })
      .catch(cause => {
        if (active) setError(cause instanceof Error ? cause.message : '加载任务失败')
      })
    return () => {
      active = false
    }
  }, [api, currentProject?.id])

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return items.filter(
      item =>
        item.cloud_project_id === projectId &&
        (!normalized ||
          `${item.id} ${item.title} ${item.description}`.toLowerCase().includes(normalized))
    )
  }, [items, projectId, query])

  const selectedProject = projects.find(project => project.id === projectId) ?? null

  async function bindProject() {
    if (!selectedProject || saving) return
    setSaving(true)
    setError(null)
    try {
      if (runtimeTask) {
        await api.bindProjectTask(selectedProject.id, runtimeTask, runtimeTaskTitle)
      }
      onBound(selectedProject, null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '关联云项目失败')
    } finally {
      setSaving(false)
    }
  }

  async function bind(item: CloudLoopItem) {
    if (saving || currentItem?.id === item.id) return
    setSaving(true)
    setError(null)
    try {
      if (runtimeTask) {
        await (runtimeTaskTitle
          ? api.bindTask(item.id, runtimeTask, runtimeTaskTitle)
          : api.bindTask(item.id, runtimeTask))
      }
      onBound(projects.find(project => project.id === item.cloud_project_id) ?? null, item)
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
      await api.unbindCloudContext(runtimeTask)
      onBound(null, null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '解除关联失败')
    } finally {
      setSaving(false)
    }
  }

  async function createAndBind() {
    if (!projectId || !title.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const item = await api.createLoopItem(projectId, { title: title.trim(), status: 'inbox' })
      if (runtimeTask) {
        await (runtimeTaskTitle
          ? api.bindTask(item.id, runtimeTask, runtimeTaskTitle)
          : api.bindTask(item.id, runtimeTask))
      }
      onBound(projects.find(project => project.id === item.cloud_project_id) ?? null, item)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建并关联任务失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-system flex items-center justify-center bg-black/30 p-6">
      <section className="w-[480px] max-w-full overflow-hidden rounded-xl border border-border bg-background shadow-lg">
        <header className="flex h-11 items-center border-b border-border px-4">
          <Link2 className="mr-2 h-4 w-4 text-text-secondary" />
          <h2 className="text-sm font-semibold">关联云协作</h2>
          <button
            type="button"
            data-testid="todo-binding-close"
            onClick={onClose}
            className="ml-auto h-7 w-7 rounded-md hover:bg-hover"
          >
            <X className="mx-auto h-4 w-4" />
          </button>
        </header>
        {creating ? (
          <div className="space-y-3 p-4">
            <select
              data-testid="todo-binding-project"
              value={projectId ?? ''}
              onChange={event => setProjectId(event.target.value)}
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              {projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input
              autoFocus
              data-testid="todo-binding-new-title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="任务标题"
              className="h-9 w-full rounded-md border border-border px-3 text-sm outline-none focus:border-focus"
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border p-3">
              <LibraryBig className="h-4 w-4 shrink-0 text-text-muted" />
              <select
                data-testid="todo-binding-project"
                value={projectId ?? ''}
                onChange={event => setProjectId(event.target.value)}
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
              >
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="todo-binding-project-only"
                disabled={!selectedProject || saving}
                onClick={() => void bindProject()}
                className="h-8 rounded-md border border-border px-3 text-xs hover:bg-hover disabled:opacity-50"
              >
                仅关联项目
              </button>
            </div>
            <div className="relative border-b border-border p-3">
              <Search className="absolute left-6 top-5 h-4 w-4 text-text-muted" />
              <input
                data-testid="todo-binding-search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索我的任务"
                className="h-8 w-full rounded-md bg-muted/50 pl-9 pr-3 text-sm outline-none"
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
                  className="flex h-11 w-full items-center rounded-md px-3 text-left hover:bg-hover disabled:opacity-50"
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
              className="h-8 rounded-md px-3 text-xs text-text-secondary hover:bg-hover"
            >
              {runtimeTask ? '解除关联' : '清除选择'}
            </button>
          )}
          <span className="flex-1" />
          {creating ? (
            <>
              <button type="button" onClick={() => setCreating(false)} className="h-8 px-3 text-xs">
                返回
              </button>
              <button
                type="button"
                data-testid="todo-binding-create-confirm"
                disabled={!projectId || !title.trim() || saving}
                onClick={() => void createAndBind()}
                className="h-8 rounded-md bg-text-primary px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                创建并关联
              </button>
            </>
          ) : (
            <button
              type="button"
              data-testid="todo-binding-create"
              onClick={() => setCreating(true)}
              className="flex h-8 items-center gap-1 rounded-md px-3 text-xs hover:bg-hover"
            >
              <Plus className="h-3.5 w-3.5" /> 快速新建
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
