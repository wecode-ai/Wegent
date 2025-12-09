// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '@/features/common/Modal'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  listGroupMembers,
  addGroupMember,
  removeGroupMember,
  updateGroupMemberRole,
  inviteAllUsers,
  leaveGroup,
  transferOwnership,
} from '@/apis/groups'
import { getUsers } from '@/apis/users'
import { toast } from 'sonner'
import type { Group, GroupMember, GroupRole } from '@/types/group'
import type { UserInfo } from '@/types/api'
import { UserPlusIcon, LogOutIcon, ArrowRightLeftIcon } from 'lucide-react'

interface GroupMembersDialogProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
  group: Group | null
  currentUserId?: number
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
  const [allUsers, setAllUsers] = useState<UserInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [showTransferOwnership, setShowTransferOwnership] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [selectedRole, setSelectedRole] = useState<GroupRole>('Reporter')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const myRole = group?.my_role

  // Permission checks
  const canAddMember = myRole === 'Owner' || myRole === 'Maintainer'
  const canRemoveMember = myRole === 'Owner' || myRole === 'Maintainer'
  const canUpdateRole = myRole === 'Owner'
  const canInviteAll = myRole === 'Owner'
  const canTransferOwnership = myRole === 'Owner'
  const canLeave = myRole !== 'Owner'

  useEffect(() => {
    if (isOpen && group) {
      loadMembers()
      if (canAddMember) {
        loadUsers()
      }
    }
  }, [isOpen, group])

  const loadMembers = async () => {
    if (!group) return

    setLoading(true)
    try {
      const response = await listGroupMembers(group.name)
      setMembers(response.items || [])
    } catch (error) {
      console.error('Failed to load members:', error)
      toast.error('Failed to load members')
    } finally {
      setLoading(false)
    }
  }

  const loadUsers = async () => {
    try {
      const users = await getUsers()
      setAllUsers(users)
    } catch (error) {
      console.error('Failed to load users:', error)
    }
  }

  const handleAddMember = async () => {
    if (!group || !selectedUserId) return

    setIsSubmitting(true)
    try {
      await addGroupMember(group.name, {
        user_id: selectedUserId,
        role: selectedRole,
      })
      toast.success(t('groups.messages.memberAdded'))
      setShowAddMember(false)
      setSelectedUserId(null)
      setSelectedRole('Reporter')
      loadMembers()
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add member:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to add member'
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemoveMember = async (userId: number) => {
    if (!group) return

    if (!confirm('Are you sure you want to remove this member?')) {
      return
    }

    try {
      await removeGroupMember(group.name, userId)
      toast.success(t('groups.messages.memberRemoved'))
      loadMembers()
      onSuccess()
    } catch (error: any) {
      console.error('Failed to remove member:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to remove member'
      toast.error(errorMessage)
    }
  }

  const handleUpdateRole = async (userId: number, newRole: GroupRole) => {
    if (!group) return

    try {
      await updateGroupMemberRole(group.name, userId, { role: newRole })
      toast.success(t('groups.messages.roleUpdated'))
      loadMembers()
      onSuccess()
    } catch (error: any) {
      console.error('Failed to update role:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to update role'
      toast.error(errorMessage)
    }
  }

  const handleInviteAll = async () => {
    if (!group) return

    if (!confirm('Invite all system users as Reporters?')) {
      return
    }

    setIsSubmitting(true)
    try {
      await inviteAllUsers(group.name)
      toast.success('All users invited successfully')
      loadMembers()
      onSuccess()
    } catch (error: any) {
      console.error('Failed to invite all users:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to invite all users'
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLeaveGroup = async () => {
    if (!group) return

    if (!confirm('Are you sure you want to leave this group? Your resources will be transferred to the group owner.')) {
      return
    }

    try {
      await leaveGroup(group.name)
      toast.success('You have left the group')
      onSuccess()
      onClose()
    } catch (error: any) {
      console.error('Failed to leave group:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to leave group'
      toast.error(errorMessage)
    }
  }

  const handleTransferOwnership = async () => {
    if (!group || !selectedUserId) return

    if (!confirm('Are you sure you want to transfer ownership? You will become a Maintainer.')) {
      return
    }

    setIsSubmitting(true)
    try {
      await transferOwnership(group.name, selectedUserId)
      toast.success('Ownership transferred successfully')
      setShowTransferOwnership(false)
      setSelectedUserId(null)
      onSuccess()
      onClose()
    } catch (error: any) {
      console.error('Failed to transfer ownership:', error)
      const errorMessage = error?.response?.data?.detail || 'Failed to transfer ownership'
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const getRoleBadgeVariant = (role: GroupRole): 'default' | 'secondary' | 'outline' | 'destructive' => {
    switch (role) {
      case 'Owner':
        return 'destructive'
      case 'Maintainer':
        return 'default'
      case 'Developer':
        return 'secondary'
      case 'Reporter':
        return 'outline'
      default:
        return 'outline'
    }
  }

  const getAvailableUsers = () => {
    const memberUserIds = new Set(members.map((m) => m.user_id))
    return allUsers.filter((user) => !memberUserIds.has(user.id))
  }

  const getMaintainers = () => {
    return members.filter((m) => m.role === 'Maintainer')
  }

  if (!group) {
    return null
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('groups.actions.manageMembers')}
      maxWidth="3xl"
    >
      <div className="space-y-4">
        {/* Action Buttons */}
        <div className="flex flex-wrap gap-2 pb-4 border-b border-border">
          {canAddMember && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAddMember(!showAddMember)}
              disabled={isSubmitting}
            >
              <UserPlusIcon className="w-4 h-4 mr-2" />
              {t('groups.actions.addMember')}
            </Button>
          )}
          {canInviteAll && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleInviteAll}
              disabled={isSubmitting}
            >
              <UserPlusIcon className="w-4 h-4 mr-2" />
              {t('groups.actions.inviteAll')}
            </Button>
          )}
          {canTransferOwnership && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTransferOwnership(!showTransferOwnership)}
              disabled={isSubmitting}
            >
              <ArrowRightLeftIcon className="w-4 h-4 mr-2" />
              {t('groups.actions.transferOwnership')}
            </Button>
          )}
          {canLeave && (
            <Button variant="outline" size="sm" onClick={handleLeaveGroup}>
              <LogOutIcon className="w-4 h-4 mr-2" />
              {t('groups.actions.leave')}
            </Button>
          )}
        </div>

        {/* Add Member Form */}
        {showAddMember && canAddMember && (
          <div className="p-4 border border-border rounded-lg bg-surface space-y-3">
            <h3 className="text-sm font-medium">{t('groups.actions.addMember')}</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-2">
                <Select
                  value={selectedUserId?.toString() || ''}
                  onValueChange={(value) => setSelectedUserId(parseInt(value))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select user..." />
                  </SelectTrigger>
                  <SelectContent>
                    {getAvailableUsers().map((user) => (
                      <SelectItem key={user.id} value={user.id.toString()}>
                        {user.user_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Select
                  value={selectedRole}
                  onValueChange={(value: GroupRole) => setSelectedRole(value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Owner">{t('groups.roles.Owner')}</SelectItem>
                    <SelectItem value="Maintainer">{t('groups.roles.Maintainer')}</SelectItem>
                    <SelectItem value="Developer">{t('groups.roles.Developer')}</SelectItem>
                    <SelectItem value="Reporter">{t('groups.roles.Reporter')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowAddMember(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleAddMember} disabled={!selectedUserId || isSubmitting}>
                Add
              </Button>
            </div>
          </div>
        )}

        {/* Transfer Ownership Form */}
        {showTransferOwnership && canTransferOwnership && (
          <div className="p-4 border border-border rounded-lg bg-surface space-y-3">
            <h3 className="text-sm font-medium">{t('groups.actions.transferOwnership')}</h3>
            <p className="text-xs text-text-secondary">
              Select a Maintainer to transfer ownership. You will become a Maintainer.
            </p>
            <Select
              value={selectedUserId?.toString() || ''}
              onValueChange={(value) => setSelectedUserId(parseInt(value))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select maintainer..." />
              </SelectTrigger>
              <SelectContent>
                {getMaintainers().map((member) => (
                  <SelectItem key={member.id} value={member.user_id.toString()}>
                    {member.user_name || `User ${member.user_id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowTransferOwnership(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleTransferOwnership}
                disabled={!selectedUserId || isSubmitting}
                className="bg-error hover:bg-error/90"
              >
                Transfer
              </Button>
            </div>
          </div>
        )}

        {/* Members Table */}
        {loading ? (
          <div className="text-center py-8 text-text-secondary">{t('actions.loading')}</div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-[400px]">
              <table className="w-full">
                <thead className="bg-muted border-b border-border sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      Username
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      Role
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      Invited By
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      Join Date
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-text-primary">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {members.map((member) => {
                    const isMe = member.user_id === currentUserId
                    const isOwner = member.role === 'Owner'

                    return (
                      <tr key={member.id} className="hover:bg-surface">
                        <td className="px-4 py-3 text-sm font-medium text-text-primary">
                          {member.user_name || `User ${member.user_id}`}
                          {isMe && (
                            <Badge variant="outline" className="ml-2">
                              You
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {canUpdateRole && !isOwner ? (
                            <Select
                              value={member.role}
                              onValueChange={(value: GroupRole) =>
                                handleUpdateRole(member.user_id, value)
                              }
                            >
                              <SelectTrigger className="w-[140px]">
                                <Badge variant={getRoleBadgeVariant(member.role)}>
                                  {t(`groups.roles.${member.role}`)}
                                </Badge>
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Maintainer">
                                  {t('groups.roles.Maintainer')}
                                </SelectItem>
                                <SelectItem value="Developer">
                                  {t('groups.roles.Developer')}
                                </SelectItem>
                                <SelectItem value="Reporter">
                                  {t('groups.roles.Reporter')}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            <Badge variant={getRoleBadgeVariant(member.role)}>
                              {t(`groups.roles.${member.role}`)}
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
                          {canRemoveMember && !isOwner && !isMe && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveMember(member.user_id)}
                              className="text-error hover:text-error"
                            >
                              Remove
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

        {/* Footer */}
        <div className="flex justify-end pt-4">
          <Button variant="outline" onClick={onClose}>
            {t('actions.close')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
