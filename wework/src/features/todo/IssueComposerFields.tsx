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
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
        <Folder className="h-4 w-4 shrink-0 text-text-muted" />
        <span className="max-w-48 truncate font-medium text-text-primary">
          {selectedWorkItemProject?.name ?? t('workbench.default_work_item_board', '我的任务')}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
        <select
          data-testid="workspace-issue-project"
          aria-label={t('todo.issue_project_label', '项目空间')}
          value={boardKey}
          disabled={busy || projects.length === 0}
          onChange={event => selectBoard(event.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        >
          {!projects.some(
            project => `${project.project_store}:${String(project.id)}` === boardKey
          ) && boardKey ? (
            <option value={boardKey}>
              {selectedWorkItemProject?.name ?? t('workbench.default_work_item_board', '我的任务')}
            </option>
          ) : null}
          {projects.map(project => (
            <option
              key={`${project.project_store}:${String(project.id)}`}
              value={`${project.project_store}:${String(project.id)}`}
            >
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
        <span className="h-2 w-2 rounded-full bg-text-muted wework:bg-zinc-400" />
        <span className="font-medium text-text-primary">
          {statusOptions.find(option => option.id === status)?.name ?? status}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
        <select
          data-testid="workspace-issue-status"
          aria-label={t('todo.status', '状态')}
          value={status}
          disabled={busy}
          onChange={event => setField('status', event.target.value as CloudLoopItem['status'])}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          {statusOptions.map(option => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
        <Flag className="h-3.5 w-3.5 text-text-muted" />
        <span className="font-medium text-text-primary">
          {priority === 'none'
            ? t('todo.priority_none', '无优先级')
            : priority === 'low'
              ? t('todo.priority_low', '低')
              : priority === 'medium'
                ? t('todo.priority_medium', '普通')
                : priority === 'high'
                  ? t('todo.priority_high', '高')
                  : t('todo.priority_urgent', '紧急')}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
        <select
          data-testid="workspace-issue-priority"
          aria-label={t('todo.priority', '优先级')}
          value={priority}
          disabled={busy}
          onChange={event => setField('priority', event.target.value as CloudLoopItem['priority'])}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        >
          <option value="none">{t('todo.priority_none', '无优先级')}</option>
          <option value="low">{t('todo.priority_low', '低')}</option>
          <option value="medium">{t('todo.priority_medium', '普通')}</option>
          <option value="high">{t('todo.priority_high', '高')}</option>
          <option value="urgent">{t('todo.priority_urgent', '紧急')}</option>
        </select>
      </label>
      <label className="relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-sm font-normal text-text-secondary transition hover:bg-muted hover:text-text-primary">
        <CircleUserRound className="h-3.5 w-3.5 text-text-muted" />
        <span className="max-w-32 truncate font-medium text-text-primary">
          {selectedAssigneeName ?? t('todo.unassigned', '未指派')}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
        <select
          data-testid="workspace-issue-assignee"
          aria-label={t('todo.assignee', '负责人')}
          value={assigneeUserId ?? ''}
          disabled={busy || selectedProjectMembers.length === 0}
          onChange={event => setField('assigneeUserId', Number(event.target.value) || null)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        >
          <option value="">{t('todo.unassigned', '未指派')}</option>
          {selectedProjectMembers.map(member => (
            <option key={member.user_id} value={member.user_id}>
              {member.user_name}
            </option>
          ))}
        </select>
      </label>
      {tags.map(tag => (
        <span
          key={tag}
          data-testid={`workspace-issue-tag-${tag}`}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-sm font-normal text-text-primary"
        >
          # {tag}
          <button
            type="button"
            aria-label={t('todo.remove_tag', '移除标签 {{tag}}', { tag })}
            onClick={() =>
              setField('tags', current => current.filter(candidate => candidate !== tag))
            }
            className="flex h-4 w-4 items-center justify-center rounded-full text-text-muted hover:bg-muted hover:text-text-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <label className="inline-flex h-8 items-center gap-1.5 rounded-full px-2 text-sm font-normal text-text-secondary focus-within:bg-muted">
        <Tag className="h-3.5 w-3.5 text-text-muted" />
        <input
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
      <button
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
      </button>
    </div>
  )
}
