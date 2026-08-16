import { ArrowUp, CircleDot } from 'lucide-react'
import { useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { issueDraftFromText } from './issueComposerDraft'

export interface IssueComposerBoard {
  key: string
  name: string
}

interface IssueComposerProps {
  boards: IssueComposerBoard[]
  initialBoardKey: string
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onCreate: (input: {
    boardKey: string
    title: string
    description: string
  }) => Promise<void> | void
}

export function IssueComposer({
  boards,
  initialBoardKey,
  busy = false,
  error,
  onCancel,
  onCreate,
}: IssueComposerProps) {
  const { t } = useTranslation()
  const [boardKey, setBoardKey] = useState(initialBoardKey)
  const [content, setContent] = useState('')
  const draft = useMemo(() => issueDraftFromText(content), [content])
  const canCreate = Boolean(boardKey && draft.title && !busy)

  const submit = () => {
    if (!canCreate) return
    void onCreate({ boardKey, ...draft })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  }

  return (
    <div
      data-testid="workspace-issue-composer"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 pb-16 pt-8"
    >
      <section className="w-full max-w-[720px]">
        <header className="mb-5">
          <h1 className="text-heading-md font-medium text-text-primary">
            {t('todo.new_issue', '新建 Issue')}
          </h1>
          <p className="mt-1.5 text-sm text-text-muted">
            {t('todo.issue_create_description', '描述要推进的事情，创建后自动进入所选看板。')}
          </p>
        </header>

        <div className="overflow-visible rounded-[20px] border border-border bg-background shadow-lg">
          <div className="flex min-h-[52px] items-center gap-2 border-b border-border px-4">
            <span className="text-sm text-text-muted">{t('todo.issue_board_label', '放入')}</span>
            <span className="relative inline-flex items-center">
              <CircleDot className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-blue-500" />
              <select
                data-testid="workspace-issue-board"
                aria-label={t('todo.issue_board_aria', '选择 Issue 看板')}
                value={boardKey}
                onChange={event => setBoardKey(event.target.value)}
                className="h-9 max-w-72 cursor-pointer appearance-none rounded-xl bg-muted py-0 pl-9 pr-8 text-sm font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
              >
                {boards.map(board => (
                  <option key={board.key} value={board.key}>
                    {board.name}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-3 text-xs text-text-muted">
                ⌄
              </span>
            </span>
            <span className="ml-auto text-xs text-text-muted">
              {t('todo.issue_inbox_destination', '创建到「收集箱」')}
            </span>
          </div>

          <textarea
            data-testid="workspace-issue-input"
            value={content}
            autoFocus
            onChange={event => setContent(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('todo.issue_placeholder', '描述你想推进的事情…')}
            className="block min-h-[168px] w-full resize-none bg-transparent px-5 py-5 text-base leading-7 text-text-primary outline-none placeholder:text-text-muted/70"
          />

          <footer className="flex min-h-[56px] items-center gap-2 px-3 pb-3">
            <span className="px-2 text-xs text-text-muted">
              {t('todo.issue_followup_hint', '标题、参与者和执行步骤可在创建后补充')}
            </span>
            <button
              type="button"
              data-testid="workspace-issue-cancel"
              onClick={onCancel}
              className="ml-auto h-9 rounded-lg px-3 text-sm text-text-secondary transition hover:bg-muted hover:text-text-primary"
            >
              {t('common.cancel', '取消')}
            </button>
            <button
              type="button"
              data-testid="workspace-issue-submit"
              aria-label={t('todo.create_issue', '创建 Issue')}
              disabled={!canCreate}
              onClick={submit}
              className={cn(
                'flex h-10 w-10 items-center justify-center rounded-xl transition',
                canCreate
                  ? 'bg-text-primary text-background hover:opacity-90'
                  : 'cursor-not-allowed bg-muted text-text-muted'
              )}
            >
              <ArrowUp className="h-5 w-5" />
            </button>
          </footer>
        </div>

        {error ? (
          <p data-testid="workspace-issue-error" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="mt-3 text-center text-xs text-text-muted">
            {t('todo.issue_create_shortcut', '⌘ Enter 创建 Issue')}
          </p>
        )}
      </section>
    </div>
  )
}
