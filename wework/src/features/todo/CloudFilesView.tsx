import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, File, Folder, FolderPlus, Pencil, Trash2, Upload } from 'lucide-react'
import type { CloudProject, CloudProjectFile, ProjectDeliveryFile } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { openExternalUrl } from '@/lib/external-links'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>

export function CloudFilesView({ api, project }: { api: DeliveryApi; project: CloudProject }) {
  const [files, setFiles] = useState<CloudProjectFile[]>([])
  const [deliveryFiles, setDeliveryFiles] = useState<ProjectDeliveryFile[]>([])
  const [folderName, setFolderName] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [uploadingCount, setUploadingCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [editingFileId, setEditingFileId] = useState<string | null>(null)
  const [editingPath, setEditingPath] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const refresh = useCallback(() => {
    void Promise.all([api.listCloudFiles(project.id), api.listProjectDeliveryFiles(project.id)])
      .then(([shared, delivered]) => {
        setFiles(shared.items)
        setDeliveryFiles(delivered.items)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : '加载文件失败'))
  }, [api, project.id])
  useEffect(refresh, [refresh])

  async function uploadFiles(selected: File[]) {
    if (selected.length === 0) return
    setUploadingCount(selected.length)
    setError(null)
    try {
      await Promise.all(selected.map(file => api.uploadCloudFile(project.id, file)))
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传失败，请重试')
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建文件夹失败')
    }
  }

  async function openFile(entry: CloudProjectFile) {
    if (entry.kind !== 'file') return
    setError(null)
    try {
      const access = await api.accessCloudFile(entry.id)
      await openExternalUrl(access.url, { target: 'wework' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开文件失败')
    }
  }

  async function openDeliveryFile(entry: ProjectDeliveryFile) {
    setError(null)
    try {
      const access = await api.accessDeliveryFile(entry.asset_id)
      await openExternalUrl(access.url, { target: 'wework' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开交付文件失败')
    }
  }

  async function deleteFile(entry: CloudProjectFile) {
    if (!window.confirm(`删除“${entry.path}”？此操作无法撤销。`)) return
    setError(null)
    try {
      await api.deleteCloudFile(entry.id, entry.kind === 'folder')
      setFiles(current =>
        current.filter(file => file.id !== entry.id && !file.path.startsWith(`${entry.path}/`))
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败')
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重命名或移动失败')
    }
  }

  return (
    <div className="p-7">
      <div className="flex items-start">
        <div>
          <h2 className="heading-md">共享文件</h2>
          <p className="mt-1 text-xs text-text-muted">
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
          className="mr-2 flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-text-secondary hover:bg-hover"
        >
          <FolderPlus className="h-3.5 w-3.5" /> 新建文件夹
        </button>
        <button
          type="button"
          data-testid="cloud-files-upload"
          onClick={() => inputRef.current?.click()}
          className="flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background"
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
      <div className="mt-6 overflow-hidden rounded-md border border-border">
        <div className="grid h-9 grid-cols-[minmax(0,1fr)_120px_120px_80px_96px] items-center border-b border-border bg-muted/30 px-4 text-xs text-text-muted">
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
              className="grid h-11 grid-cols-[minmax(0,1fr)_120px_120px_80px_96px] items-center border-b border-border px-4 text-xs last:border-b-0 hover:bg-hover"
            >
              <span className="flex min-w-0 items-center gap-2">
                {entry.kind === 'folder' ? (
                  <Folder className="h-4 w-4 text-text-muted" />
                ) : (
                  <File className="h-4 w-4 text-text-muted" />
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
                  <span className="truncate text-text-primary">{entry.path}</span>
                )}
              </span>
              <span className="text-text-muted">{entry.content_type || '文件夹'}</span>
              <span className="text-text-muted">{entry.updated_at.slice(0, 10)}</span>
              <span className="text-text-muted">
                {entry.kind === 'file' ? `${entry.size_bytes} B` : '—'}
              </span>
              <span className="flex justify-end gap-1">
                <button
                  type="button"
                  data-testid={`cloud-file-rename-${entry.id}`}
                  onClick={() => {
                    setEditingFileId(entry.id)
                    setEditingPath(entry.path)
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted"
                  aria-label={`重命名或移动 ${entry.path}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {entry.kind === 'file' && (
                  <button
                    type="button"
                    data-testid={`cloud-file-open-${entry.id}`}
                    onClick={() => void openFile(entry)}
                    className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                    aria-label={`打开 ${entry.path}`}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`cloud-file-delete-${entry.id}`}
                  onClick={() => void deleteFile(entry)}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-destructive"
                  aria-label={`删除 ${entry.path}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))
        )}
      </div>
      <section className="mt-8">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-medium text-text-primary">交付快照</h3>
          <span className="text-xs text-text-muted">来自已完成任务，只读且不可修改</span>
        </div>
        <div className="mt-3 overflow-hidden rounded-md border border-border">
          <div className="grid h-9 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_40px] items-center border-b border-border bg-muted/30 px-4 text-xs text-text-muted">
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
                className="grid min-h-11 grid-cols-[240px_minmax(0,1fr)_120px_120px_80px_40px] items-center border-b border-border px-4 text-xs last:border-b-0 hover:bg-hover"
              >
                <span
                  className="flex min-w-0 items-center gap-2"
                  title={`${entry.loop_item_id} · ${entry.loop_item_title}`}
                >
                  <span className="shrink-0 font-mono text-text-muted">{entry.loop_item_id}</span>
                  <span className="truncate text-text-primary">{entry.loop_item_title}</span>
                </span>
                <span className="flex min-w-0 items-center gap-2 text-text-primary">
                  <File className="h-4 w-4 shrink-0 text-text-muted" />
                  <span className="truncate" title={entry.relative_path}>
                    {entry.relative_path}
                  </span>
                </span>
                <span className="truncate text-text-muted">{entry.content_type || '文件'}</span>
                <span className="text-text-muted">{entry.delivered_at.slice(0, 10)}</span>
                <span className="text-text-muted">{entry.size_bytes} B</span>
                <button
                  type="button"
                  data-testid={`delivery-file-open-${entry.asset_id}`}
                  onClick={() => void openDeliveryFile(entry)}
                  className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted"
                  aria-label={`打开交付文件 ${entry.relative_path}`}
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </section>
      <p className="mt-6 text-xs text-text-muted">
        在 Wework 输入框中输入 @，即可让 AI 查看云项目、目录、任务或交付。
      </p>
    </div>
  )
}
