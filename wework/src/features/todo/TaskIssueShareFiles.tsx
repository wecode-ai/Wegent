import { Paperclip, X } from 'lucide-react'
import type { TaskIssueConversationFile } from './taskIssueConversationFiles'
import { useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'

export function TaskIssueShareFiles({
  sourceTitle,
  files,
  conversationFiles,
  selectedConversationFileIds,
  onSelectConversationFiles,
  onChange,
}: {
  sourceTitle: string
  files: File[]
  conversationFiles: TaskIssueConversationFile[]
  selectedConversationFileIds: string[]
  onSelectConversationFiles(ids: string[]): void
  onChange(files: File[]): void
}) {
  const { t } = useTranslation('common')
  const input = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<Pick<TaskIssueConversationFile, 'name' | 'load'> | null>(
    null
  )
  const previewButton = (
    file: Pick<TaskIssueConversationFile, 'name' | 'load'>,
    testId: string
  ) => (
    <button
      type="button"
      data-testid={testId}
      aria-label={t('taskIssueShare.previewFile', { name: file.name })}
      onClick={() => setPreview(file)}
      className="mr-1 min-h-11 shrink-0 rounded-md px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-8"
    >
      {t('taskIssueShare.preview')}
    </button>
  )
  return (
    <section
      className="grid gap-2 border-t border-border pt-3"
      aria-label={t('taskIssueShare.deliverables')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('taskIssueShare.deliverables')}</h3>
        <button
          type="button"
          data-testid="task-issue-share-select-files"
          onClick={() => input.current?.click()}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm hover:bg-muted md:min-h-8"
        >
          <Paperclip className="h-4 w-4" aria-hidden="true" />
          {t('taskIssueShare.uploadFiles')}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="task-issue-share-file-input"
          onChange={event => {
            const next = [...files]
            for (const file of Array.from(event.target.files ?? [])) {
              if (
                !next.some(
                  item =>
                    item.name === file.name &&
                    item.size === file.size &&
                    item.lastModified === file.lastModified
                )
              )
                next.push(file)
            }
            onChange(next)
            event.target.value = ''
          }}
        />
      </div>
      <p className="break-words text-sm text-text-secondary">
        {t('taskIssueShare.linkedConversation', { title: sourceTitle })}
      </p>
      {conversationFiles.length > 0 && (
        <ul
          data-testid="task-issue-share-conversation-files"
          className="max-h-44 overflow-y-auto rounded-md border border-border"
        >
          {conversationFiles.map((file, index) => {
            const checked = selectedConversationFileIds.includes(file.id)
            return (
              <li
                key={file.id}
                className="flex items-center border-b border-border last:border-b-0"
              >
                <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-sm hover:bg-muted md:min-h-8">
                  <input
                    type="checkbox"
                    data-testid={`task-issue-share-conversation-file-${index}`}
                    checked={checked}
                    onChange={() =>
                      onSelectConversationFiles(
                        checked
                          ? selectedConversationFileIds.filter(id => id !== file.id)
                          : [...selectedConversationFileIds, file.id]
                      )
                    }
                    className="shrink-0 accent-text-primary"
                  />
                  <span className="min-w-0 truncate" title={file.name}>
                    {file.name}
                  </span>
                </label>
                {previewButton(file, `task-issue-share-preview-conversation-file-${index}`)}
              </li>
            )
          })}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="grid gap-1" data-testid="task-issue-share-files">
          {files.map((file, index) => (
            <li key={index} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/40 px-2">
              <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                {file.name}
              </span>
              {previewButton(
                { name: file.name, load: async () => file },
                `task-issue-share-preview-local-file-${index}`
              )}
              <button
                type="button"
                data-testid={`task-issue-share-remove-file-${index}`}
                aria-label={t('taskIssueShare.removeFile', { name: file.name })}
                onClick={() => onChange(files.filter((_, item) => item !== index))}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <CloudFilePreviewDialog
          filename={preview.name}
          contentType={null}
          loadFile={preview.load}
          onDownload={async () => {
            await saveBlobToDownloads(await preview.load(), preview.name)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}
