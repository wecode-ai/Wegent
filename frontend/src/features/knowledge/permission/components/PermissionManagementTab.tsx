// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState, useRef } from 'react'
import { Check, X, UserPlus, Pencil, Trash2, User, Users } from 'lucide-react'

import { getPermissionTabs, subscribePermissionTabs } from '../permission-tab-registry'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import {
  PermissionManagementScope,
  usePermissionManagementController,
  type PermissionManagementProps,
} from './permission-management-controller'
import { PermissionRequests } from './PermissionRequests'
import { KnowledgeGrantForm } from './KnowledgeGrantForm'
import { Input } from '@/components/ui/input'
import { KnowledgeGrantDialog } from './KnowledgeGrantDialog'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole, PermissionUserInfo, ApprovedPermissionsByRole } from '@/types/knowledge'

/**
 * Build role-grouped members by applying a filter to each role list.
 */
function buildRoleGroups(
  approved: ApprovedPermissionsByRole,
  filter: (user: PermissionUserInfo) => boolean
): ApprovedPermissionsByRole {
  return {
    Owner: approved.Owner.filter(filter),
    Maintainer: approved.Maintainer.filter(filter),
    Developer: approved.Developer.filter(filter),
    Reporter: approved.Reporter.filter(filter),
    RestrictedAnalyst: approved.RestrictedAnalyst.filter(filter),
  }
}

interface PermissionManagementTabProps extends PermissionManagementProps {
  /**
   * Extension tabs rendered alongside standard tabs (Personal/Groups).
   * Used by internal deployments to add entity-type permission panels.
   */
  extensionTabs?: Array<{
    label: string
    icon?: React.ReactNode
    render: (props: { kbId: number }) => React.ReactNode
  }>
}

export function PermissionManagementTab(props: PermissionManagementTabProps) {
  return (
    <PermissionManagementScope {...props}>
      {session => <PermissionManagementSession {...props} {...session} />}
    </PermissionManagementScope>
  )
}

function PermissionManagementSession({
  kbId,
  kbNamespace,
  refreshKey,
  extensionTabs,
  onChanged,
  onAccessDenied,
  isCurrentUi,
}: PermissionManagementTabProps & { isCurrentUi: () => boolean }) {
  const { t } = useTranslation('knowledge')

  // Safe translation helper that falls back when key is not found
  const loc = (key: string, fallback: string) => {
    const v = t(key)
    return v && v !== key ? v : fallback
  }

  const [showAdd, setShowAdd] = useState(false)
  const [search, setSearch] = useState('')
  const addTrigger = useRef<HTMLButtonElement>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingRole, setEditingRole] = useState<MemberRole>('Reporter')
  const [activeTab, setActiveTab] = useState<string>('user')
  const {
    permissions,
    loading,
    error,
    fetchPermissions,
    reviewPermission,
    updatePermission,
    deletePermission,
    clearError,
    approvalRoles,
    setApprovalRole,
    membersChanged: handleExternalChanged,
  } = usePermissionManagementController({
    kbId,
    kbNamespace,
    refreshKey,
    onChanged,
    onAccessDenied,
    isCurrentUi,
  })

  // Load optional KB extensions (e.g., org_department in internal builds)
  useEffect(() => {
    import('../../document/extension-loader').then(({ loadKBExtensions }) => {
      loadKBExtensions().catch((err: unknown) => {
        console.warn('Failed to load KB extensions:', err)
      })
    })
  }, [])

  const handleUpdateRole = async (permissionId: number, role: MemberRole) => {
    try {
      await updatePermission(permissionId, role)
      if (isCurrentUi()) setEditingId(null)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const handleDelete = async (permissionId: number) => {
    if (!confirm(t('document.permission.confirmRemove'))) return
    try {
      await deletePermission(permissionId)
    } catch (_err) {
      // Error is handled by the hook
    }
  }

  const startEditing = (permission: PermissionUserInfo) => {
    setEditingId(permission.id)
    setEditingRole(permission.role || 'Reporter')
  }

  const cancelEditing = () => {
    setEditingId(null)
  }

  // Track registered external permission tabs (must be before any early return)
  const [externalTabs, setExternalTabs] = useState(getPermissionTabs)
  useEffect(() => {
    return subscribePermissionTabs(() => setExternalTabs(getPermissionTabs()))
  }, [])

  if (!permissions) {
    return (
      <div className="p-4" role={error ? 'alert' : 'status'}>
        {error ? (
          <>
            <p>{t('document.navigation.membersFailed')}</p>
            <Button
              variant="outline"
              className="min-h-11 min-w-11"
              data-testid="retry-knowledge-members"
              onClick={() => void fetchPermissions()}
            >
              {t('document.navigation.retry')}
            </Button>
          </>
        ) : (
          <Spinner />
        )}
      </div>
    )
  }

  // Separate namespace members from user members
  const query = search.trim().toLocaleLowerCase()
  const matches = (member: PermissionUserInfo) =>
    [member.display_name, member.email].some(value => value?.toLocaleLowerCase().includes(query))
  const allApproved = buildRoleGroups(permissions.approved, matches)

  // Filter namespace members into role groups for group display — must be before namespaceGroupCount
  const filterNamespaceIn = (users: PermissionUserInfo[]) =>
    users.filter(u => u.entity_type === 'namespace')
  const namespaceRoleGroups = allApproved
    ? {
        Owner: filterNamespaceIn(allApproved.Owner),
        Maintainer: filterNamespaceIn(allApproved.Maintainer),
        Developer: filterNamespaceIn(allApproved.Developer),
        Reporter: filterNamespaceIn(allApproved.Reporter),
        RestrictedAnalyst: filterNamespaceIn(allApproved.RestrictedAnalyst),
      }
    : null

  const namespaceGroupCount = namespaceRoleGroups
    ? Object.values(namespaceRoleGroups).reduce((sum, arr) => sum + arr.length, 0)
    : 0

  // Filter namespace members out of role groups for user display
  const filterNamespaceOut = (users: PermissionUserInfo[]) =>
    users.filter(u => !u.entity_type || u.entity_type === 'user')
  const userRoleGroups = allApproved
    ? {
        Owner: filterNamespaceOut(allApproved.Owner),
        Maintainer: filterNamespaceOut(allApproved.Maintainer),
        Developer: filterNamespaceOut(allApproved.Developer),
        Reporter: filterNamespaceOut(allApproved.Reporter),
        RestrictedAnalyst: filterNamespaceOut(allApproved.RestrictedAnalyst),
      }
    : null

  const approvedCount =
    (userRoleGroups?.Owner?.length || 0) +
    (userRoleGroups?.Maintainer?.length || 0) +
    (userRoleGroups?.Developer?.length || 0) +
    (userRoleGroups?.Reporter?.length || 0) +
    (userRoleGroups?.RestrictedAnalyst?.length || 0)

  // Compute role groups for registered external permission tabs
  const externalRoleGroups: Record<string, ReturnType<typeof buildRoleGroups>> = {}
  if (allApproved) {
    for (const tab of externalTabs) {
      externalRoleGroups[tab.type] = buildRoleGroups(allApproved, tab.filter)
    }
  }

  const visibleGroups =
    activeTab === 'user'
      ? userRoleGroups
      : activeTab === 'namespace'
        ? namespaceRoleGroups
        : externalRoleGroups[activeTab.replace('ext-reg-', '')]
  const matchedCount = visibleGroups
    ? Object.values(visibleGroups).reduce((sum, members) => sum + members.length, 0)
    : 0

  return (
    <div className="min-w-0 space-y-6 p-4 max-md:px-0">
      {/* Error Message */}
      {error && (
        <div className="bg-error/10 text-error px-4 py-2 rounded-lg text-sm flex justify-between items-center">
          <span>{error}</span>
          <Button
            variant="outline"
            className="min-h-11 min-w-11"
            data-testid="retry-knowledge-members"
            onClick={() => void fetchPermissions()}
          >
            {t('document.navigation.retry')}
          </Button>
          <button
            type="button"
            onClick={clearError}
            className="min-h-11 min-w-11 flex items-center justify-center text-error/70 hover:text-error"
            data-testid="permission-dismiss-error"
            aria-label={t('document.navigation.dismissError')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={t('document.permission.searchMembers')}
          aria-label={t('document.permission.searchMembers')}
          data-testid="knowledge-member-search"
          className="min-h-11 min-w-0 flex-1 basis-40"
        />
        <Button
          ref={addTrigger}
          variant="primary"
          className="min-h-11 min-w-11"
          data-testid="permission-add-collaborator"
          onClick={() => setShowAdd(true)}
        >
          <UserPlus className="mr-2 h-4 w-4" />
          {t('document.permission.addCollaborator')}
        </Button>
      </div>
      <p role="status" data-testid="knowledge-member-count" className="text-sm text-text-muted">
        {t('document.permission.matchingMembers', { count: matchedCount })}
      </p>

      {/* Tabs */}
      <div className="flex overflow-x-auto border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('user')}
          className={`flex min-h-11 min-w-11 shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'user'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
          data-testid="perm-tab-user"
        >
          <User className="w-4 h-4" />
          {loc('document.permission.individual', '个人')}
          {approvedCount > 0 && (
            <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
              {approvedCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('namespace')}
          className={`flex min-h-11 min-w-11 shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'namespace'
              ? 'border-primary text-primary'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
          data-testid="perm-tab-namespace"
        >
          <Users className="w-4 h-4" />
          {loc('document.permission.namespace', '群组')}
          {namespaceGroupCount > 0 && (
            <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
              {namespaceGroupCount}
            </span>
          )}
        </button>
        {/* Extension tabs (prop) */}
        {extensionTabs?.map((tab, index) => {
          const tabValue = `ext-${index}`
          return (
            <button
              key={tabValue}
              data-testid={`permission-tab-${tabValue}`}
              type="button"
              onClick={() => setActiveTab(tabValue)}
              className={`flex min-h-11 min-w-11 shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tabValue
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
              {tab.label}
            </button>
          )
        })}
        {/* Registered external permission tabs */}
        {externalTabs.map(tab => {
          const tabValue = `ext-reg-${tab.type}`
          const tabGroups = externalRoleGroups[tab.type]
          const tabCount = tabGroups
            ? Object.values(tabGroups).reduce((sum, arr) => sum + arr.length, 0)
            : 0
          return (
            <button
              key={tabValue}
              data-testid={`permission-tab-${tabValue}`}
              type="button"
              onClick={() => setActiveTab(tabValue)}
              className={`flex min-h-11 min-w-11 shrink-0 items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tabValue
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
              {loc(tab.labelKey, tab.label || tab.type)}
              {tabCount > 0 && (
                <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                  {tabCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ===== User Tab ===== */}
      {activeTab === 'user' && (
        <div className="space-y-4">
          <PermissionRequests
            roles={approvalRoles}
            onRoleChange={setApprovalRole}
            pending={permissions.pending}
            loading={loading}
            onReview={reviewPermission}
          />

          {/* Approved Users Section */}
          <Card padding="default" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="w-4 h-4 text-primary" />
                {t('document.permission.approvedUsers')}
                {approvedCount > 0 && (
                  <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                    {approvedCount}
                  </span>
                )}
              </div>
            </div>

            {approvedCount === 0 ? (
              <p className="text-sm text-text-muted py-4 text-center">
                {t(
                  query
                    ? 'document.permission.noMatchingMembers'
                    : 'document.permission.noApprovedUsers'
                )}
              </p>
            ) : (
              <div className="space-y-4">
                {userRoleGroups &&
                  Object.entries(userRoleGroups).map(
                    ([role, users]) =>
                      users.length > 0 && (
                        <PermissionGroup
                          key={role}
                          title={t(`document.permission.role.${role}`)}
                          users={users}
                          editingId={editingId}
                          editingRole={editingRole}
                          setEditingRole={setEditingRole}
                          onStartEditing={startEditing}
                          onCancelEditing={cancelEditing}
                          onUpdateRole={handleUpdateRole}
                          onDelete={handleDelete}
                          loading={loading}
                          t={t}
                        />
                      )
                  )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ===== Group Tab ===== */}
      {activeTab === 'namespace' && (
        <div className="space-y-4">
          <Card padding="default" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="w-4 h-4 text-primary" />
                {loc('document.permission.namespaceMembers', '群组')}
                {namespaceGroupCount > 0 && (
                  <span className="bg-primary/10 text-primary px-1.5 py-0.5 rounded-full text-xs">
                    {namespaceGroupCount}
                  </span>
                )}
              </div>
            </div>

            {namespaceGroupCount === 0 ? (
              <p className="text-sm text-text-muted py-4 text-center">
                {query
                  ? t('document.permission.noMatchingMembers')
                  : loc('document.permission.noNamespacePermissions', '暂无群组权限')}
              </p>
            ) : (
              <div className="space-y-4">
                {namespaceRoleGroups &&
                  Object.entries(namespaceRoleGroups).map(
                    ([role, users]) =>
                      users.length > 0 && (
                        <PermissionGroup
                          key={role}
                          title={t(`document.permission.role.${role}`)}
                          users={users}
                          editingId={editingId}
                          editingRole={editingRole}
                          setEditingRole={setEditingRole}
                          onStartEditing={startEditing}
                          onCancelEditing={cancelEditing}
                          onUpdateRole={handleUpdateRole}
                          onDelete={handleDelete}
                          loading={loading}
                          t={t}
                        />
                      )
                  )}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ===== Extension Tab Content (prop) ===== */}
      {extensionTabs?.map((tab, index) => {
        const tabValue = `ext-${index}`
        return activeTab === tabValue ? <div key={tabValue}>{tab.render({ kbId })}</div> : null
      })}

      {/* ===== Registered External Tab Content ===== */}
      {externalTabs.map(tab => {
        const tabValue = `ext-reg-${tab.type}`
        const tabGroups = externalRoleGroups[tab.type]
        const tabCount = tabGroups
          ? Object.values(tabGroups).reduce((sum, arr) => sum + arr.length, 0)
          : 0
        return activeTab === tabValue ? (
          <div key={tabValue} className="space-y-4">
            <Card padding="default" className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {tab.icon}
                  {loc(tab.labelKey, tab.label || tab.type)}
                </div>
              </div>
              {tabCount === 0 ? (
                <p className="text-sm text-text-muted py-4 text-center">
                  {query
                    ? t('document.permission.noMatchingMembers')
                    : loc('document.permission.noApprovedUsers', '暂无已授权用户')}
                </p>
              ) : (
                <div className="space-y-4">
                  {tabGroups &&
                    Object.entries(tabGroups).map(
                      ([role, users]) =>
                        users.length > 0 && (
                          <PermissionGroup
                            key={role}
                            title={t(`document.permission.role.${role}`)}
                            users={users}
                            editingId={editingId}
                            editingRole={editingRole}
                            setEditingRole={setEditingRole}
                            onStartEditing={startEditing}
                            onCancelEditing={cancelEditing}
                            onUpdateRole={handleUpdateRole}
                            onDelete={handleDelete}
                            loading={loading}
                            t={t}
                          />
                        )
                    )}
                </div>
              )}
            </Card>
          </div>
        ) : null
      })}

      {showAdd && (
        <KnowledgeGrantDialog trigger={addTrigger} onClose={() => setShowAdd(false)}>
          <KnowledgeGrantForm
            kbId={kbId}
            kbNamespace={kbNamespace}
            boundNamespaceIds={Object.values(permissions.approved)
              .flat()
              .filter(member => member.entity_type === 'namespace')
              .flatMap(member => (member.entity_id ? [member.entity_id] : []))}
            onChanged={handleExternalChanged}
            onAccessDenied={onAccessDenied}
            onCancel={() => setShowAdd(false)}
          />
        </KnowledgeGrantDialog>
      )}
    </div>
  )
}

// Permission Group Component
interface PermissionGroupProps {
  title: string
  users: PermissionUserInfo[]
  editingId: number | null
  editingRole: MemberRole
  setEditingRole: (role: MemberRole) => void
  onStartEditing: (user: PermissionUserInfo) => void
  onCancelEditing: () => void
  onUpdateRole: (id: number, role: MemberRole) => void
  onDelete: (id: number) => void
  loading: boolean
  t: (key: string) => string
}

export function PermissionGroup({
  title,
  users,
  editingId,
  editingRole,
  setEditingRole,
  onStartEditing,
  onCancelEditing,
  onUpdateRole,
  onDelete,
  loading,
  t,
}: PermissionGroupProps) {
  return (
    <div>
      <div className="text-xs font-medium text-text-muted mb-2">{title}</div>
      <div className="space-y-1">
        {users.map(user => (
          <div
            key={user.id}
            className="group flex min-w-0 flex-wrap items-center justify-between gap-2 p-2 rounded-lg hover:bg-muted transition-colors"
          >
            <div className="min-w-0 flex-1 basis-32">
              <div className="font-medium text-sm truncate">{user.display_name}</div>
              {user.email && <div className="text-xs text-text-muted truncate">{user.email}</div>}
            </div>
            {editingId === user.id ? (
              <div className="flex items-center gap-2">
                <Select value={editingRole} onValueChange={v => setEditingRole(v as MemberRole)}>
                  <SelectTrigger className="w-28 h-11 min-w-[44px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map(role => (
                      <SelectItem key={role} value={role}>
                        {t(`document.permission.role.${role}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px] text-success"
                  aria-label={t('document.navigation.savePermission')}
                  data-testid={`permission-save-${user.id}`}
                  onClick={() => onUpdateRole(user.id, editingRole)}
                  disabled={loading}
                >
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px]"
                  aria-label={t('document.navigation.cancelPermission')}
                  data-testid={`permission-cancel-${user.id}`}
                  onClick={onCancelEditing}
                  disabled={loading}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px]"
                  data-testid={`permission-edit-${user.id}`}
                  aria-label={t('document.permission.modify')}
                  onClick={() => onStartEditing(user)}
                  title={t('document.permission.modify')}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 min-w-[44px] text-error hover:text-error"
                  data-testid={`permission-delete-${user.id}`}
                  aria-label={t('document.permission.remove')}
                  onClick={() => onDelete(user.id)}
                  title={t('document.permission.remove')}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
