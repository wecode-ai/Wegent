import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import type { RefObject } from 'react'
import { ChevronDown, CircleUserRound, Flag, Folder, Paperclip, Tag, X } from 'lucide-react'
import type { CloudLoopItem, CloudProject, CloudProjectMember } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import type { IssueComposerDraft } from './issueComposerDraftSource'

export function IssueComposerFields({
  draft,
  projects,
  busy,
  selectBoard,
  statusOptions,
  selectedWorkItemProject,
  selectedAssigneeName,
  selectedProjectMembers,
  setField,
  tagDraft,
  setTagDraft,
  commitTagDraft,
  fileInputRef,
  stageFiles,
  attachmentCount,
}: {
  draft: IssueComposerDraft
  projects: CloudProject[]
  busy: boolean
  selectBoard(value: string): void
  statusOptions: Array<{ id: string; name: string }>
  selectedWorkItemProject: CloudProject | null
  selectedAssigneeName: string | null
  selectedProjectMembers: CloudProjectMember[]
  setField<K extends keyof IssueComposerDraft>(
    field: K,
    value: IssueComposerDraft[K] | ((current: IssueComposerDraft[K]) => IssueComposerDraft[K])
  ): void
  tagDraft: string
  setTagDraft(value: string): void
  commitTagDraft(): void
  fileInputRef: RefObject<HTMLInputElement | null>
  stageFiles(files: File | File[]): void
  attachmentCount: number
}) {
  const { t } = useTranslation()
  const { boardKey, status, priority, tags, assigneeUserId } = draft
  const projectOptions = [
    ...(!projects.some(project => project.project_store + ':' + project.id === boardKey) && boardKey
      ? [
          {
            value: boardKey,
            label:
              selectedWorkItemProject?.name ?? t('workbench.default_work_item_board', '我的任务'),
          },
        ]
      : []),
    ...projects.map(project => ({
      value: project.project_store + ':' + project.id,
      label: project.name,
    })),
  ]
  const priorityOptions = [
    { value: 'none', label: t('todo.priority_none', '无优先级') },
    { value: 'low', label: t('todo.priority_low', '低') },
    { value: 'medium', label: t('todo.priority_medium', '普通') },
    { value: 'high', label: t('todo.priority_high', '高') },
    { value: 'urgent', label: t('todo.priority_urgent', '紧急') },
  ] as const
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <SelectField
        testId="workspace-issue-project"
        accessibleLabel={t('todo.issue_project_label', '项目空间')}
        value={boardKey}
        options={projectOptions}
        onChange={selectBoard}
        disabled={busy || projects.length === 0}
        triggerContent={
          <span className="flex min-w-0 items-center gap-2">
            <Folder className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="truncate">
              {selectedWorkItemProject?.name ?? t('workbench.default_work_item_board', '我的任务')}
            </span>
          </span>
        }
        className="max-w-48"
      />
      <SelectField
        testId="workspace-issue-status"
        accessibleLabel={t('todo.status', '状态')}
        value={status}
        options={statusOptions.map(option => ({
          value: option.id,
          label: option.name,
        }))}
        disabled={busy}
        onChange={value => setField('status', value as CloudLoopItem['status'])}
        triggerContent={
          <span className="flex min-w-0 items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full bg-text-muted" />
            <span className="truncate">
              {statusOptions.find(option => option.id === status)?.name ?? status}
            </span>
          </span>
        }
      />
      <SelectField<CloudLoopItem['priority']>
        testId="workspace-issue-priority"
        accessibleLabel={t('todo.priority', '优先级')}
        value={priority}
        options={priorityOptions}
        disabled={busy}
        onChange={value => setField('priority', value)}
        triggerContent={
          <span className="flex min-w-0 items-center gap-2">
            <Flag className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="truncate">
              {priorityOptions.find(option => option.value === priority)?.label}
            </span>
          </span>
        }
      />
      <SearchableSelect
        testId="workspace-issue-assignee"
        searchPlaceholder={t('todo.search_assignee')}
        emptyLabel={t('todo.no_matching_assignee')}
        accessibleLabel={t('todo.assignee', '负责人')}
        value={String(assigneeUserId ?? '')}
        options={[
          { value: '', label: t('todo.unassigned', '未指派') },
          ...selectedProjectMembers.map(member => ({
            value: String(member.user_id),
            label: member.user_name,
          })),
        ]}
        disabled={busy || selectedProjectMembers.length === 0}
        onChange={value => setField('assigneeUserId', Number(value) || null)}
        triggerContent={
          <>
            <span className="flex min-w-0 items-center gap-2">
              <CircleUserRound
                className="h-4 w-4 shrink-0 text-text-secondary"
                aria-hidden="true"
              />
              <span className="max-w-32 truncate">
                {selectedAssigneeName ?? t('todo.unassigned', '未指派')}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          </>
        }
      />
      {tags.map(tag => (
        <span
          key={tag}
          data-testid={`workspace-issue-tag-${tag}`}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-sm font-normal text-text-primary"
        >
          # {tag}
          <ControlButton
            variant="unstyled"
            type="button"
            aria-label={t('todo.remove_tag', '移除标签 {{tag}}', { tag })}
            onClick={() =>
              setField('tags', current => current.filter(candidate => candidate !== tag))
            }
            className="flex h-4 w-4 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
          >
            <X className="h-3 w-3" />
          </ControlButton>
        </span>
      ))}
      <label className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-sm font-normal text-text-secondary focus-within:bg-muted">
        <Tag className="h-3.5 w-3.5 text-text-muted" />
        <ControlInput
          data-testid="workspace-issue-tag-input"
          value={tagDraft}
          disabled={busy}
          onChange={event => setTagDraft(event.target.value)}
          onBlur={commitTagDraft}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ',') return
            event.preventDefault()
            commitTagDraft()
          }}
          placeholder={t('todo.add_tag', '添加标签')}
          className="w-20 bg-transparent outline-none placeholder:text-text-muted"
        />
      </label>
      <input
        ref={fileInputRef}
        data-testid="workspace-issue-file-input"
        type="file"
        multiple
        className="hidden"
        onChange={event => {
          if (event.target.files) stageFiles(Array.from(event.target.files))
          event.target.value = ''
        }}
      />
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="workspace-issue-attach"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-transparent px-3 text-sm font-normal text-text-secondary transition hover:border-border hover:bg-muted hover:text-text-primary disabled:opacity-50"
      >
        <Paperclip className="h-4 w-4" />
        {attachmentCount > 0
          ? t('todo.issue_attachment_count', '{{count}} 个附件', {
              count: attachmentCount,
            })
          : t('todo.add_attachment', '添加附件')}
      </ControlButton>
    </div>
  )
}
