import {
  AtSign,
  Check,
  ChevronDown,
  GitBranch,
  Paperclip,
  Plus,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react'
import { ComposerAutocompleteInput } from '../composer/ComposerAutocompleteInput'
import type { ComposerExternalMentionCandidate } from '../composer/composerAutocompleteInputTypes'
import type { ComposerInputHandle } from '../composer/composerInputTypes'
import { ActionMenu } from '../controls/ActionMenu'
import { SearchableSelect } from '../controls/SearchableSelect'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { TextField as ControlInput } from '../controls/TextField'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { IssueCommentComposer } from './IssueActivityPresentation'
import { IssueCommentActionPicker } from './IssueCommentActionPicker'
import type { CommentIssueActions } from './issueCommentActions'
import type { IssueMentionOption } from './issueCommentMentions'
import { useCommentAssignment, type CommentAssignment } from './useCommentAssignment'
export type { CommentAssignment } from './useCommentAssignment'

export interface IssueMainCommentTestIds {
  form: string
  input: string
  send: string
  settings: string
  file: string
  attach: string
}

const desktopTestIds: IssueMainCommentTestIds = {
  form: 'task-comment-form',
  input: 'cloud-task-activity-composer',
  send: 'send-message-button',
  settings: 'task-comment-settings-toggle',
  file: 'task-comment-file-input',
  attach: 'task-comment-attach',
}

/** One desktop composer; hosts provide draft persistence and execution services. */
export function IssueMainCommentComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  uploading,
  error,
  sendKey = 'enter',
  labels,
  attachments,
  onSelectFiles,
  settings,
  mentionCandidates = [],
  translate,
  inputRef,
  assignment,
  issueActions,
  testIds = desktopTestIds,
}: {
  value: string
  onChange(value: string): void
  /** The comment body, plus the structured targets it still names. */
  onSubmit(
    body: string,
    mentions: IssueMentionOption[],
    options?: import('./useCommentAssignment').CommentSubmissionOptions
  ): void | boolean | Promise<void | boolean>
  assignment?: CommentAssignment
  issueActions?: CommentIssueActions
  disabled: boolean
  sending: boolean
  uploading: boolean
  error?: string | null
  sendKey?: 'enter' | 'cmd_enter'
  labels: {
    placeholder: string
    send: string
    attach: string
    settings: string
  }
  attachments?: ReactNode
  onSelectFiles?(files: File[]): void | Promise<void>
  settings?: ReactNode
  mentionCandidates?: ComposerExternalMentionCandidate[]
  translate: CollaborationTranslate
  /** Lets a host (or a test) drive the editor the draft is written in. */
  inputRef?: Ref<ComposerInputHandle>
  testIds?: IssueMainCommentTestIds
}) {
  const settingsId = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLElement>(null)
  const composerRef = useRef<ComposerInputHandle>(null)
  const setInputRef = useCallback(
    (handle: ComposerInputHandle | null) => {
      composerRef.current = handle
      if (typeof inputRef === 'function') inputRef(handle)
      else if (inputRef) inputRef.current = handle
    },
    [inputRef]
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const transfer = useCommentAssignment(value, assignment, onSubmit, issueActions)
  const blocked = disabled || sending || transfer.busy
  const inlineError =
    transfer.error && transfer.commentCommitted
      ? translate('todo.comment_update_failed', undefined, {
          error: transfer.error,
        })
      : transfer.error || error
  const errorRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    if (inlineError) errorRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [inlineError])
  const canSend =
    !blocked &&
    !uploading &&
    (transfer.mode === 'child' && transfer.pendingToggle === null
      ? Boolean(value.trim() || transfer.pendingChild)
      : Boolean(
          value.trim() || transfer.target || transfer.moveTarget || transfer.pendingToggle !== null
        ))
  const sendLabel =
    transfer.mode === 'child' && transfer.pendingToggle === null
      ? translate('todo.send_and_create_child')
      : issueActions && (transfer.target || transfer.moveTarget || transfer.pendingToggle !== null)
        ? translate(
            value.trim() && !transfer.commentCommitted
              ? 'todo.send_and_update_issue'
              : 'todo.update_issue'
          )
        : transfer.target
          ? translate(value.trim() ? 'todo.send_and_assign' : 'todo.assign_only')
          : issueActions
            ? translate('todo.comment_send')
            : labels.send
  const submit = (draft: string) => {
    if (canSend) void transfer.submit(draft)
  }

  const modeControl = assignment?.createChild ? (
    <span className="inline-flex min-w-0" title={translate('todo.comment_assignment_mode')}>
      <SelectRoot
        value={normalizeSelectValue(transfer.mode)}
        onValueChange={selectedValue => {
          if (selectedValue !== null) return transfer.setMode(selectedValue as 'current' | 'child')
        }}
        disabled={blocked || Boolean(transfer.pendingChild)}
      >
        <SelectTrigger
          data-testid={`${testIds.form}-assignment-mode`}
          aria-label={translate('todo.comment_assignment_mode')}
          appearance="composer"
          className="max-w-full"
        >
          {issueActions && <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 truncate">
            {translate(
              transfer.mode === 'child' ? 'todo.create_child_issue' : 'todo.assign_current_issue'
            )}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="current" disabled={assignment.canAssignCurrent === false}>
            {translate('todo.assign_current_issue')}
          </SelectItem>
          <SelectItem value="child">{translate('todo.create_child_issue')}</SelectItem>
        </SelectContent>
      </SelectRoot>
    </span>
  ) : null
  const pendingControls = (
    <>
      {assignment ? (
        <>
          {!issueActions ? modeControl : null}
          {issueActions ? (
            <IssueCommentActionPicker
              testId={`${testIds.form}-assignee`}
              label={translate('todo.comment_assign_action')}
              placeholder={translate('todo.comment_assign_placeholder')}
              value={transfer.target}
              options={[{ value: '', label: translate('todo.keep_assignee') }, ...transfer.options]}
              onChange={transfer.setTarget}
              disabled={
                blocked ||
                transfer.childTargetLocked ||
                (transfer.mode === 'current' && assignment.canAssignCurrent === false)
              }
              searchLabel={translate('todo.search_assignee')}
              emptyLabel={translate('todo.no_matching_assignee')}
              clearLabel={translate('todo.cancel_comment_assignment')}
            />
          ) : (
            <SearchableSelect
              testId={`${testIds.form}-assignee`}
              accessibleLabel={translate('todo.comment_assign_to')}
              value={transfer.target}
              onChange={transfer.setTarget}
              disabled={
                blocked ||
                transfer.childTargetLocked ||
                (transfer.mode === 'current' && assignment.canAssignCurrent === false)
              }
              searchPlaceholder={translate('todo.search_assignee')}
              emptyLabel={translate('todo.no_matching_assignee')}
              className="task-detail-comment-assignee"
              triggerContent={
                <>
                  {transfer.target ? (
                    <span className="truncate">
                      {transfer.options.find(option => option.value === transfer.target)?.label}
                    </span>
                  ) : (
                    <span>
                      {translate(
                        transfer.mode === 'child' ? 'todo.unassigned' : 'todo.keep_assignee'
                      )}
                    </span>
                  )}
                  <ChevronDown className="h-4 w-4 shrink-0" />
                </>
              }
              options={[{ value: '', label: translate('todo.keep_assignee') }, ...transfer.options]}
            />
          )}
        </>
      ) : null}
      {issueActions && transfer.mode === 'current' && issueActions.moves.length > 0 ? (
        <IssueCommentActionPicker
          testId={`${testIds.form}-move`}
          label={translate('todo.comment_move_to')}
          placeholder={translate('todo.comment_move_placeholder')}
          value={transfer.moveTarget}
          options={[
            { value: '', label: translate('todo.cancel_comment_move') },
            ...issueActions.moves,
          ]}
          onChange={transfer.setMove}
          disabled={blocked}
          searchLabel={translate('todo.search_comment_lane')}
          emptyLabel={translate('todo.no_comment_lane')}
          clearLabel={translate('todo.cancel_comment_move')}
        />
      ) : null}
    </>
  )

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      canSend={canSend}
      onSubmit={() => submit(value)}
      sendLabel={sendLabel}
      showSendLabel={Boolean(assignment || issueActions)}
      workflow={Boolean(issueActions)}
      pendingActions={
        issueActions ? (
          <div className="task-detail-comment-pending-actions">{pendingControls}</div>
        ) : undefined
      }
      sendActions={
        issueActions?.canToggle ? (
          <ActionMenu
            density="dense"
            testId={`${testIds.form}-send-actions`}
            ariaLabel={translate('todo.comment_send_actions')}
            icon={ChevronDown}
            triggerClassName="task-detail-comment-submit-menu"
            placement="bottom-end"
            showTriggerTooltip={false}
            disabled={blocked || uploading || Boolean(transfer.pendingChild)}
            items={[
              {
                testId: `${testIds.form}-send-option`,
                label: sendLabel,
                disabled: !canSend,
                onSelect: () => submit(value),
              },
              {
                testId: `${testIds.form}-close`,
                label: translate(
                  issueActions.closed
                    ? 'todo.reopen_issue_action'
                    : value.trim()
                      ? 'todo.comment_and_close_issue'
                      : 'todo.close_issue_action'
                ),
                onSelect: () => transfer.submit(value, !issueActions.closed),
              },
            ]}
          />
        ) : undefined
      }
      sendTestId={testIds.send}
      before={attachments}
      input={
        <>
          <ComposerAutocompleteInput
            ref={setInputRef}
            value={value}
            onChange={onChange}
            onSubmit={nextValue => submit(nextValue ?? value)}
            canSend={canSend}
            disabled={blocked}
            placeholder={labels.placeholder}
            testId={testIds.input}
            translate={translate}
            className="task-detail-comment-editor"
            rows={2}
            textareaRef={editorRef}
            mentionScope="external"
            externalMentionCandidates={mentionCandidates}
            onActivateMention={assignment && !blocked ? transfer.suggestReference : undefined}
            sendKey={sendKey}
            onPasteFiles={onSelectFiles ? files => void onSelectFiles(files) : undefined}
          />
        </>
      }
      actions={
        <>
          {settings && (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={testIds.settings}
              aria-label={labels.settings}
              title={labels.settings}
              disabled={blocked}
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen(open => !open)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </ControlButton>
          )}
          <ControlInput
            ref={fileInput}
            data-testid={testIds.file}
            type="file"
            multiple
            hidden
            disabled={!onSelectFiles || blocked}
            onChange={event => {
              const files = Array.from(event.target.files ?? [])
              if (files.length) void onSelectFiles?.(files)
              event.target.value = ''
            }}
          />
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={testIds.attach}
            aria-label={labels.attach}
            title={labels.attach}
            disabled={!onSelectFiles || blocked}
            onClick={() => fileInput.current?.click()}
          >
            {issueActions ? <Plus className="h-4 w-4" /> : <Paperclip className="h-4 w-4" />}
          </ControlButton>
          {issueActions ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`${testIds.form}-mention`}
              aria-label={translate('todo.comment_mention')}
              title={translate('todo.comment_mention')}
              disabled={blocked}
              onClick={() => {
                const insertion = composerRef.current?.captureInsertion?.()
                if (!insertion?.insertText('@'))
                  composerRef.current?.setValue(
                    `${value}${value && !/\s$/.test(value) ? ' ' : ''}@`
                  )
                composerRef.current?.focus()
              }}
            >
              <AtSign className="h-4 w-4" />
            </ControlButton>
          ) : null}
          {issueActions ? modeControl : null}
          {transfer.suggestion ? (
            <div
              role="group"
              data-testid={`${testIds.form}-assignee-suggestion`}
              aria-label={translate('todo.assignment_suggestion', undefined, {
                name: transfer.suggestion.label,
              })}
              className="inline-flex min-w-0 shrink items-center gap-1 rounded-lg bg-muted px-1 text-sm text-text-secondary"
            >
              <span className="shrink-0 pl-1 text-text-muted">
                {translate('todo.comment_assign_to')}
              </span>
              <span className="min-w-0 truncate px-1">{transfer.suggestion.label}</span>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${testIds.form}-assignee-confirm`}
                aria-label={translate('todo.confirm_assignment')}
                title={translate('todo.confirm_assignment')}
                disabled={blocked || uploading}
                onClick={transfer.acceptSuggestion}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-primary hover:bg-background disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
              </ControlButton>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${testIds.form}-assignee-dismiss`}
                aria-label={translate('todo.dismiss_assignment_suggestion')}
                title={translate('todo.dismiss_assignment_suggestion')}
                disabled={blocked}
                onClick={transfer.dismissSuggestion}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-background disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </ControlButton>
            </div>
          ) : null}
          {!issueActions ? <span className="flex-1" /> : null}
          {!issueActions ? pendingControls : null}
        </>
      }
      after={
        <>
          {settingsOpen && settings ? (
            <div id={settingsId} className="task-detail-comment-settings">
              {settings}
            </div>
          ) : null}
          {inlineError ? (
            <p ref={errorRef} role="alert" className="task-detail-comment-inline-error">
              {inlineError}
            </p>
          ) : null}
        </>
      }
    />
  )
}
