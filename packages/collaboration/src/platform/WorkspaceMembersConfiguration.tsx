// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  clearMemberResultsForEmptyQuery,
  runActiveMemberSearch,
} from '../project-manage/memberSearch'
import type {
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
  CollaborationWorkspaceRole,
  CollaborationUser,
} from '../types'
import type { WorkspaceResourceCommands } from './WorkspaceResourceConfiguration'

type MemberRole = Exclude<CollaborationWorkspaceRole, 'Owner'>
const copy = {
  'zh-CN': {
    inviteMember: '邀请成员',
    searchUser: '搜索姓名或邮箱',
    searchHint: '输入姓名或邮箱，从已有用户中邀请成员。',
    noSearchResults: '没有找到可邀请的用户',
    role: '角色',
    remove: '移除',
    cancel: '取消',
    owner: '所有者',
    maintainer: '管理员',
    developer: '成员',
    viewer: '只读成员',
    reporter: '参与者',
    noMembers: '空间中还没有成员',
    memberHint: '项目默认继承空间成员；受限项目仅继承空间管理员。',
    operationFailed: '操作失败，请稍后重试',
  },
  en: {
    inviteMember: 'Invite member',
    searchUser: 'Search name or email',
    searchHint: 'Search existing users by name or email.',
    noSearchResults: 'No users available to invite',
    role: 'Role',
    remove: 'Remove',
    cancel: 'Cancel',
    owner: 'Owner',
    maintainer: 'Administrator',
    developer: 'Member',
    viewer: 'Viewer',
    reporter: 'Reporter',
    noMembers: 'No members in this workspace',
    memberHint:
      'Projects inherit space members. Restricted projects inherit only space administrators.',
    operationFailed: 'Operation failed. Please try again.',
  },
} as const

type ResourceCopy = (typeof copy)[keyof typeof copy]
function roleLabel(role: CollaborationWorkspaceRole, messages: ResourceCopy) {
  if (role === 'Owner') return messages.owner
  if (role === 'Maintainer') return messages.maintainer
  if (role === 'Developer') return messages.developer
  if (role === 'Viewer') return messages.viewer
  return messages.reporter
}

function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <div className="collaboration-alert" role="alert">
      {message}
    </div>
  ) : null
}

function MemberInviteDialog({
  members,
  messages,
  commands,
  onClose,
}: {
  members: CollaborationWorkspaceMember[]
  messages: ResourceCopy
  commands: WorkspaceResourceCommands
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CollaborationUser[]>([])
  const [role, setRole] = useState<MemberRole>('Developer')
  const [error, setError] = useState<string | null>(null)
  const [savingUserId, setSavingUserId] = useState<number | null>(null)
  const searchVersion = useRef(0)
  const existingUserIds = useMemo(() => new Set(members.map(member => member.user_id)), [members])

  useEffect(() => {
    const version = ++searchVersion.current
    if (clearMemberResultsForEmptyQuery(query, setResults)) return
    const timeout = window.setTimeout(() => {
      void runActiveMemberSearch({
        query,
        existingUserIds,
        search: async value => ({
          users: await commands.searchUsers(value),
        }),
        userId: user => user.id,
        isActive: () => searchVersion.current === version,
        onResults: setResults,
        onError: () => setError(messages.operationFailed),
      })
    }, 180)
    return () => window.clearTimeout(timeout)
  }, [commands, existingUserIds, messages.operationFailed, query])

  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-resource-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.inviteMember}
      >
        <h2>{messages.inviteMember}</h2>
        <p>{messages.searchHint}</p>
        <label>
          {messages.role}
          <select
            data-testid="collaboration-workspace-member-invite-role"
            value={role}
            onChange={event => setRole(event.target.value as MemberRole)}
          >
            <option value="Maintainer">{messages.maintainer}</option>
            <option value="Developer">{messages.developer}</option>
            <option value="Viewer">{messages.viewer}</option>
          </select>
        </label>
        <label>
          {messages.searchUser}
          <input
            autoFocus
            data-testid="collaboration-workspace-member-search"
            value={query}
            onChange={event => {
              setError(null)
              setQuery(event.target.value)
            }}
          />
        </label>
        <ErrorMessage message={error} />
        <div className="collaboration-resource-candidates">
          {query.trim() && !results.length ? <span>{messages.noSearchResults}</span> : null}
          {results.map(user => (
            <button
              type="button"
              data-testid={`collaboration-workspace-member-result-${user.id}`}
              disabled={savingUserId !== null}
              key={user.id}
              onClick={() => {
                setSavingUserId(user.id)
                setError(null)
                void commands
                  .addMember(user.id, role)
                  .then(onClose)
                  .catch(() => setError(messages.operationFailed))
                  .finally(() => setSavingUserId(null))
              }}
            >
              <span className="collaboration-resource-avatar">
                {user.user_name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{user.user_name}</strong>
                <small>{user.email ?? ''}</small>
              </span>
            </button>
          ))}
        </div>
        <footer>
          <button
            type="button"
            data-testid="collaboration-workspace-member-invite-cancel"
            onClick={onClose}
          >
            {messages.cancel}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function WorkspaceMembersConfiguration({
  workspace,
  members,
  locale,
  commands,
}: {
  workspace: CollaborationWorkspace
  members: CollaborationWorkspaceMember[]
  locale: 'zh-CN' | 'en'
  commands: WorkspaceResourceCommands
}) {
  const messages = copy[locale]
  const [dialogOpen, setDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingUserId, setPendingUserId] = useState<number | null>(null)
  const [transferUserId, setTransferUserId] = useState('')
  const canManage = workspace.access_role === 'Owner' || workspace.access_role === 'Maintainer'

  return (
    <>
      <section className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="heading-base text-text-primary">
                {locale === 'zh-CN' ? '空间成员' : 'Space members'}
              </h2>
              <span className="rounded-md bg-surface px-2 py-0.5 text-sm text-text-muted">
                {members.length}
              </span>
            </div>
            <p className="mt-1 text-sm text-text-muted">{messages.memberHint}</p>
          </div>
          {canManage ? (
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid="collaboration-workspace-member-invite"
              onClick={() => setDialogOpen(true)}
            >
              ＋ {messages.inviteMember}
            </button>
          ) : null}
        </div>
        <ErrorMessage message={error} />
        {workspace.access_role === 'Owner' &&
        Number.isFinite(workspace.owner_user_id) &&
        commands.transferOwnership ? (
          <form
            className="mb-6 flex flex-wrap items-center gap-3 rounded-lg bg-surface p-4 text-sm"
            onSubmit={event => {
              event.preventDefault()
              if (!transferUserId || pendingUserId !== null) return
              setPendingUserId(Number(transferUserId))
              setError(null)
              void commands.transferOwnership!(Number(transferUserId), workspace.version)
                .then(() => setTransferUserId(''))
                .catch(() => setError(messages.operationFailed))
                .finally(() => setPendingUserId(null))
            }}
          >
            <label className="flex flex-wrap items-center gap-3">
              {locale === 'zh-CN'
                ? '转交空间所有权（你将保留管理员权限）'
                : 'Transfer space ownership (you remain an administrator)'}
              <select
                className="min-h-11 rounded-md border border-border bg-base px-3 md:min-h-8"
                data-testid="collaboration-workspace-transfer-user"
                value={transferUserId}
                onChange={event => setTransferUserId(event.target.value)}
              >
                <option value="">
                  {locale === 'zh-CN' ? '选择新所有者' : 'Select the new owner'}
                </option>
                {members
                  .filter(member => member.role !== 'Owner')
                  .map(member => (
                    <option key={member.user_id} value={member.user_id}>
                      {member.user_name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md px-3 hover:bg-hover disabled:opacity-50 md:min-h-8"
              data-testid="collaboration-workspace-transfer-submit"
              disabled={!transferUserId || pendingUserId !== null}
            >
              {locale === 'zh-CN' ? '转交所有权' : 'Transfer ownership'}
            </button>
          </form>
        ) : null}
        {members.length ? (
          <div>
            <div className="hidden grid-cols-[minmax(0,1fr)_12rem_5rem] gap-4 border-b border-border px-2 py-3 text-sm text-text-muted md:grid">
              <span>{locale === 'zh-CN' ? '成员' : 'Member'}</span>
              <span>{messages.role}</span>
              <span />
            </div>
            {members.map(member => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-2 py-4 text-sm md:grid-cols-[minmax(0,1fr)_12rem_5rem] md:gap-4"
                key={member.user_id}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="collaboration-resource-avatar">
                    {member.user_name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <strong className="block truncate font-medium text-text-primary">
                      {member.user_name}
                    </strong>
                    <small className="block truncate text-sm text-text-muted">
                      {member.email ?? ''}
                    </small>
                  </span>
                </div>
                {canManage && member.role !== 'Owner' ? (
                  <>
                    <select
                      className="min-h-11 rounded-md border border-border bg-base px-3 md:min-h-8"
                      aria-label={`${member.user_name} ${messages.role}`}
                      data-testid={`collaboration-workspace-member-role-${member.user_id}`}
                      disabled={pendingUserId === member.user_id}
                      value={member.role}
                      onChange={event => {
                        setPendingUserId(member.user_id)
                        setError(null)
                        void commands
                          .updateMember(member.user_id, event.target.value as MemberRole)
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setPendingUserId(null))
                      }}
                    >
                      <option value="Maintainer">{messages.maintainer}</option>
                      <option value="Developer">{messages.developer}</option>
                      <option value="Viewer">{messages.viewer}</option>
                    </select>
                    <button
                      type="button"
                      className="col-start-2 min-h-11 justify-self-end rounded-md px-2 text-destructive hover:bg-hover md:col-start-auto md:min-h-8"
                      data-testid={`collaboration-workspace-member-remove-${member.user_id}`}
                      disabled={pendingUserId === member.user_id}
                      onClick={() => {
                        setPendingUserId(member.user_id)
                        setError(null)
                        void commands
                          .removeMember(member.user_id)
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setPendingUserId(null))
                      }}
                    >
                      {messages.remove}
                    </button>
                  </>
                ) : (
                  <span className="justify-self-start rounded-md bg-surface px-2 py-1 text-text-secondary">
                    {roleLabel(member.role, messages)}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="collaboration-resource-empty">{messages.noMembers}</div>
        )}
      </section>
      {dialogOpen ? (
        <MemberInviteDialog
          members={members}
          messages={messages}
          commands={commands}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  )
}
