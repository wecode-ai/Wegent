import { useImperativeHandle, useRef, useState } from 'react'
import {
  Link2,
  ChevronDown,
  ChevronRight,
  Laptop,
  Cloud,
  Check,
  FileText,
  MessageSquare,
  AtSign,
  Hash,
} from 'lucide-react'
import type { ComposerInputHandle } from '@wegent/collaboration/composer'
import { useTranslation } from '@/hooks/useTranslation'
import { BufferedChatInput } from '@/components/layout/BufferedChatInput'
import { AnchorPopover } from './AnchorPopover'
import type { IssueHomeTaskComposerProps } from '@wegent/collaboration/platform'

/** The Tasks-tab input with Issue persistence supplied by the collaboration host. */
export function WeworkIssueHomeComposer({ ref, ...props }: IssueHomeTaskComposerProps) {
  const { t } = useTranslation('common')
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const input = useRef<ComposerInputHandle>(null)
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
      return input.current?.element ?? null
    },
    focus: () => input.current?.focus(),
    getValue: () => input.current?.getValue() ?? props.value,
    setValue: (value, offset) => input.current?.setValue(value, offset),
    insertReference: reference => input.current?.insertReference(reference),
  }))
  const guides = [
    { id: 'human', Icon: FileText },
    { id: 'outcome', Icon: MessageSquare },
    { id: 'context', Icon: Link2 },
  ]
  const insert = (text: string) => {
    if (props.disabled) return
    input.current?.insertReference(text)
    input.current?.focus()
  }
  const closePicker = () => {
    anchor?.focus()
    setAnchor(null)
  }
  return (
    <section
      data-testid="collaboration-issue-workspace"
      className="flex min-h-0 w-full flex-col overflow-y-auto px-5 py-8 md:px-10"
    >
      <div aria-hidden="true" className="min-h-0 flex-[2]" />
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-6">
        <header className="space-y-3 text-center">
          <h1 className="text-3xl font-medium tracking-tight text-text-primary">
            {t('issue_creation.headline')}
          </h1>
          <p className="text-lg text-text-secondary">{t('issue_creation.subtitle')}</p>
        </header>
        <div
          id="collaboration-issue-guidance"
          className="flex flex-wrap justify-center gap-x-6 gap-y-2"
        >
          {guides.map(({ id, Icon }) => (
            <button
              key={id}
              type="button"
              data-testid={`collaboration-issue-guide-${id}`}
              disabled={props.disabled}
              onClick={() => insert(t(`issue_creation.${id}_prompt`))}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-lg text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
              {t(`issue_creation.${id}_title`)}
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          ))}
        </div>
        {props.environmentNotice}
        <div>
          <BufferedChatInput
            projectWorkBar={
              <div
                data-testid="collaboration-issue-project-bar"
                className="flex min-h-12 items-center gap-2 rounded-t-2xl bg-surface/60 px-3 py-2"
              >
                <button
                  type="button"
                  data-testid="collaboration-issue-project-trigger"
                  disabled={props.disabled}
                  aria-expanded={Boolean(anchor)}
                  aria-haspopup="dialog"
                  aria-label={
                    selectedProject
                      ? `${props.projectLabel}: ${selectedProject.name} · ${projectLocation(selectedProject)}`
                      : props.projectLabel
                  }
                  onClick={event => setAnchor(event.currentTarget)}
                  className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-md bg-surface px-2 text-sm text-text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary md:min-h-7"
                >
                  <ProjectIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                  <span className="truncate">{selectedProject?.name}</span>
                  {selectedProject && (
                    <span className="truncate text-xs text-text-muted">
                      {projectLocation(selectedProject)}
                    </span>
                  )}
                  <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                </button>
              </div>
            }
            inputRef={input}
            autoFocus
            variant="desktop"
            presentation="document"
            value={props.value}
            onChange={props.onChange}
            onDraftEdit={props.onDraftChange}
            onSubmit={value => props.onSubmit(value ?? props.value)}
            disabled={props.disabled}
            requireText
            placeholder={props.placeholder}
            error={props.error}
            inputTestId="collaboration-home-issue-content"
            submitButtonTestId="collaboration-home-create-issue"
            submitLabel={t('issue_creation.submit')}
            showProjectWorkBar={false}
            showWorkspaceMenu={false}
            showExecutionTools={false}
            toolbarLeadingContext={
              <div className="flex items-center gap-1">
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
                      disabled={props.disabled}
                      title={t(`issue_creation.${label}`)}
                      aria-label={t(`issue_creation.${label}`)}
                      onClick={() => insert(symbol)}
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 md:h-7 md:w-7"
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
      <div aria-hidden="true" className="min-h-0 flex-[3]" />
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
                disabled={props.disabled}
                aria-pressed={project.id === props.projectId}
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-base text-text-primary hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => {
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
