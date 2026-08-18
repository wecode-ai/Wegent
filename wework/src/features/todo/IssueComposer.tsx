import { CircleDot, Play } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import { type ProjectChatControls } from '@/components/chat/ChatInput'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Attachment } from '@/types/api'
import { WorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { issueDraftFromText } from './issueComposerDraft'

export interface IssueComposerBoard {
  key: string
  name: string
}

interface IssueComposerProps {
  boards: IssueComposerBoard[]
  initialBoardKey: string
  initialStatus?: CloudLoopItem['status']
  initialStartExecution?: boolean
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onCreate: (input: {
    boardKey: string
    title: string
    description: string
    files: File[]
    startExecution: boolean
  }) => Promise<boolean | void> | boolean | void
}

interface StagedIssueAttachment {
  attachment: Attachment
  file: File
}

function attachmentFromFile(file: File, id: number): Attachment {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '') : ''
  return {
    id,
    filename: file.name,
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
    status: 'ready',
    file_extension: extension,
    created_at: new Date().toISOString(),
  }
}

export function IssueComposer({
  boards,
  initialBoardKey,
  initialStatus = 'inbox',
  initialStartExecution = false,
  busy = false,
  error,
  onCancel,
  onCreate,
}: IssueComposerProps) {
  const { t } = useTranslation()
  const workbench = useContext(WorkbenchPaneContext)
  const [boardKey, setBoardKey] = useState(initialBoardKey)
  const [content, setContent] = useState('')
  const [startExecution, setStartExecution] = useState(initialStartExecution)
  const [stagedAttachments, setStagedAttachments] = useState<StagedIssueAttachment[]>([])
  const nextAttachmentId = useRef(-1)

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onCancel])

  const projectChat: ProjectChatControls | undefined = workbench?.projectChat
    ? {
        ...workbench.projectChat,
        scopeKey: `issue-composer:${boardKey}`,
        attachments: stagedAttachments.map(item => item.attachment),
        uploadingFiles: new Map(),
        errors: new Map(),
        handleFileSelect: async files => {
          const selectedFiles = Array.isArray(files) ? files : [files]
          setStagedAttachments(current => [
            ...current,
            ...selectedFiles.map(file => {
              const id = nextAttachmentId.current
              nextAttachmentId.current -= 1
              return { attachment: attachmentFromFile(file, id), file }
            }),
          ])
        },
        removeAttachment: async attachmentId => {
          setStagedAttachments(current =>
            current.filter(item => item.attachment.id !== attachmentId)
          )
        },
      }
    : undefined

  const submit = async (submittedContent?: string) => {
    const submittedDraft = issueDraftFromText(submittedContent ?? content)
    if (!boardKey || !submittedDraft.title || busy) return false
    return onCreate({
      boardKey,
      ...submittedDraft,
      files: stagedAttachments.map(item => item.file),
      startExecution,
    })
  }

  const destinationLabel = startExecution
    ? t('todo.issue_execution_destination', '创建后进入「进行中」并开始执行')
    : t('todo.issue_status_destination', '创建到「{{status}}」', {
        status: {
          inbox: t('todo.status_inbox', '收集箱'),
          pending: t('todo.status_pending', '待开始'),
          in_progress: t('todo.status_in_progress', '进行中'),
          in_review: t('todo.status_in_review', '待确认'),
          completed: t('todo.status_completed', '已完成'),
        }[initialStatus],
      })

  return (
    <div
      data-testid="workspace-issue-composer"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 pb-16 pt-8"
    >
      <section className="w-full max-w-[760px]">
        <header className="mb-5">
          <h1 className="text-heading-md font-medium text-text-primary">
            {t('todo.new_issue', '新建 Issue')}
          </h1>
          <p className="mt-1.5 text-sm text-text-muted">
            {t('todo.issue_create_description', '描述要推进的事情，创建后自动进入所选看板。')}
          </p>
        </header>

        <BufferedChatInput
          value={content}
          onChange={setContent}
          onSubmit={submit}
          disabled={busy}
          submitDisabled={busy || !boardKey}
          error={error}
          placeholder={t('todo.issue_placeholder', '描述你想推进的事情…')}
          inputTestId="workspace-issue-input"
          submitButtonTestId="workspace-issue-submit"
          variant="desktop"
          projectChat={projectChat}
          showProjectWorkBar={false}
          showWorkspaceMenu={false}
          contextHeader={
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
              <span className="shrink-0 text-xs text-text-muted">
                {t('todo.issue_board_label', '放入')}
              </span>
              <span className="relative inline-flex min-w-0 items-center">
                <CircleDot className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-blue-500" />
                <select
                  data-testid="workspace-issue-board"
                  aria-label={t('todo.issue_board_aria', '选择 Issue 看板')}
                  value={boardKey}
                  onChange={event => setBoardKey(event.target.value)}
                  className="h-8 max-w-64 cursor-pointer appearance-none rounded-lg bg-transparent py-0 pl-8 pr-7 text-sm font-medium text-text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus/30"
                >
                  {boards.map(board => (
                    <option key={board.key} value={board.key}>
                      {board.name}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2 text-xs text-text-muted">
                  ⌄
                </span>
              </span>
              <span className="ml-auto min-w-0 truncate text-xs text-text-muted">
                {destinationLabel}
              </span>
            </div>
          }
          toolbarLeadingContext={
            <label className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs text-text-secondary transition hover:bg-muted hover:text-text-primary">
              <input
                type="checkbox"
                data-testid="workspace-issue-start-execution"
                checked={startExecution}
                onChange={event => setStartExecution(event.target.checked)}
                className="sr-only"
              />
              <span
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-md border',
                  startExecution
                    ? 'border-text-primary bg-text-primary text-background'
                    : 'border-border text-transparent'
                )}
              >
                <Play className="h-3 w-3 fill-current" />
              </span>
              {t('todo.issue_start_execution', '创建后开始执行')}
            </label>
          }
        />

        {!error ? (
          <p className="mt-3 text-center text-xs text-text-muted">
            {t(
              'todo.issue_composer_hint',
              '第一行作为 Issue 标题；附件、插件和模型与新建任务保持一致'
            )}
          </p>
        ) : null}
      </section>
    </div>
  )
}
