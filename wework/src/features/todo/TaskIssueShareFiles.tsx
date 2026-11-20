import { Check, FileText, Maximize2, Paperclip, X } from 'lucide-react'
import { mimeTypeForFileName } from '@wegent/chat-core/workspace-file-types'
import { useAttachmentPreview } from '@wegent/collaboration'
import { useIntersectionEvent } from '@wegent/collaboration/dom-events'
import type { TaskIssueConversationFile } from './taskIssueConversationFiles'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'

type PreviewableFile = File | TaskIssueConversationFile

async function loadFile(file: PreviewableFile) {
  return file instanceof File ? file : file.load()
}

function ImageThumbnail({ file }: { file: PreviewableFile }) {
  const read = useCallback(() => loadFile(file), [file])
  const { preview, failed, markFailed } = useAttachmentPreview(read, file.name)
  return preview?.kind === 'image' && !failed ? (
    <img
      src={preview.url}
      alt=""
      onError={() => markFailed()}
      data-testid="task-issue-share-thumbnail-image"
      className="h-full w-full object-cover"
    />
  ) : (
    <FileText className="h-6 w-6" aria-hidden="true" />
  )
}

function FileThumbnail({ file }: { file: PreviewableFile }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const image = mimeTypeForFileName(file.name).startsWith('image/')
  const onIntersection = useCallback<IntersectionObserverCallback>(
    ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
    []
  )
  useIntersectionEvent(ref, onIntersection, { enabled: image })
  return (
    <span
      ref={ref}
      className="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-md bg-muted text-text-secondary"
    >
      {image && visible ? (
        <ImageThumbnail file={file} />
      ) : (
        <FileText className="h-6 w-6" aria-hidden="true" />
      )}
    </span>
  )
}

export function TaskIssueShareFiles({
  files,
  conversationFiles,
  selectedConversationFileIds,
  selectedExcerptCount,
  children,
  onSelectConversationFiles,
  onChange,
}: {
  files: File[]
  conversationFiles: TaskIssueConversationFile[]
  selectedConversationFileIds: string[]
  selectedExcerptCount: number
  children: ReactNode
  onSelectConversationFiles(ids: string[]): void
  onChange(files: File[]): void
}) {
  const { t } = useTranslation('common')
  const input = useRef<HTMLInputElement>(null)
  const [localFiles, setLocalFiles] = useState<File[]>(files)
  const [preview, setPreview] = useState<PreviewableFile | null>(null)
  const readPreview = useCallback(() => loadFile(preview!), [preview])
  const tile = (
    file: PreviewableFile,
    selectionId: string,
    previewId: string,
    selected: boolean,
    toggle: () => void
  ) => (
    <>
      <button
        type="button"
        data-testid={selectionId}
        aria-pressed={selected}
        onClick={toggle}
        className="relative block w-full min-w-0 rounded-md text-left hover:bg-muted/50 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-ring"
      >
        <FileThumbnail file={file} />
        {selected && (
          <span className="absolute left-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-text-primary text-background">
            <Check
              data-testid="task-issue-share-selected-file"
              className="size-4"
              aria-hidden="true"
            />
          </span>
        )}
        <span
          className={`block truncate py-1 pl-1 text-xs ${file instanceof File ? 'min-h-11 pr-12 md:min-h-0 md:pr-8' : 'pr-1'}`}
          title={file.name}
        >
          {file.name}
        </span>
      </button>
      <button
        type="button"
        data-testid={previewId}
        aria-label={t('taskIssueShare.previewFile', { name: file.name })}
        title={t('taskIssueShare.previewFile', { name: file.name })}
        onClick={() => setPreview(file)}
        className="absolute right-1.5 top-1.5 grid size-11 place-items-center rounded-md bg-background/90 text-text-primary hover:bg-background md:size-8"
      >
        <Maximize2 className="size-3.5" aria-hidden="true" />
      </button>
    </>
  )
  return (
    <section
      className="grid min-w-0 gap-2"
      data-testid="task-issue-share-content"
      aria-label={t('taskIssueShare.shareContent')}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-sm font-medium">{t('taskIssueShare.shareContent')}</h3>
          <span
            data-testid="task-issue-share-selection-count"
            className="text-xs text-text-secondary"
          >
            {(selectedConversationFileIds.length || files.length || selectedExcerptCount) > 0 &&
              t('taskIssueShare.selectionCount', {
                files: selectedConversationFileIds.length + files.length,
                excerpts: selectedExcerptCount,
              })}
          </span>
        </div>
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
            const added: File[] = []
            for (const file of Array.from(event.target.files ?? [])) {
              if (
                ![...localFiles, ...added].some(
                  item =>
                    item.name === file.name &&
                    item.size === file.size &&
                    item.lastModified === file.lastModified
                )
              )
                added.push(file)
            }
            setLocalFiles([...localFiles, ...added])
            onChange([...files, ...added])
            event.target.value = ''
          }}
        />
      </div>
      {(children || conversationFiles.length > 0 || localFiles.length > 0) && (
        <div className="grid min-w-0 gap-2 rounded-lg border border-border p-2">
          {children}
          {(conversationFiles.length > 0 || localFiles.length > 0) && (
            <div data-testid="task-issue-share-files">
              <ul
                data-testid="task-issue-share-conversation-files"
                className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(min(100%,7rem),1fr))] items-start gap-2 overflow-y-auto"
              >
                {conversationFiles.map((file, index) => {
                  const checked = selectedConversationFileIds.includes(file.id)
                  return (
                    <li key={file.id} className="relative min-w-0">
                      {tile(
                        file,
                        `task-issue-share-conversation-file-${index}`,
                        `task-issue-share-preview-conversation-file-${index}`,
                        checked,
                        () =>
                          onSelectConversationFiles(
                            checked
                              ? selectedConversationFileIds.filter(id => id !== file.id)
                              : [...selectedConversationFileIds, file.id]
                          )
                      )}
                    </li>
                  )
                })}
                {localFiles.map((file, index) => (
                  <li key={index} className="relative min-w-0">
                    {tile(
                      file,
                      `task-issue-share-local-file-${index}`,
                      `task-issue-share-preview-local-file-${index}`,
                      files.includes(file),
                      () =>
                        onChange(
                          files.includes(file)
                            ? files.filter(item => item !== file)
                            : [...files, file]
                        )
                    )}
                    <button
                      type="button"
                      data-testid={`task-issue-share-remove-file-${index}`}
                      aria-label={t('taskIssueShare.removeFile', { name: file.name })}
                      onClick={() => {
                        setLocalFiles(localFiles.filter(item => item !== file))
                        onChange(files.filter(item => item !== file))
                      }}
                      className="absolute bottom-0 right-0 grid size-11 place-items-center rounded-md bg-background hover:bg-muted md:size-7"
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {preview && (
        <CloudFilePreviewDialog
          filename={preview.name}
          contentType={null}
          loadFile={readPreview}
          onDownload={async () => {
            await saveBlobToDownloads(await readPreview(), preview.name)
          }}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}
