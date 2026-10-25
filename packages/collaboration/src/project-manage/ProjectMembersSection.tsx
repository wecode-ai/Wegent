// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  ProjectManageHost,
  ProjectManageMember,
  ProjectManageProject,
  ProjectManageRole,
  ProjectManageUser,
} from './types'
import type { useProjectMembers } from './useProjectMembers'

const grid =
  'grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_2.25rem] md:gap-4'
const focus =
  'focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70 keyboard:focus-visible:ring-offset-2'
const roles = ['Maintainer', 'Developer', 'Viewer'] as const

function roleLabel(role: ProjectManageRole, host: ProjectManageHost) {
  const labels = {
    Owner: ['todo.permission_owner', '所有者'],
    Maintainer: ['todo.permission_admin', '管理员'],
    Developer: ['todo.permission_member', '成员'],
    Viewer: ['todo.permission_viewer', '只读成员'],
  } as const
  return host.translate(labels[role][0], labels[role][1])
}

function inheritedSource(
  member: ProjectManageMember,
  project: ProjectManageProject,
  host: ProjectManageHost
) {
  const workspace = project.workspace_context
  return workspace && workspace.id === member.inherited_from_workspace_id
    ? host.translate('todo.project_member_inherited_named', '继承自 {{space}}', {
        space: workspace.name,
      })
    : host.translate('todo.project_member_inherited_parent', '继承自父空间')
}

export function ProjectMembersSection<
  Member extends ProjectManageMember,
  User extends ProjectManageUser,
>({
  project,
  host,
  controller,
  canManage,
  membershipModeBusy,
  onMembershipModeChange,
  className,
}: {
  project: ProjectManageProject
  host: ProjectManageHost
  controller: ReturnType<typeof useProjectMembers<Member, User>>
  canManage: boolean
  membershipModeBusy: boolean
  onMembershipModeChange(mode: 'inherit' | 'restricted'): void
  className?: string
}) {
  const { LockKeyhole, Search, Trash2 } = host.icons
  const {
    members,
    loading,
    membersOpen,
    setMembersOpen,
    memberComposerRef,
    memberQuery,
    setMemberQuery,
    memberSearchInputRef,
    memberResults,
    memberRole,
    setMemberRole,
    savingUserId,
    addMember,
    removeMember,
    updateMember,
    updateMemberCapability,
  } = controller
  const busy = savingUserId !== null
  const inherited = members.some(member => member.inherited_role)
  const modeHint =
    project.membership_mode === 'restricted'
      ? host.translate(
          'todo.project_membership_restricted_hint',
          '仅空间管理员自动加入，其他成员需直接邀请。'
        )
      : host.translate(
          'todo.project_membership_inherit_hint',
          '空间成员自动获得项目访问权限，空间管理员始终可管理项目。'
        )

  return (
    <section className={className} data-testid="cloud-project-members-panel">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="heading-base text-text-primary">
                {host.translate('todo.project_members', '项目成员')}
              </h2>
              {!loading && (
                <span
                  className="rounded-md bg-muted px-2 py-0.5 text-xs text-text-secondary"
                  data-testid="cloud-project-member-count"
                >
                  {members.length}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-text-muted">
              {host.translate('todo.project_members_intro', '管理项目访问权限与成员职责。')}
            </p>
          </div>
          {canManage && (
            <div className="relative shrink-0" ref={memberComposerRef}>
              <button
                type="button"
                data-testid="cloud-project-members-toggle"
                aria-expanded={membersOpen}
                aria-controls="cloud-project-member-picker"
                onClick={() => setMembersOpen(open => !open)}
                className={`min-h-11 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition-colors hover:opacity-90 md:min-h-8 ${focus}`}
              >
                <span aria-hidden="true" className="mr-1">
                  ＋
                </span>
                {host.translate('todo.add_project_member', '添加成员')}
              </button>
              {membersOpen && (
                <div
                  id="cloud-project-member-picker"
                  role="dialog"
                  aria-label={host.translate('todo.add_project_member', '添加成员')}
                  data-testid="cloud-project-member-picker"
                  className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-background p-3 shadow-lg"
                >
                  <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 keyboard:focus-within:ring-2 keyboard:focus-within:ring-focus/70 md:min-h-9">
                    <Search className="h-4 w-4 shrink-0 text-text-muted" />
                    <input
                      ref={memberSearchInputRef}
                      data-testid="cloud-member-search"
                      value={memberQuery}
                      onChange={event => setMemberQuery(event.target.value)}
                      aria-label={host.translate(
                        'todo.member_search_placeholder',
                        '搜索用户名或邮箱'
                      )}
                      placeholder={host.translate(
                        'todo.member_search_placeholder',
                        '搜索用户名或邮箱'
                      )}
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                  </label>
                  <label className="mt-3 flex items-center justify-between gap-2 text-sm text-text-secondary">
                    <span>{host.translate('todo.member_role', '加入角色')}</span>
                    <select
                      data-testid="cloud-member-role"
                      value={memberRole}
                      onChange={event => setMemberRole(event.target.value as typeof memberRole)}
                      className={`min-h-11 rounded-md border border-border bg-background px-2 text-sm md:min-h-8 ${focus}`}
                    >
                      {roles.map(role => (
                        <option key={role} value={role}>
                          {roleLabel(role, host)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="mt-2 max-h-52 overflow-y-auto">
                    {memberResults.map(user => (
                      <button
                        key={user.id}
                        type="button"
                        data-testid={`cloud-member-result-${user.id}`}
                        disabled={busy}
                        onClick={() => void addMember(user)}
                        className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-muted disabled:opacity-40 ${focus}`}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm">{user.user_name}</span>
                        <span className="text-xs text-text-muted">
                          {savingUserId === user.id
                            ? host.translate('todo.adding', '添加中…')
                            : host.translate('common.add', '添加')}
                        </span>
                      </button>
                    ))}
                    {memberQuery.trim() && !memberResults.length && (
                      <p className="px-2 py-3 text-sm text-text-muted">
                        {host.translate('todo.no_search_members', '没有匹配的成员')}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </header>

        {project.membership_mode !== undefined && (
          <div className="mt-6 flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <label
                htmlFor="cloud-project-membership-mode"
                className="text-sm font-medium text-text-primary"
              >
                {host.translate('todo.project_membership_mode', '项目成员模式')}
              </label>
              <p
                className="mt-1 text-xs leading-relaxed text-text-muted"
                id="cloud-project-membership-hint"
                data-testid="cloud-project-membership-hint"
              >
                {modeHint}
              </p>
            </div>
            <select
              id="cloud-project-membership-mode"
              data-testid="cloud-project-membership-mode"
              value={project.membership_mode}
              disabled={membershipModeBusy || !canManage}
              aria-describedby="cloud-project-membership-hint"
              onChange={event =>
                onMembershipModeChange(event.target.value as 'inherit' | 'restricted')
              }
              className={`min-h-11 w-full shrink-0 rounded-md border border-border bg-background px-3 text-sm text-text-primary disabled:opacity-60 md:min-h-8 md:w-auto ${focus}`}
            >
              <option value="inherit">
                {host.translate('todo.project_membership_inherit', '继承空间成员')}
              </option>
              <option value="restricted">
                {host.translate('todo.project_membership_restricted_short', '仅邀请成员')}
              </option>
            </select>
          </div>
        )}

        <div
          className="mt-6"
          role="table"
          aria-label={host.translate('todo.project_members', '项目成员')}
          data-testid="cloud-project-members-table"
        >
          <div
            role="row"
            className={`${grid} hidden border-b border-border px-2 pb-2 text-xs text-text-muted md:grid`}
          >
            <span role="columnheader">{host.translate('todo.project_member', '成员')}</span>
            <span role="columnheader" data-testid="cloud-project-member-capability-heading">
              {host.translate('todo.project_member_capability', '职责与能力')}
            </span>
            <span role="columnheader">
              {host.translate('todo.project_member_access', '角色与来源')}
            </span>
            <span role="columnheader" className="sr-only">
              {host.translate('todo.project_member_actions', '成员操作')}
            </span>
          </div>
          <div role="rowgroup" className="divide-y divide-border/70">
            {members.map(member => {
              const inheritedOnly = Boolean(member.inherited_role && !member.direct_role)
              const roleReadOnly = member.role === 'Owner' || inheritedOnly || !canManage
              return (
                <div
                  key={member.user_id}
                  role="row"
                  data-testid={`cloud-project-member-${member.user_id}`}
                  className={`${grid} items-center px-2 py-4 transition-colors hover:bg-muted/20`}
                >
                  <div role="rowheader" className="flex min-w-0 items-center gap-3">
                    <span
                      aria-hidden="true"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-medium text-text-secondary"
                    >
                      {member.user_name.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <span className="block truncate text-sm font-medium text-text-primary">
                        {member.user_name}
                      </span>
                      {member.email && (
                        <span
                          className="mt-0.5 block truncate text-xs text-text-muted"
                          title={member.email}
                        >
                          {member.email}
                        </span>
                      )}
                    </div>
                  </div>
                  <div role="cell" className="min-w-0">
                    <label>
                      <span className="mb-1 block text-xs text-text-muted md:sr-only">
                        {host.translate('todo.project_member_capability', '职责与能力')}
                      </span>
                      <input
                        key={`${project.id}-${member.capability_description ?? ''}`}
                        data-testid={`cloud-project-member-capability-${member.user_id}`}
                        defaultValue={member.capability_description ?? ''}
                        disabled={busy || !canManage}
                        onBlur={event => void updateMemberCapability(member, event.target.value)}
                        className={`min-h-11 w-full rounded-md border border-transparent bg-transparent px-2 text-sm text-text-primary transition-colors placeholder:text-text-tertiary hover:border-border focus:border-border focus:bg-background disabled:cursor-default md:min-h-8 ${focus}`}
                        placeholder={host.translate(
                          'todo.project_member_capability_placeholder',
                          '例如：前端开发、产品验收'
                        )}
                        aria-label={host.translate(
                          'todo.project_member_capability_label',
                          '{{name}} 的职责与能力',
                          { name: member.user_name }
                        )}
                      />
                    </label>
                  </div>
                  <div role="cell" className="min-w-0 space-y-1">
                    {roleReadOnly || member.inherited_role ? (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-text-secondary"
                        data-testid={`cloud-project-member-effective-role-${member.user_id}`}
                      >
                        {inheritedOnly && <LockKeyhole className="h-3 w-3" />}
                        {roleLabel(member.role, host)}
                      </span>
                    ) : null}
                    {member.inherited_role && (
                      <p
                        className="truncate text-xs text-text-muted"
                        data-testid={`cloud-project-member-source-${member.user_id}`}
                        title={inheritedSource(member, project, host)}
                      >
                        {inheritedSource(member, project, host)}
                      </p>
                    )}
                    {!roleReadOnly && (
                      <label className="flex items-center gap-2">
                        {member.inherited_role && (
                          <span className="shrink-0 text-xs text-text-muted">
                            {host.translate('todo.project_member_direct', '直接邀请')}
                          </span>
                        )}
                        <select
                          data-testid={`cloud-project-member-role-${member.user_id}`}
                          value={member.direct_role ?? member.role}
                          disabled={busy}
                          onChange={event =>
                            void updateMember(
                              member,
                              event.target.value as Exclude<ProjectManageRole, 'Owner'>
                            )
                          }
                          className={`min-h-11 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-text-primary disabled:opacity-40 md:min-h-8 ${focus}`}
                          aria-label={host.translate(
                            'todo.project_member_role_label',
                            '{{name}} 的项目角色',
                            { name: member.user_name }
                          )}
                        >
                          {roles.map(role => (
                            <option key={role} value={role}>
                              {roleLabel(role, host)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {!member.inherited_role && (
                      <p
                        className="text-xs text-text-muted"
                        data-testid={`cloud-project-member-source-${member.user_id}`}
                      >
                        {member.role === 'Owner'
                          ? host.translate('todo.project_member_owner', '本地项目所有者')
                          : host.translate('todo.project_member_direct', '直接邀请')}
                      </p>
                    )}
                  </div>
                  <div role="cell" className="flex justify-end">
                    {!roleReadOnly &&
                      host.renderTooltip({
                        label: host.translate('todo.remove_member', '移除 {{name}}', {
                          name: member.user_name,
                        }),
                        align: 'end',
                        children: (
                          <button
                            type="button"
                            data-testid={`cloud-project-member-remove-${member.user_id}`}
                            disabled={busy}
                            onClick={() => void removeMember(member)}
                            className={`flex h-11 w-11 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-red-600 disabled:opacity-40 md:h-8 md:w-8 ${focus}`}
                            aria-label={host.translate('todo.remove_member', '移除 {{name}}', {
                              name: member.user_name,
                            })}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ),
                      })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        {loading && (
          <p
            role="status"
            className="py-8 text-center text-sm text-text-muted"
            data-testid="cloud-project-members-loading"
          >
            {host.translate('todo.project_members_loading', '正在加载成员…')}
          </p>
        )}
        {!loading && !members.length && (
          <p
            className="py-8 text-center text-sm text-text-muted"
            data-testid="cloud-project-members-empty"
          >
            {host.translate('todo.project_members_empty', '暂无项目成员')}
          </p>
        )}
        {!loading && members.length > 0 && (
          <footer className="mt-4 flex flex-col gap-1 text-xs leading-relaxed text-text-muted">
            {inherited && (
              <p data-testid="cloud-project-members-inheritance-note">
                {host.translate(
                  'todo.project_member_inherited_hint',
                  '继承角色由空间管理，项目内不能修改或移除。'
                )}
              </p>
            )}
            {canManage && (
              <p>
                {host.translate(
                  'todo.project_member_capability_hint',
                  '职责与能力在离开输入框后自动保存，帮助 AI 选择合适的负责人。'
                )}
              </p>
            )}
          </footer>
        )}
      </div>
    </section>
  )
}
