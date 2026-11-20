import { Paperclip, X } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export function TaskIssueShareFiles({
  sourceTitle,
  files,
  onChange,
}: {
  sourceTitle: string
  files: File[]
  onChange(files: File[]): void
}) {
  const { t } = useTranslation('common')
  const input = useRef<HTMLInputElement>(null)
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
          {t('taskIssueShare.addFiles')}
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
      {files.length > 0 && (
        <ul className="grid gap-1" data-testid="task-issue-share-files">
          {files.map((file, index) => (
            <li key={index} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/40 px-2">
              <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>
                {file.name}
              </span>
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
    </section>
  )
}
