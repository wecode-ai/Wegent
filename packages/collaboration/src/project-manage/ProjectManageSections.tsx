import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { isImeComposingEvent } from '@wegent/chat-core/ime'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { isTagNameTooLong } from '../tagging'
import type {
  ProjectManageExtensionContext,
  ProjectManageHost,
  ProjectManageProject,
} from './types'

export function ProjectTagsSection({
  host,
  className,
  allTags,
  renamingTag,
  renameValue,
  tagComposerOpen,
  newTag,
  tagBusy,
  setTagComposerOpen,
  setNewTag,
  setRenamingTag,
  setRenameValue,
  createTag,
  renameTag,
  deleteTag,
}: {
  host: ProjectManageHost
  className: string
  allTags: string[]
  renamingTag: string | null
  renameValue: string
  tagComposerOpen: boolean
  newTag: string
  tagBusy: boolean
  setTagComposerOpen: Dispatch<SetStateAction<boolean>>
  setNewTag(value: string): void
  setRenamingTag(value: string | null): void
  setRenameValue(value: string): void
  createTag(): Promise<void>
  renameTag(tag: string): Promise<void>
  deleteTag(tag: string): Promise<void>
}) {
  const { Check, Pencil, Trash2, X } = host.icons
  const tooLong = isTagNameTooLong(newTag)
  const renameTooLong = isTagNameTooLong(renameValue)
  return (
    <section className={className}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="mt-1 text-sm text-text-secondary">
            {host.translate('todo.project_tags_description', '用于区分任务类型并筛选看板。')}
          </p>
        </div>
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="cloud-project-tag-create-toggle"
          aria-expanded={tagComposerOpen}
          onClick={() => setTagComposerOpen(open => !open)}
          className="h-8 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted"
        >
          ＋ {host.translate('todo.create_tag', '新建标签')}
        </ControlButton>
      </div>
      {tagComposerOpen && (
        <div className="mt-3 flex gap-2">
          <label className="min-w-0 flex-1 space-y-1 text-sm text-text-secondary">
            <span>{host.translate('todo.tag_name', '标签名称')}</span>
            <ControlInput
              data-testid="cloud-project-tag-create-input"
              autoFocus
              value={newTag}
              aria-invalid={tooLong}
              onChange={event => setNewTag(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !isImeComposingEvent(event)) void createTag()
              }}
              placeholder={host.translate('todo.tag_name_placeholder', '输入标签名称')}
              className="h-9 w-full"
            />
          </label>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid="cloud-project-tag-create-confirm"
            disabled={!newTag.trim() || tooLong || tagBusy}
            onClick={() => void createTag()}
            className="h-9 self-end rounded-lg bg-text-primary px-3.5 text-sm text-background outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70 disabled:bg-text-primary disabled:text-background disabled:opacity-40"
          >
            {host.translate('todo.create_tag', '新建标签')}
          </ControlButton>
        </div>
      )}
      {tagComposerOpen && tooLong && (
        <p role="alert" className="mt-1 text-xs text-error">
          {host.translate('todo.tag_name_too_long', '标签名称不能超过 32 个字符')}
        </p>
      )}
      {renamingTag && renameTooLong && (
        <p role="alert" className="mt-1 text-xs text-error">
          {host.translate('todo.tag_name_too_long', '标签名称不能超过 32 个字符')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {allTags.map(tag =>
          renamingTag === tag ? (
            <span
              key={tag}
              className="flex min-h-11 items-center gap-1 rounded-lg bg-muted px-1.5 md:min-h-8"
            >
              <ControlInput
                data-testid={`cloud-project-tag-rename-input-${tag}`}
                density="compact"
                appearance="plain"
                autoFocus
                value={renameValue}
                aria-label={host.translate('todo.tag_name', '标签名称')}
                aria-invalid={renameTooLong}
                onChange={event => setRenameValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !isImeComposingEvent(event)) void renameTag(tag)
                }}
                className="w-28"
              />
              {host.renderTooltip({
                label: host.translate('todo.confirm_rename', '确认重命名'),
                children: (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`cloud-project-tag-rename-confirm-${tag}`}
                    disabled={renameTooLong || !renameValue.trim() || tagBusy}
                    onClick={() => void renameTag(tag)}
                    aria-label={host.translate('todo.confirm_rename', '确认重命名')}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </ControlButton>
                ),
              })}
              {host.renderTooltip({
                label: host.translate('todo.cancel_rename', '取消重命名'),
                children: (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`cloud-project-tag-rename-cancel-${tag}`}
                    onClick={() => setRenamingTag(null)}
                    aria-label={host.translate('todo.cancel_rename', '取消重命名')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </ControlButton>
                ),
              })}
            </span>
          ) : (
            <span
              key={tag}
              data-testid={`cloud-project-tag-${tag}`}
              className="group/tag relative flex h-8 items-center rounded-lg bg-muted px-2.5 text-sm text-text-secondary"
            >
              <span className="transition-opacity group-hover/tag:opacity-0">{tag}</span>
              <span className="absolute inset-0 opacity-0 transition-opacity group-hover/tag:opacity-100 focus-within:opacity-100">
                {host.renderActionMenu({
                  ariaLabel: host.translate('todo.tag_menu', '{{tag}} 标签菜单', { tag }),
                  testId: `cloud-project-tag-menu-${tag}`,
                  placement: 'bottom-end',
                  triggerClassName:
                    'flex w-full items-center justify-center rounded-lg text-text-muted hover:text-text-primary',
                  items: [
                    {
                      label: host.translate('todo.rename', '重命名'),
                      icon: Pencil,
                      onSelect: () => {
                        setRenamingTag(tag)
                        setRenameValue(tag)
                      },
                      testId: `cloud-project-tag-rename-${tag}`,
                      disabled: tagBusy,
                    },
                    {
                      label: host.translate('todo.delete_tag', '删除标签'),
                      icon: Trash2,
                      onSelect: () => deleteTag(tag),
                      testId: `cloud-project-tag-delete-${tag}`,
                      disabled: tagBusy,
                      danger: true,
                    },
                  ],
                })}
              </span>
            </span>
          )
        )}
      </div>
    </section>
  )
}

export function ProjectProviderSection<Project extends ProjectManageProject>({
  className,
  render,
  updateProject,
  reportError,
}: {
  className: string
  render?(context: ProjectManageExtensionContext<Project>): ReactNode
  updateProject: ProjectManageExtensionContext<Project>['updateProject']
  reportError: ProjectManageExtensionContext<Project>['reportError']
}) {
  return <div className={className}>{render?.({ updateProject, reportError })}</div>
}
