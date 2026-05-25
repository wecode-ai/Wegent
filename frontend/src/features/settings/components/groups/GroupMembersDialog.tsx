// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import Modal from '@/features/common/Modal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  listGroupMembers,
  removeGroupMember,
  batchUpdateGroupMemberRoles,
  inviteAllUsers,
  leaveGroup,
} from '@/apis/groups'
import { ApiError } from '@/apis/client'
import { toast } from 'sonner'
import type { Group, GroupMember, GroupRole } from '@/types/group'
import type { GroupExtensionConfig } from '@/features/groups/extension-loader'
import { ASSIGNABLE_ROLES, BASE_ROLES, canLeave, compareRoles, isOwner } from '@/types/base-role'
import { canManageNamespace } from '@/utils/namespace-permissions'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  UserPlusIcon,
  PlusIcon,
  LogOutIcon,
} from 'lucide-react'
import { AddMemberPanel } from './AddMemberPanel'

interface GroupMembersDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  group: Group | null
  currentUserId?: number
}

type MemberSortField = 'role' | 'username' | 'joinDate'
type SortOrder = 'asc' | 'desc'
type MemberListItem = {
  member: GroupMember
  displayedRole: GroupRole
  roleLabel: string
}

const GROUP_MEMBER_ERROR_MESSAGE_KEYS: Record<string, string> = {
  GROUP_OWNER_ROLE_CHANGE_REQUIRES_TRANSFER:
    'groups:groupMembers.errors.currentOwnerRoleChangeRequiresTransfer',
}

function getMemberDisplayName(member: GroupMember): string {
  return member.user_name?.trim() || `User ${member.user_id}`
}

function getGroupMemberErrorMessage(
  t: (key: string) => string,
  errorCode?: string | number | null,
  fallbackMessage?: string
): string {
  if (typeof errorCode === 'string') {
    const translationKey = GROUP_MEMBER_ERROR_MESSAGE_KEYS[errorCode]
    if (translationKey) {
      return t(translationKey)
    }
  }

  return fallbackMessage || t('groups:groupMembers.updateRoleFailed')
}

function filterMembers(members: MemberListItem[], query: string): MemberListItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return members
  }

  return members.filter(member =>
    [
      getMemberDisplayName(member.member),
      member.member.invited_by_user_name || '',
      member.displayedRole,
      member.roleLabel,
      String(member.member.user_id),
    ].some(value => value.toLowerCase().includes(normalizedQuery))
  )
}

function sortMembers(
  members: MemberListItem[],
  sortField: MemberSortField,
  sortOrder: SortOrder
): MemberListItem[] {
  return [...members].sort((left, right) => {
    const leftName = getMemberDisplayName(left.member)
    const rightName = getMemberDisplayName(right.member)
    const nameDiff = leftName.localeCompare(rightName, undefined, {
      numeric: true,
      sensitivity: 'base',
    })

    let comparison = 0

    if (sortField === 'username') {
      comparison = nameDiff || left.member.user_id - right.member.user_id
    } else if (sortField === 'joinDate') {
      comparison =
        new Date(left.member.created_at).getTime() - new Date(right.member.created_at).getTime() ||
        nameDiff ||
        left.member.user_id - right.member.user_id
    } else {
      comparison =
        compareRoles(right.displayedRole, left.displayedRole) ||
        nameDiff ||
        left.member.user_id - right.member.user_id
    }

    return sortOrder === 'asc' ? comparison : -comparison
  })
}

export function GroupMembersDialog({
  isOpen,
  onClose,
  onSuccess,
  group,
  currentUserId,
}: GroupMembersDialogProps) {
  const { t } = useTranslation()
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddPanel, setShowAddPanel] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSavingRoleChanges, setIsSavingRoleChanges] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<MemberSortField>('role')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [roleDrafts, setRoleDrafts] = useState<Record<number, GroupRole>>({})
  const [activeTab, setActiveTab] = useState<'members' | 'authorizations'>('members')
  const [extensionConfig, setExtensionConfig] = useState<GroupExtensionConfig | null>(null)
  const [isExtensionLoading, setIsExtensionLoading] = useState(false)
  const [entityRefreshTrigger, setEntityRefreshTrigger] = useState(0)
  const [entityCount, setEntityCount] = useState(0)

  const myRole = group?.my_role
  const isPrivateGroup = group?.visibility === 'private'
  const canManageGroupMembers = canManageNamespace({
    namespaceRole: myRole,
  })

  // Permission checks using utility functions
  // Private groups do not allow adding members
  const canAddMember = canManageGroupMembers && !isPrivateGroup
  const canRemoveMember = canManageGroupMembers
  const canUpdateRole = canManageGroupMembers
  const canInviteAll = canManageGroupMembers && !isPrivateGroup
  const canLeaveGroup = canLeave(myRole)
  const hasMemberManagementPermission = canAddMember || canRemoveMember || canUpdateRole
  const hasUnsavedRoleChanges = Object.keys(roleDrafts).length > 0
  const editableRoleOptions = myRole === 'Owner' ? BASE_ROLES : ASSIGNABLE_ROLES
  const memberListItems = members.map(member => {
    const displayedRole = roleDrafts[member.user_id] ?? member.role
    return {
      member,
      displayedRole,
      roleLabel: t(`groups:groups.roles.${displayedRole}`),
    }
  })
  const visibleMembers = sortMembers(
    filterMembers(memberListItems, searchQuery),
    sortField,
    sortOrder
  )

  useEffect(() => {
    if (isOpen && group) {
      setRoleDrafts({})
      setSearchQuery('')
      setSortField('role')
      setSortOrder('asc')
      setShowAddPanel(false)
      setActiveTab('members')
      loadMembers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, group])

  useEffect(() => {
    if (!isOpen) {
      setExtensionConfig(null)
      setIsExtensionLoading(false)
      return
    }
    let active = true
    setIsExtensionLoading(true)
    import('@/features/groups/extension-loader')
      .then(({ loadGroupExtension }) => loadGroupExtension())
      .then(config => {
        if (active) {
          setExtensionConfig(config)
          setIsExtensionLoading(false)
        }
      })
      .catch((err: unknown) => {
        if (active) {
          console.warn('Failed to load group extension', err)
          setIsExtensionLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [isOpen])

  const loadMembers = async () => {
    if (!group) return

    setLoading(true)
    try {
      const response = await listGroupMembers(group.name)
      // Backend returns array directly, not wrapped in {items: []}
      const membersList = Array.isArray(response) ? response : response.items || []
      setMembers(membersList)
      setRoleDrafts(prevDrafts =>
        Object.fromEntries(
          Object.entries(prevDrafts).filter(([userId, role]) => {
            const member = membersList.find(item => item.user_id === Number(userId))
            return member && member.role !== role
          })
        )
      )
    } catch (error) {
      console.error('Failed to load members:', error)
      toast.error(t('groups:groupMembers.loadMembersFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleRemoveMember = async (userId: number) => {
    if (!group) return

    if (!confirm(t('groups:groupMembers.confirmRemove'))) {
      return
    }

    try {
      await removeGroupMember(group.name, userId)
      toast.success(t('groups:groups.messages.memberRemoved'))
      setMembers(prevMembers => prevMembers.filter(member => member.user_id !== userId))
      setRoleDrafts(prevDrafts => {
        const nextDrafts = { ...prevDrafts }
        delete nextDrafts[userId]
        return nextDrafts
      })
      onSuccess()
    } catch (error: unknown) {
      console.error('Failed to remove member:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groups:groupMembers.removeMemberFailed')
      toast.error(errorMessage)
    }
  }

  const handleRoleDraftChange = (member: GroupMember, newRole: GroupRole) => {
    if (isSavingRoleChanges) {
      return
    }

    setRoleDrafts(prevDrafts => {
      if (newRole === member.role) {
        const nextDrafts = { ...prevDrafts }
        delete nextDrafts[member.user_id]
        return nextDrafts
      }

      return {
        ...prevDrafts,
        [member.user_id]: newRole,
      }
    })
  }

  const handleDiscardRoleChanges = () => {
    setRoleDrafts({})
  }

  const handleSaveRoleChanges = async () => {
    if (!group || !hasUnsavedRoleChanges) return

    setIsSavingRoleChanges(true)
    const updates = Object.entries(roleDrafts).map(([userId, role]) => ({
      user_id: Number(userId),
      role,
    }))

    try {
      const result = await batchUpdateGroupMemberRoles(group.name, { updates })
      const successfulUpdates = new Map(
        result.updated_members.map(member => [member.user_id, member.role] as const)
      )

      if (successfulUpdates.size > 0) {
        setMembers(prevMembers =>
          prevMembers.map(member => ({
            ...member,
            role: successfulUpdates.get(member.user_id) ?? member.role,
          }))
        )
        setRoleDrafts(prevDrafts => {
          const nextDrafts = { ...prevDrafts }
          successfulUpdates.forEach((_, userId) => {
            delete nextDrafts[userId]
          })
          return nextDrafts
        })
        toast.success(
          t('groups:groupMembers.saveRoleChangesSuccess', { count: successfulUpdates.size })
        )
      }

      if (result.failed_updates.length > 0) {
        result.failed_updates.forEach(({ user_id, error, error_code }) => {
          const memberName =
            members.find(item => item.user_id === user_id)?.user_name || `User ${user_id}`
          toast.error(`${memberName}: ${getGroupMemberErrorMessage(t, error_code, error)}`)
        })
      }
    } catch (error: unknown) {
      console.error('Failed to save role changes:', error)
      if (error instanceof ApiError) {
        toast.error(getGroupMemberErrorMessage(t, error.errorCode, error.message))
      } else {
        const err = error as { message?: string }
        toast.error(err?.message || t('groups:groupMembers.updateRoleFailed'))
      }
    } finally {
      setIsSavingRoleChanges(false)
    }
  }

  const handleInviteAll = async () => {
    if (!group) return

    if (!confirm(t('groups:groupMembers.confirmInviteAll'))) {
      return
    }

    setIsSubmitting(true)
    try {
      await inviteAllUsers(group.name)
      toast.success(t('groups:groupMembers.inviteAllSuccess'))
      await loadMembers()
      onSuccess()
    } catch (error: unknown) {
      console.error('Failed to invite all users:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groups:groupMembers.inviteAllFailed')
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLeaveGroup = async () => {
    if (!group) return

    if (!confirm(t('groups:groupMembers.confirmLeave'))) {
      return
    }

    try {
      await leaveGroup(group.name)
      toast.success(t('groups:groupMembers.leaveSuccess'))
      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to leave group:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groups:groupMembers.leaveFailed')
      toast.error(errorMessage)
    }
  }

  const handleDialogClose = () => {
    if (isSubmitting || isSavingRoleChanges) {
      return
    }

    if (hasUnsavedRoleChanges && !confirm(t('groups:groupMembers.confirmDiscardRoleChanges'))) {
      return
    }

    onClose()
  }

  const handleSort = (field: MemberSortField) => {
    if (sortField === field) {
      setSortOrder(currentOrder => (currentOrder === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortField(field)
    setSortOrder(field === 'joinDate' ? 'desc' : 'asc')
  }

  const SortIcon = ({ field }: { field: MemberSortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="ml-1 h-3.5 w-3.5 text-text-muted/80" />
    }

    return sortOrder === 'asc' ? (
      <ChevronUp className="ml-1 h-3.5 w-3.5 text-primary" />
    ) : (
      <ChevronDown className="ml-1 h-3.5 w-3.5 text-primary" />
    )
  }

  const getRoleBadgeVariant = (
    role: GroupRole
  ): 'default' | 'secondary' | 'success' | 'error' | 'warning' | 'info' => {
    switch (role) {
      case 'Owner':
        return 'error'
      case 'Maintainer':
        return 'default'
      case 'Developer':
        return 'secondary'
      case 'Reporter':
        return 'info'
      case 'RestrictedAnalyst':
        return 'warning'
      default:
        return 'info'
    }
  }

  const memberListContent = (
    <>
      <div className="w-full md:max-w-xs">
        <Input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder={t('groups:groupMembers.searchMembersPlaceholder')}
          aria-label={t('groups:groupMembers.searchMembersPlaceholder')}
          disabled={loading}
          data-testid="group-members-search-input"
        />
      </div>

      {/* Members Table */}
      {loading ? (
        <div className="text-center py-8 text-text-secondary">{t('common:actions.loading')}</div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto max-h-[400px]">
            <table className="w-full">
              <thead className="bg-muted border-b border-border sticky top-0">
                <tr>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-text-primary"
                    aria-sort={
                      sortField === 'username'
                        ? sortOrder === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('username')}
                      className="inline-flex items-center text-left transition-colors hover:text-primary"
                      data-testid="group-members-sort-username-button"
                    >
                      {t('groups:groupMembers.username')}
                      <SortIcon field="username" />
                    </button>
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-text-primary"
                    aria-sort={
                      sortField === 'role'
                        ? sortOrder === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('role')}
                      className="inline-flex items-center text-left transition-colors hover:text-primary"
                      data-testid="group-members-sort-role-button"
                    >
                      {t('groups:groups.role')}
                      <SortIcon field="role" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                    {t('groups:groupMembers.invitedBy')}
                  </th>
                  <th
                    className="px-4 py-3 text-left text-xs font-medium text-text-primary"
                    aria-sort={
                      sortField === 'joinDate'
                        ? sortOrder === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('joinDate')}
                      className="inline-flex items-center text-left transition-colors hover:text-primary"
                      data-testid="group-members-sort-join-date-button"
                    >
                      {t('groups:groupMembers.joinDate')}
                      <SortIcon field="joinDate" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-text-primary">
                    {t('groups:groupMembers.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleMembers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-sm text-text-secondary">
                      {t('groups:groupMembers.noMembersFound')}
                    </td>
                  </tr>
                )}
                {visibleMembers.map(({ member, displayedRole }) => {
                  const isMe = member.user_id === currentUserId
                  const memberIsOwner = isOwner(displayedRole)
                  const hasDraftRoleChange = displayedRole !== member.role

                  return (
                    <tr
                      key={member.id}
                      className={
                        hasDraftRoleChange ? 'bg-primary/5 hover:bg-primary/10' : 'hover:bg-surface'
                      }
                    >
                      <td className="px-4 py-3 text-sm font-medium text-text-primary">
                        {getMemberDisplayName(member)}
                        {isMe && (
                          <Badge variant="info" className="ml-2">
                            {t('groups:groupMembers.you')}
                          </Badge>
                        )}
                        {hasDraftRoleChange && (
                          <Badge variant="warning" className="ml-2">
                            {t('groups:groupMembers.pendingChange')}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {canUpdateRole &&
                        !isMe &&
                        !(myRole === 'Maintainer' && isOwner(member.role)) ? (
                          <Select
                            value={displayedRole}
                            onValueChange={(value: GroupRole) => {
                              if (isSavingRoleChanges) {
                                return
                              }
                              handleRoleDraftChange(member, value)
                            }}
                            disabled={isSavingRoleChanges}
                          >
                            <SelectTrigger className="h-8 w-[180px]">
                              <SelectValue placeholder={t(`groups:groups.roles.${displayedRole}`)}>
                                {t(`groups:groups.roles.${displayedRole}`)}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {editableRoleOptions.map(role => (
                                <SelectItem key={role} value={role}>
                                  <div className="flex flex-col">
                                    <span>{t(`groups:groups.roles.${role}`)}</span>
                                    <span className="text-xs text-text-muted">
                                      {t(`groups:groupMembers.roleDescriptions.${role}`)}
                                    </span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant={getRoleBadgeVariant(displayedRole)}>
                            {t(`groups:groups.roles.${displayedRole}`)}
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">
                        {member.invited_by_user_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">
                        {new Date(member.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-sm text-right">
                        {canRemoveMember && !memberIsOwner && !isMe && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveMember(member.user_id)}
                            className="text-error hover:text-error"
                            disabled={isSavingRoleChanges}
                          >
                            {t('groups:groupMembers.remove')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )

  if (!group) {
    return null
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleDialogClose}
      title={
        hasMemberManagementPermission
          ? t('groups:groups.actions.manageMembers')
          : t('groups:groups.members')
      }
      maxWidth="3xl"
    >
      <div className="space-y-4">
        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pb-4 border-b border-border">
          {canAddMember && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddPanel(!showAddPanel)}
              disabled={isSubmitting}
              data-testid="group-members-add-button"
            >
              {showAddPanel || activeTab === 'members' || !extensionConfig ? (
                <UserPlusIcon className="w-4 h-4 mr-2" />
              ) : (
                <PlusIcon className="w-4 h-4 mr-2" />
              )}
              {showAddPanel
                ? t('common:actions.cancel')
                : activeTab === 'members' || !extensionConfig
                  ? t('groups:groups.actions.addMember')
                  : extensionConfig.addTabLabel}
            </Button>
          )}
          {/* Temporarily hidden: Invite All Users button */}
          {false && canInviteAll && (
            <Button variant="outline" size="sm" onClick={handleInviteAll} disabled={isSubmitting}>
              <UserPlusIcon className="w-4 h-4 mr-2" />
              {t('groups:groups.actions.inviteAll')}
            </Button>
          )}
          {canLeaveGroup && (
            <Button variant="outline" size="sm" onClick={handleLeaveGroup}>
              <LogOutIcon className="w-4 h-4 mr-2" />
              {t('groups:groups.actions.leave')}
            </Button>
          )}
        </div>

        {/* Add Member Panel */}
        {showAddPanel && canAddMember && (
          <AddMemberPanel
            group={group}
            extensionConfig={extensionConfig}
            myRole={myRole}
            existingMemberUsernames={members.map(m => m.user_name).filter(Boolean) as string[]}
            defaultTab={activeTab === 'members' ? 'addUser' : 'addEntity'}
            onAddUserSuccess={() => {
              toast.success(t('groups:groups.messages.memberAdded'))
              setShowAddPanel(false)
              loadMembers()
              onSuccess()
            }}
            onAddEntitySuccess={() => {
              toast.success(t('groups:groups.messages.memberAdded'))
              setShowAddPanel(false)
              setEntityRefreshTrigger(n => n + 1)
              onSuccess()
            }}
            onCancel={() => setShowAddPanel(false)}
          />
        )}

        {/* Main Content Tabs */}
        {isExtensionLoading ? (
          <div className="text-center py-8 text-text-secondary">{t('common:actions.loading')}</div>
        ) : extensionConfig ? (
          <Tabs
            value={activeTab}
            onValueChange={(value: string) => setActiveTab(value as 'members' | 'authorizations')}
          >
            <TabsList>
              <TabsTrigger value="members" data-testid="group-members-tab">
                {t('groups:groupMembers.tabs.members')}
              </TabsTrigger>
              <TabsTrigger value="authorizations" data-testid="group-authorizations-tab">
                {extensionConfig.listTabLabel}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="members">{memberListContent}</TabsContent>
            <TabsContent value="authorizations">
              <extensionConfig.listView
                key={`list-${group.name}`}
                groupName={group.name}
                canManage={canManageGroupMembers}
                refreshTrigger={entityRefreshTrigger}
                onCountChange={setEntityCount}
              />
            </TabsContent>
          </Tabs>
        ) : (
          memberListContent
        )}

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-border pt-4 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-text-secondary">
            {activeTab === 'authorizations'
              ? hasUnsavedRoleChanges
                ? `${t('groups:groupMembers.visibleAuthorizationsCount', { count: entityCount })} · ${t('groups:groupMembers.unsavedChangesInMembersTab')}`
                : t('groups:groupMembers.visibleAuthorizationsCount', { count: entityCount })
              : hasUnsavedRoleChanges
                ? t('groups:groupMembers.pendingChangesCount', {
                    count: Object.keys(roleDrafts).length,
                  })
                : t('groups:groupMembers.visibleMembersCount', { count: visibleMembers.length })}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {hasUnsavedRoleChanges && (
              <Button
                variant="outline"
                onClick={handleDiscardRoleChanges}
                disabled={isSavingRoleChanges || isSubmitting}
                data-testid="group-members-discard-changes-button"
              >
                {t('settings:actions.discard_changes')}
              </Button>
            )}
            {hasUnsavedRoleChanges && (
              <Button
                variant="primary"
                onClick={handleSaveRoleChanges}
                disabled={isSavingRoleChanges || isSubmitting}
                data-testid="group-members-save-changes-button"
              >
                {isSavingRoleChanges ? t('common:actions.saving') : t('common:actions.save')}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleDialogClose}
              data-testid="group-members-close-button"
            >
              {t('common:actions.close')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
