import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { useTranslation } from '@/hooks/useTranslation'
import {
  ComposerProjectSelector,
  PROJECT_CHAT_WORK_BAR_CLASS,
  type ComposerInputHandle,
} from '@wegent/collaboration/composer'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { IssueHomeModeTabs, type IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'
import { AtSign, Cloud, Hash, Laptop } from 'lucide-react'
import { useId, useImperativeHandle, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'

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
  const handleDraftChange = (draft: string) => {
    flushSync(() => props.onDraftChange?.(draft))
  }
  const projectControl = (
    <div
      data-testid="collaboration-issue-project-bar"
      className="flex min-w-0 max-w-full items-center"
    >
      <ComposerProjectSelector
        value={props.projectId}
        disabled={disabled}
        label={t('personalHome.collaborationProject')}
        testId="collaboration-issue-project-trigger"
        menuTestId="collaboration-issue-project-picker"
        icon={<ProjectIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />}
        options={props.projects.map(project => ({
          value: project.id,
          label: project.name,
          description: projectLocation(project),
          icon:
            project.project_store === 'local' ? (
              <Laptop aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            ) : (
              <Cloud aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            ),
          testId: 'collaboration-issue-project-' + project.id,
        }))}
        onChange={id => {
          props.onChange(getActiveInput()?.getValue() ?? props.value)
          props.onSelectProject(id)
        }}
      />
    </div>
  )
  return (
    <section
      data-testid="collaboration-issue-workspace"
      className="flex min-h-0 min-w-0 w-full max-w-full flex-col gap-3"
    >
      <div className="flex w-full min-w-0 flex-col gap-3">
        <IssueHomeModeTabs
          id={composerId}
          taskMode={taskMode}
          taskAvailable={Boolean(renderTaskComposer)}
          disabled={disabled}
          translate={t}
          onChange={mode => {
            if (taskMode === mode) return
            props.onChange(getActiveInput()?.getValue() ?? props.value)
            if (mode) setTaskOpened(true)
            setTaskMode(mode)
          }}
        />
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
            projectWorkBar={
              <div
                className={
                  'flex w-full min-w-0 flex-wrap items-center gap-2 ' + PROJECT_CHAT_WORK_BAR_CLASS
                }
              >
                {projectControl}
              </div>
            }
            toolbarLeadingContext={
              <>
                {(
                  [
                    { symbol: '@', Icon: AtSign, label: 'mention_member' },
                    { symbol: '#', Icon: Hash, label: 'reference_issue' },
                  ] as const
                ).map(({ symbol, Icon, label }) =>
                  symbol === '@' && props.ownerControl ? (
                    <span key={label}>{props.ownerControl}</span>
                  ) : (
                    <ControlButton
                      variant="unstyled"
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
                    </ControlButton>
                  )
                )}
              </>
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
    </section>
  )
}
