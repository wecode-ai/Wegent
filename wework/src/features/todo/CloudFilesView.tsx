import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Download,
  Eye,
  File as FileIcon,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type {
  CloudProject,
  CloudProjectFile,
  ProjectDeliveryFile,
  ProjectTaskAttachment,
} from '@/api/deliveries'
import { Tooltip } from '@/components/ui/tooltip'
import { WorkspaceFilePreview } from '@/components/layout/workspace-panels/WorkspaceFilePreview'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { track } from '@/telemetry/client'
import type { WorkspaceTextFileResponse } from '@/types/workspace-files'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

interface CloudFilePreviewTarget {
  key: string
  title: string
  filename: string
  contentType: string | null
  sizeBytes: number
  load: () => Promise<Blob>
}

const TEXT_FILE_PATTERN =
  /\.(?:c|cc|cpp|cs|css|go|h|hpp|html|htm|java|js|json|jsx|kt|log|md|markdown|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|ya?ml|zsh)$/i

function isPreviewableTextFile(name: string, contentType: string): boolean {
  if (TEXT_FILE_PATTERN.test(name)) return true
  const normalized = contentType.toLowerCase()
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript')
  )
}

export function CloudFilesView({ api, project }: { api: DeliveryApi; project: CloudProject }) {
  const { t } = useTranslation('common')
  const [files, setFiles] = useState<CloudProjectFile[]>([])
  const [deliveryFiles, setDeliveryFiles] = useState<ProjectDeliveryFile[]>([])
  const [taskAttachments, setTaskAttachments] = useState<ProjectTaskAttachment[]>([])
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState('')
  const [previewTarget, setPreviewTarget] = useState<CloudFilePreviewTarget | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewText, setPreviewText] = useState<WorkspaceTextFileResponse | null>(null)
  const [previewBinary, setPreviewBinary] = useState<{
    path: string
    name: string
    size: number
    file: File
  } | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previewRequestSequence = useRef(0)
  const isLocalProject = project.project_store === 'local'
  const refresh = useCallback(() => {
    const taskAttachmentsRequest = isLocalProject
      ? api.listProjectTaskAttachments(project.id)
      : Promise.resolve({ items: [] })
    void Promise.all([
      api.listCloudFiles(project.id),
      api.listProjectDeliveryFiles(project.id),
      taskAttachmentsRequest,
    ])
      .then(([shared, delivered, taskAttachments]) => {
        setFiles(shared.items)
        setDeliveryFiles(delivered.items)
        setTaskAttachments(isLocalProject ? taskAttachments.items : [])
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : '加载文件失败'))
  }, [api, isLocalProject, project.id])
  useEffect(refresh, [refresh])

  async function loadPreview(target: CloudFilePreviewTarget) {
    const requestId = previewRequestSequence.current + 1
    previewRequestSequence.current = requestId
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewText(null)
    setPreviewBinary(null)
    try {
      const blob = await target.load()
      if (previewRequestSequence.current !== requestId) return
      const contentType = target.contentType || blob.type || 'application/octet-stream'
      if (isPreviewableTextFile(target.filename, contentType)) {
        const content = await blob.text()
        if (previewRequestSequence.current !== requestId) return
        setPreviewText({
          path: target.filename,
          name: target.filename,
          content,
          editable: false,
          revision: `${target.key}:${requestId}`,
          truncated: false,
          size: target.sizeBytes || blob.size,
        })
        return
      }
      setPreviewBinary({
        path: target.filename,
        name: target.filename,
        size: target.sizeBytes || blob.size,
        file: new File([blob], target.filename, { type: contentType }),
      })
    } catch (cause) {
      if (previewRequestSequence.current !== requestId) return
      setPreviewError(cause instanceof Error ? cause.message : '预览失败')
    } finally {
      if (previewRequestSequence.current === requestId) {
        setPreviewLoading(false)
      }
    }
  }

  async function uploadFiles(selected: File[]) {
    if (selected.length === 0) return
    setUploadingCount(selected.length)
    setError(null)
    try {
      await Promise.all(selected.map(file => api.uploadCloudFile(project.id, file)))
      refresh()
      track('feature_action_completed', { action: 'upload', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试')
      track('operation_failed', { operation: 'project_space_file_action' })
    } finally {
      setUploadingCount(0)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function createFolder() {
    const path = folderName.trim()
    if (!path) return
    setError(null)
    try {
      await api.createCloudFolder(project.id, path)
      setFolderName('')
      setCreatingFolder(false)
      refresh()
      track('feature_action_completed', { action: 'create', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建文件夹失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function openFile(entry: CloudProjectFile) {
    if (entry.kind !== 'file') return
    setError(null)
    try {
      const access = await api.accessCloudFile(entry.id)
      await openExternalUrl(access.url, { target: 'wework' })
      track('feature_action_completed', { action: 'open', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开文件失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function openDeliveryFile(entry: ProjectDeliveryFile) {
    setError(null)
    try {
      const access = await api.accessDeliveryFile(entry.asset_id)
      await openExternalUrl(access.url, { target: 'wework' })
      track('feature_action_completed', { action: 'open', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开交付文件失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function openTaskAttachment(entry: ProjectTaskAttachment) {
    setError(null)
    try {
      await api.downloadLoopItemAttachment(entry.id, entry.display_name)
      track('feature_action_completed', { action: 'open', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.open_task_attachment_failed'))
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  function previewFile(entry: CloudProjectFile) {
    if (entry.kind !== 'file') return
    showPreview({
      key: `cloud-file:${entry.id}`,
      title: entry.path,
      filename: entry.name || entry.path.split('/').pop() || entry.path,
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.readCloudFile(entry.id),
    })
  }

  function previewDeliveryFile(entry: ProjectDeliveryFile) {
    showPreview({
      key: `delivery-file:${entry.asset_id}`,
      title: entry.relative_path,
      filename: entry.display_name || entry.relative_path.split('/').pop() || entry.relative_path,
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.readDeliveryFile(entry.asset_id),
    })
  }

  function previewTaskAttachment(entry: ProjectTaskAttachment) {
    showPreview({
      key: `task-attachment:${entry.id}`,
      title: entry.display_name,
      filename: entry.display_name,
      contentType: entry.content_type,
      sizeBytes: entry.size_bytes,
      load: () => api.readLoopItemAttachment(entry.id),
    })
  }

  function showPreview(target: CloudFilePreviewTarget) {
    setPreviewTarget(target)
    void loadPreview(target)
  }

  async function deleteFile(entry: CloudProjectFile) {
    if (!window.confirm(`删除“${entry.path}”？此操作无法撤销。`)) return
    setError(null)
    try {
      await api.deleteCloudFile(entry.id, entry.kind === 'folder')
      setFiles(current =>
        current.filter(file => file.id !== entry.id && !file.path.startsWith(`${entry.path}/`))
      )
      track('feature_action_completed', { action: 'delete', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  async function moveFile(entry: CloudProjectFile) {
    const path = editingPath.trim()
    if (!path || path === entry.path) {
      setEditingFileId(null)
      return
    }
    setError(null)
    try {
      await api.moveCloudFile(entry.id, path, entry.version)
      setEditingFileId(null)
      refresh()
      track('feature_action_completed', { action: 'move', domain: 'project_space_file' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名或移动失败')
      track('operation_failed', { operation: 'project_space_file_action' })
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <div className="mx-auto max-w-[960px]">
          <div className="flex items-start">
            <div>
              <h2 className="text-heading-md font-semibold">共享文件</h2>
              <p className="mt-1 text-sm text-text-muted">
                成员和 AI 可通过权限控制的云空间访问这些内容。
              </p>
            </div>
            <span className="flex-1" />
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={event => {
                const selected = [...(event.target.files ?? [])]
                void uploadFiles(selected)
              }}
            />
            <button
              type="button"
              data-testid="cloud-folder-add"
              onClick={() => setCreatingFolder(true)}
              className="mr-2 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm font-medium text-text-primary hover:bg-hover"
            >
              <FolderPlus className="h-3.5 w-3.5" /> 新建文件夹
            </button>
            <button
              type="button"
              data-testid="cloud-files-upload"
              onClick={() => inputRef.current?.click()}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
            >
              <Upload className="h-3.5 w-3.5" />
              {uploadingCount > 0 ? `正在上传 ${uploadingCount} 项…` : '上传文件'}
            </button>
          </div>
          {creatingFolder && (
            <div className="mt-4 flex items-center gap-2">
              <input
                autoFocus
                data-testid="cloud-folder-name"
                value={folderName}
                onChange={event => setFolderName(event.target.value)}
                onKeyDown={event => event.key === 'Enter' && void createFolder()}
                placeholder="文件夹路径，例如 docs/design"
                className="h-8 min-w-0 flex-1 rounded-md border border-border px-3 text-sm outline-none focus:border-focus"
              />
              <button
                type="button"
                data-testid="cloud-folder-create-confirm"
                onClick={() => void createFolder()}
                className="h-8 rounded-md bg-text-primary px-3 text-sm text-background"
              >
                创建
              </button>
              <button
                type="button"
                onClick={() => setCreatingFolder(false)}
                className="h-8 rounded-md px-3 text-sm hover:bg-hover"
              >
                取消
              </button>
            </div>
          )}
          {error && (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <div className="mt-6 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
            <div className="grid h-10 grid-cols-[minmax(0,1fr)_110px_110px_90px_120px] items-center bg-muted/30 px-4 text-xs text-text-muted">
              <span>名称</span>
              <span>类型</span>
              <span>更新时间</span>
              <span>大小</span>
              <span />
            </div>
            {files.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-text-muted">
                暂无共享文件
              </div>
            ) : (
              files.map(entry => (
                <div
                  key={entry.id}
                  className="group grid h-12 grid-cols-[minmax(0,1fr)_110px_110px_90px_120px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/60"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    {entry.kind === 'folder' ? (
                      <Folder className="h-4 w-4 shrink-0 text-text-muted" />
                    ) : (
                      <FileIcon className="h-4 w-4 shrink-0 text-text-muted" />
                    )}
                    {editingFileId === entry.id ? (
                      <input
                        autoFocus
                        data-testid={`cloud-file-path-${entry.id}`}
                        value={editingPath}
                        onChange={event => setEditingPath(event.target.value)}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void moveFile(entry)
                          if (event.key === 'Escape') setEditingFileId(null)
                        }}
                        className="h-7 min-w-0 flex-1 rounded border border-focus bg-background px-2 outline-none"
                      />
                    ) : (
                      <span className="truncate text-sm font-medium text-text-primary">
                        {entry.path}
                      </span>
                    )}
                  </span>
                  <span className="text-text-muted">{entry.content_type || '文件夹'}</span>
                  <span className="text-text-muted">{entry.updated_at.slice(0, 10)}</span>
                  <span className="text-text-muted">
                    {entry.kind === 'file' ? `${entry.size_bytes} B` : '—'}
                  </span>
                  <span className="flex justify-end gap-1 opacity-0 transition focus-within:opacity-100 group-hover:opacity-100">
                    <Tooltip
                      label={t('todo.rename_or_move_file', '重命名或移动 {{path}}', {
                        path: entry.path,
                      })}
                    >
                      <button
                        type="button"
                        data-testid={`cloud-file-rename-${entry.id}`}
                        onClick={() => {
                          setEditingFileId(entry.id)
                          setEditingPath(entry.path)
                        }}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                        aria-label={t('todo.rename_or_move_file', '重命名或移动 {{path}}', {
                          path: entry.path,
                        })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                    {entry.kind === 'file' && (
                      <>
                        <Tooltip label={t('todo.preview_file_path', { path: entry.path })}>
                          <button
                            type="button"
                            data-testid={`cloud-file-preview-${entry.id}`}
                            onClick={() => previewFile(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.preview_file_path', { path: entry.path })}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={t('todo.open_file_path', '打开 {{path}}', { path: entry.path })}
                        >
                          <button
                            type="button"
                            data-testid={`cloud-file-open-${entry.id}`}
                            onClick={() => void openFile(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.open_file_path', '打开 {{path}}', {
                              path: entry.path,
                            })}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </>
                    )}
                    <Tooltip
                      label={t('todo.delete_file_path', '删除 {{path}}', { path: entry.path })}
                      align="end"
                    >
                      <button
                        type="button"
                        data-testid={`cloud-file-delete-${entry.id}`}
                        onClick={() => void deleteFile(entry)}
                        className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-destructive"
                        aria-label={t('todo.delete_file_path', '删除 {{path}}', {
                          path: entry.path,
                        })}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </Tooltip>
                  </span>
                </div>
              ))
            )}
          </div>
          {isLocalProject && (
            <section className="mt-8">
              <div className="flex items-baseline gap-2.5">
                <h3 className="text-base font-semibold text-text-primary">
                  {t('todo.task_attachments')}
                </h3>
                <span className="text-xs text-text-muted">
                  {t('todo.task_attachments_description')}
                </span>
              </div>
              <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
                <div className="grid h-10 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center bg-muted/30 px-4 text-xs text-text-muted">
                  <span>{t('todo.task_attachment_task')}</span>
                  <span>{t('todo.task_attachment_name')}</span>
                  <span>{t('todo.task_attachment_type')}</span>
                  <span>{t('todo.task_attachment_uploaded_at')}</span>
                  <span>{t('todo.task_attachment_size')}</span>
                  <span />
                </div>
                {taskAttachments.length === 0 ? (
                  <div className="flex h-24 items-center justify-center text-sm text-text-muted">
                    {t('todo.task_attachments_empty')}
                  </div>
                ) : (
                  taskAttachments.map(entry => (
                    <div
                      key={entry.id}
                      data-testid={`task-attachment-${entry.id}`}
                      className="grid min-h-12 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/60"
                    >
                      <Tooltip
                        label={`${entry.loop_item_id} · ${entry.loop_item_title}`}
                        align="start"
                        className="min-w-0 shrink"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 font-mono text-text-muted">
                            {entry.loop_item_id}
                          </span>
                          <span className="truncate text-text-primary">
                            {entry.loop_item_title}
                          </span>
                        </span>
                      </Tooltip>
                      <span className="flex min-w-0 items-center gap-2 text-text-primary">
                        <FileIcon className="h-4 w-4 shrink-0 text-text-muted" />
                        <Tooltip
                          label={entry.display_name}
                          align="start"
                          className="min-w-0 shrink"
                        >
                          <span className="truncate">{entry.display_name}</span>
                        </Tooltip>
                      </span>
                      <span className="truncate text-text-muted">
                        {entry.content_type || t('todo.task_attachment_file')}
                      </span>
                      <span className="text-text-muted">{entry.created_at.slice(0, 10)}</span>
                      <span className="text-text-muted">{entry.size_bytes} B</span>
                      <span className="flex justify-end gap-1">
                        <Tooltip
                          label={t('todo.preview_task_attachment', { name: entry.display_name })}
                        >
                          <button
                            type="button"
                            data-testid={`task-attachment-preview-${entry.id}`}
                            onClick={() => previewTaskAttachment(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.preview_task_attachment', {
                              name: entry.display_name,
                            })}
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                        <Tooltip
                          label={t('todo.open_task_attachment', { name: entry.display_name })}
                          align="end"
                        >
                          <button
                            type="button"
                            data-testid={`task-attachment-open-${entry.id}`}
                            onClick={() => void openTaskAttachment(entry)}
                            className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                            aria-label={t('todo.open_task_attachment', {
                              name: entry.display_name,
                            })}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
          <section className="mt-8">
            <div className="flex items-baseline gap-2.5">
              <h3 className="text-base font-semibold text-text-primary">交付快照</h3>
              <span className="text-xs text-text-muted">来自已完成任务，只读且不可修改</span>
            </div>
            <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
              <div className="grid h-10 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center bg-muted/30 px-4 text-xs text-text-muted">
                <span>任务</span>
                <span>名称</span>
                <span>类型</span>
                <span>交付时间</span>
                <span>大小</span>
                <span />
              </div>
              {deliveryFiles.length === 0 ? (
                <div className="flex h-24 items-center justify-center text-sm text-text-muted">
                  暂无交付文件
                </div>
              ) : (
                deliveryFiles.map(entry => (
                  <div
                    key={entry.asset_id}
                    data-testid={`delivery-file-${entry.asset_id}`}
                    className="grid min-h-12 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_80px] items-center border-t border-border px-4 text-xs transition-colors hover:bg-muted/60"
                  >
                    <Tooltip
                      label={`${entry.loop_item_id} · ${entry.loop_item_title}`}
                      align="start"
                      className="min-w-0 shrink"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-mono text-text-muted">
                          {entry.loop_item_id}
                        </span>
                        <span className="truncate text-text-primary">{entry.loop_item_title}</span>
                      </span>
                    </Tooltip>
                    <span className="flex min-w-0 items-center gap-2 text-text-primary">
                      <FileIcon className="h-4 w-4 shrink-0 text-text-muted" />
                      <Tooltip label={entry.relative_path} align="start" className="min-w-0 shrink">
                        <span className="truncate">{entry.relative_path}</span>
                      </Tooltip>
                    </span>
                    <span className="truncate text-text-muted">{entry.content_type || '文件'}</span>
                    <span className="text-text-muted">{entry.delivered_at.slice(0, 10)}</span>
                    <span className="text-text-muted">{entry.size_bytes} B</span>
                    <span className="flex justify-end gap-1">
                      <Tooltip
                        label={t('todo.preview_delivery_file', '预览交付文件 {{path}}', {
                          path: entry.relative_path,
                        })}
                      >
                        <button
                          type="button"
                          data-testid={`delivery-file-preview-${entry.asset_id}`}
                          onClick={() => previewDeliveryFile(entry)}
                          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                          aria-label={t('todo.preview_delivery_file', '预览交付文件 {{path}}', {
                            path: entry.relative_path,
                          })}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                      <Tooltip
                        label={t('todo.open_delivery_file', '打开交付文件 {{path}}', {
                          path: entry.relative_path,
                        })}
                        align="end"
                      >
                        <button
                          type="button"
                          data-testid={`delivery-file-open-${entry.asset_id}`}
                          onClick={() => void openDeliveryFile(entry)}
                          className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                          aria-label={t('todo.open_delivery_file', '打开交付文件 {{path}}', {
                            path: entry.relative_path,
                          })}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      </Tooltip>
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
          <p className="mt-6 rounded-xl border border-border bg-muted px-4 py-3 text-xs text-text-secondary">
            在 Wework 输入框中输入 @，即可让 AI 查看云项目、目录、任务或交付。
          </p>
        </div>
      </div>
      {previewTarget && (
        <aside
          data-testid="cloud-file-preview-sidebar"
          className="flex w-[480px] shrink-0 flex-col border-l border-border bg-background"
        >
          <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
            <span
              data-testid="cloud-file-preview-title"
              className="min-w-0 truncate text-sm font-medium text-text-primary"
            >
              {previewTarget.title}
            </span>
            <button
              type="button"
              data-testid="cloud-file-preview-close"
              onClick={() => {
                previewRequestSequence.current += 1
                setPreviewTarget(null)
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary"
              aria-label={t('todo.close_preview')}
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkspaceFilePreview
              file={previewText}
              binaryFile={previewBinary}
              loading={previewLoading}
              error={previewError}
              onRetry={() => previewTarget && void loadPreview(previewTarget)}
              onAddCodeComment={() => undefined}
            />
          </div>
        </aside>
      )}
    </div>
  )
}
