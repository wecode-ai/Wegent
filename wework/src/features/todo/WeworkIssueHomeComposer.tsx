import { useId, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { ChevronDown, Laptop, Cloud, Check, AtSign, Hash } from 'lucide-react'
import type { ComposerInputHandle } from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { AnchorPopover } from './AnchorPopover'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'

/** The Tasks-tab input with Issue persistence supplied by the collaboration host. */
export function WeworkIssueHomeComposer({
  ref,
  renderTaskComposer,
  ...props
}: IssueHomeTaskComposerProps & {
  renderTaskComposer?(props: IssueHomeTaskComposerProps): ReactNode
}) {
  const { t } = useTranslation('common')
  const [taskPending, setTaskPending] = useState(false)
  const disabled = props.disabled || taskPending
  const [taskMode, setTaskMode] = useState(false)
  const [taskOpened, setTaskOpened] = useState(false)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const input = useRef<ComposerInputHandle>(null)
  const [taskInput, setTaskInput] = useState<ComposerInputHandle | null>(null)
  const getActiveInput = () => (taskMode ? taskInput : input.current)
  const composerId = useId()
  const selectedProject = props.projects.find(project => project.id === props.projectId)
  const projectLocation = (project: IssueHomeTaskComposerProps['projects'][number]) => {
    const location = t(
      project.project_store === 'local'
        ? 'issue_creation.local_space'
        : 'issue_creation.cloud_space'
    )
    const workspace = props.workspaces?.find(item => item.id === project.workspace_id)
    return workspace && workspace.name !== location ? `${location} · ${workspace.name}` : location
  }
  const ProjectIcon = selectedProject?.project_store === 'local' ? Laptop : Cloud
  useImperativeHandle(ref, () => ({
    get element() {
      return getActiveInput()?.element ?? null
    },
    focus: () => getActiveInput()?.focus(),
    getValue: () => getActiveInput()?.getValue() ?? props.value,
    setValue: (value, offset) => getActiveInput()?.setValue(value, offset),
    insertReference: reference => getActiveInput()?.insertReference(reference),
  }))
  const insert = (text: string) => {
    if (disabled) return
    input.current?.insertReference(text)
    input.current?.focus()
  }
  const closePicker = () => {
    anchor?.focus()
    setAnchor(null)
  }
  const handleDraftChange = (draft: string) => {
    flushSync(() => props.onDraftChange?.(draft))
  }
  const projectControl = (
    <div data-testid="collaboration-issue-project-bar" className="flex min-w-0 items-center">
      <button
        type="button"
        data-testid="collaboration-issue-project-trigger"
        disabled={disabled}
        aria-expanded={Boolean(anchor)}
        aria-haspopup="dialog"
        aria-label={
          selectedProject
            ? `${props.projectLabel}: ${selectedProject.name} · ${projectLocation(selectedProject)}`
            : props.projectLabel
        }
        onClick={event => setAnchor(event.currentTarget)}
        className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-sm text-text-secondary transition-colors hover:bg-text-primary/[0.04] hover:text-text-primary keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary md:min-h-7"
      >
        <ProjectIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="truncate">{selectedProject?.name}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
    </div>
  )
  return (
    <section
      data-testid="collaboration-issue-workspace"
      className="flex min-h-0 w-full flex-col gap-3"
    >
      <div className="flex w-full min-w-0 flex-col gap-3">
        <div
          role="tablist"
          aria-label={t('issue_creation.entry_mode')}
          className="flex items-center gap-5"
        >
          {[false, ...(renderTaskComposer ? [true] : [])].map(mode => (
            <button
              key={String(mode)}
              type="button"
              role="tab"
              id={`${composerId}-${mode ? 'task' : 'record'}-tab`}
              aria-controls={`${composerId}-${mode ? 'task' : 'record'}-panel`}
              aria-selected={taskMode === mode}
              data-testid={mode ? 'personal-home-new-issue' : 'personal-home-record-mode'}
              disabled={disabled}
              onClick={() => {
                if (taskMode === mode) return
                props.onChange(getActiveInput()?.getValue() ?? props.value)
                if (mode) setTaskOpened(true)
                setTaskMode(mode)
              }}
              className={`min-h-11 border-b-2 pb-1 text-base transition-colors keyboard:focus-visible:rounded-sm keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 md:min-h-8 ${taskMode === mode ? 'border-text-primary font-medium text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'}`}
            >
              {t(mode ? 'issue_creation.create_task' : 'issue_creation.record_mode')}
            </button>
          ))}
        </div>
        {props.environmentNotice}
        <div
          id={`${composerId}-record-panel`}
          role="tabpanel"
          aria-labelledby={`${composerId}-record-tab`}
          className={taskMode ? 'hidden' : ''}
          inert={taskMode}
        >
          <BufferedChatInput
            inputRef={input}
            variant="desktop"
            presentation="chat"
            clearOnSubmit={false}
            value={props.value}
            onChange={props.onChange}
            onDraftEdit={handleDraftChange}
            onSubmit={value => props.onSubmit(value ?? props.value)}
            disabled={disabled}
            requireText
            placeholder={t('issue_creation.record_placeholder', {
              defaultValue: props.placeholder,
            })}
            error={props.error}
            inputTestId="collaboration-home-issue-content"
            submitButtonTestId="collaboration-home-create-issue"
            submitLabel={t('issue_creation.record_submit')}
            showSubmitButton
            showAttachmentActions
            showProjectWorkBar={false}
            showWorkspaceMenu={false}
            showExecutionTools={false}
            toolbarLeadingContext={
              <div className="flex flex-wrap items-center gap-1">
                {projectControl}
                {(
                  [
                    { symbol: '@', Icon: AtSign, label: 'mention_member' },
                    { symbol: '#', Icon: Hash, label: 'reference_issue' },
                  ] as const
                ).map(({ symbol, Icon, label }) =>
                  symbol === '@' && props.ownerControl ? (
                    <span key={label}>{props.ownerControl}</span>
                  ) : (
                    <button
                      key={label}
                      type="button"
                      data-testid={`collaboration-issue-${label}`}
                      disabled={disabled}
                      title={t(`issue_creation.${label}`)}
                      aria-label={t(`issue_creation.${label}`)}
                      onClick={() => insert(symbol)}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary disabled:opacity-50 md:h-7 md:w-7"
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )
                )}
              </div>
            }
            externalMentionCandidates={props.members}
            mentionScope="external"
            projectChat={{
              scopeKey: 'collaboration-issue-home',
              models: [],
              skills: [],
              selectedModel: null,
              selectedModelOptions: {},
              isModelSelectionReady: true,
              selectedSkills: [],
              isOptionsLocked: false,
              attachments: props.attachments,
              uploadingFiles: new Map(),
              errors: new Map(),
              setSelectedModel: () => {},
              setSelectedModelOption: () => {},
              toggleSkill: () => {},
              handleFileSelect: async files => props.onFileSelect(files),
              removeAttachment: async id => props.onRemoveAttachment(id),
              listLocalSkills: async () => [],
            }}
          />
        </div>
      </div>
      {taskOpened && (
        <div
          id={`${composerId}-task-panel`}
          role="tabpanel"
          aria-labelledby={`${composerId}-task-tab`}
          className={taskMode ? '' : 'hidden'}
          inert={!taskMode}
        >
          {renderTaskComposer?.({
            ...props,
            active: taskMode,
            ref: setTaskInput,
            projectControl,
            onPendingChange: setTaskPending,
            onTaskCreated: (issue, task) => {
              props.onTaskCreated?.(issue, task)
            },
          })}
        </div>
      )}
      {anchor && (
        <AnchorPopover
          anchor={anchor}
          title={props.projectLabel}
          testId="collaboration-issue-project-picker"
          onClose={closePicker}
        >
          {props.projects.map(project => {
            const Icon = project.project_store === 'local' ? Laptop : Cloud
            return (
              <button
                key={project.id}
                type="button"
                data-testid={`collaboration-issue-project-${project.id}`}
                disabled={disabled}
                aria-pressed={project.id === props.projectId}
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-base text-text-primary hover:bg-muted keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-primary"
                onClick={() => {
                  props.onChange(getActiveInput()?.getValue() ?? props.value)
                  props.onSelectProject(project.id)
                  closePicker()
                }}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{project.name}</span>
                  <span className="block truncate text-xs text-text-muted">
                    {projectLocation(project)}
                  </span>
                </span>
                {project.id === props.projectId && (
                  <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                )}
              </button>
            )
          })}
        </AnchorPopover>
      )}
    </section>
  )
}
