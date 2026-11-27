import { Button } from '@wegent/collaboration/markdown/Button'
import { Check, ChevronLeft, ChevronRight, FileText, Maximize2, Plus, X } from 'lucide-react'
import { mimeTypeForFileName } from '@wegent/chat-core/workspace-file-types'
import { useAttachmentPreview } from '@wegent/collaboration'
import { useElementWidth, useIntersectionEvent } from '@wegent/collaboration/dom-events'
import type { TaskIssueConversationFile } from './taskIssueConversationFiles'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { CloudFilePreviewDialog } from './CloudFilePreviewDialog'

const attachmentNavigationClass =
  'mt-2.5 grid size-11 shrink-0 place-items-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary md:mt-4 md:size-8'

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
      className="grid h-16 w-full place-items-center overflow-hidden rounded-md bg-muted text-text-secondary"
    >
      {image && visible ? (
        <ImageThumbnail file={file} />
      ) : (
        <FileText className="size-5" aria-hidden="true" />
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
  messageActions,
  showConversation = true,
  onSelectConversationFiles,
  onChange,
}: {
  files: File[]
  conversationFiles: TaskIssueConversationFile[]
  selectedConversationFileIds: string[]
  selectedExcerptCount: number
  children: ReactNode
  messageActions?: ReactNode
  showConversation?: boolean
  onSelectConversationFiles(ids: string[]): void
  onChange(files: File[]): void
}) {
  const { t } = useTranslation('common')
  const input = useRef<HTMLInputElement>(null)
  const previewTrigger = useRef<HTMLButtonElement>(null)
  const gallery = useRef<HTMLDivElement>(null)
  const [viewportWidth, observeViewport] = useElementWidth<HTMLDivElement>()
  const [contentWidth, observeContent] = useElementWidth<HTMLUListElement>()
  const [scrollLeft, setScrollLeft] = useState(0)
  const attachGallery = useCallback(
    (element: HTMLDivElement | null) => {
      gallery.current = element
      if (element) setScrollLeft(element.scrollLeft)
      return observeViewport(element)
    },
    [observeViewport]
  )
  const scrollAttachments = (direction: -1 | 1) => {
    const viewport = gallery.current
    if (viewport) viewport.scrollBy({ left: direction * viewport.clientWidth })
  }

  const [localFiles, setLocalFiles] = useState<File[]>(files)
  const [preview, setPreview] = useState<PreviewableFile | null>(null)
  const hasFiles = conversationFiles.length > 0 || localFiles.length > 0
  const readPreview = useCallback(() => loadFile(preview!), [preview])
  const tile = (
    file: PreviewableFile,
    selectionId: string,
    previewId: string,
    selected: boolean,
    toggle: () => void
  ) => (
    <>
      <Button
        variant="unstyled"
        showTooltip={false}
        type="button"
        data-testid={selectionId}
        aria-label={file.name}
        title={file.name}
        aria-pressed={selected}
        onClick={toggle}
        className="block w-full min-w-0 overflow-hidden rounded-lg text-left ring-inset aria-pressed:ring-2 aria-pressed:ring-focus keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-ring"
      >
        <FileThumbnail file={file} />
        <span className="flex h-8 min-w-0 items-center gap-1.5 px-2 text-xs text-text-secondary">
          <span
            aria-hidden="true"
            className={`grid size-4 shrink-0 place-items-center rounded border ${selected ? 'border-text-primary bg-text-primary text-background' : 'border-text-secondary bg-background'}`}
          >
            {selected && (
              <Check
                data-testid="task-issue-share-selected-file"
                className="size-3"
                aria-hidden="true"
              />
            )}
          </span>
          <span className="min-w-0 truncate">{file.name}</span>
        </span>
      </Button>
      <Button
        variant="unstyled"
        showTooltip={false}
        type="button"
        data-testid={previewId}
        aria-label={t('taskIssueShare.previewFile', { name: file.name })}
        title={t('taskIssueShare.previewFile', { name: file.name })}
        onClick={event => {
          previewTrigger.current = event.currentTarget
          setPreview(file)
        }}
        className="absolute right-1.5 top-1.5 grid size-11 place-items-center rounded-md bg-background/90 text-text-primary hover:bg-background md:size-8"
      >
        <Maximize2 className="size-3.5" aria-hidden="true" />
      </Button>
    </>
  )
  return (
    <section
      className="grid min-w-0 gap-2"
      data-testid="task-issue-share-content"
      aria-label={t(
        showConversation ? 'taskIssueShare.shareContent' : 'taskIssueShare.attachments'
      )}
    >
      {showConversation && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:min-h-8">
            <h3 className="shrink-0 whitespace-nowrap text-sm font-medium">
              {t('taskIssueShare.shareContent')}
            </h3>
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
          {messageActions}
        </div>
      )}
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
      <div className="grid min-w-0 gap-3">
        {children}
        {showConversation && (
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="text-xs font-medium text-text-secondary">
              {t('taskIssueShare.attachments')}
            </h4>
            <span aria-hidden="true" className="flex-1 border-t border-dashed border-border" />
          </div>
        )}
        <div data-testid="task-issue-share-files" className="flex min-w-0 items-start gap-2">
          <Button
            variant="unstyled"
            type="button"
            aria-label={t('taskIssueShare.uploadFiles')}
            title={t('taskIssueShare.uploadFiles')}
            data-testid="task-issue-share-select-files"
            onClick={() => input.current?.click()}
            className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary md:min-h-7 md:min-w-7 ${hasFiles ? 'mt-2.5 md:mt-[1.125rem]' : ''}`}
          >
            <Plus className="size-4" aria-hidden="true" />
            {!hasFiles && t('taskIssueShare.addAttachment')}
          </Button>
          {hasFiles && (
            <div className="flex min-w-0 flex-1 items-start gap-1">
              <Button
                variant="unstyled"
                type="button"
                data-testid="task-issue-share-files-previous"
                aria-label={t('taskIssueShare.previousAttachments')}
                disabled={scrollLeft <= 1}
                onClick={() => scrollAttachments(-1)}
                className={attachmentNavigationClass}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </Button>
              <div
                ref={attachGallery}
                onScroll={event => setScrollLeft(event.currentTarget.scrollLeft)}
                data-testid="task-issue-share-conversation-files"
                className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
              >
                <ul
                  ref={observeContent}
                  className="grid w-max grid-flow-col auto-cols-[7rem] items-start gap-2"
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
                      <Button
                        variant="unstyled"
                        showTooltip={false}
                        type="button"
                        data-testid={`task-issue-share-remove-file-${index}`}
                        aria-label={t('taskIssueShare.removeFile', { name: file.name })}
                        onClick={() => {
                          setLocalFiles(localFiles.filter(item => item !== file))
                          onChange(files.filter(item => item !== file))
                        }}
                        className="absolute left-1.5 top-1.5 grid size-11 place-items-center rounded-md bg-background hover:bg-muted md:size-7"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
              <Button
                variant="unstyled"
                type="button"
                data-testid="task-issue-share-files-next"
                aria-label={t('taskIssueShare.nextAttachments')}
                disabled={viewportWidth === 0 || scrollLeft + viewportWidth >= contentWidth - 1}
                onClick={() => scrollAttachments(1)}
                className={attachmentNavigationClass}
              >
                <ChevronRight className="size-4" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {preview && (
        <CloudFilePreviewDialog
          filename={preview.name}
          contentType={null}
          loadFile={readPreview}
          onDownload={async () => {
            await saveBlobToDownloads(await readPreview(), preview.name)
          }}
          finalFocus={() => previewTrigger.current}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  )
}
