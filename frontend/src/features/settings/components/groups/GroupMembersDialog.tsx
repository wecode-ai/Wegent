// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
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
import {
  listGroupMembers,
  addGroupMemberByUsername,
  removeGroupMember,
  updateGroupMemberRole,
  inviteAllUsers,
  leaveGroup,
} from '@/apis/groups'
import { toast } from 'sonner'
import type { Group, GroupMember, GroupRole } from '@/types/group'
import { UserPlusIcon, LogOutIcon } from 'lucide-react'
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
  const [loading, setLoading] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  const [newMemberUsername, setNewMemberUsername] = useState('')
  const [selectedRole, setSelectedRole] = useState<GroupRole>('Reporter')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const myRole = group?.my_role

  // Permission checks
  const canAddMember = myRole === 'Owner' || myRole === 'Maintainer'
  const canRemoveMember = myRole === 'Owner' || myRole === 'Maintainer'
  const canUpdateRole = myRole === 'Owner' || myRole === 'Maintainer'
  const canInviteAll = myRole === 'Owner' || myRole === 'Maintainer'
  const canLeave = myRole !== 'Owner'

  useEffect(() => {
    if (isOpen && group) {
      loadMembers()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, group])

  const loadMembers = async () => {
    if (!group) return

    setLoading(true)
    try {
      const response = await listGroupMembers(group.name)
      // Backend returns array directly, not wrapped in {items: []}
      const membersList = Array.isArray(response) ? response : (response.items || [])
      setMembers(membersList)
    } catch (error) {
      console.error('Failed to load members:', error)
      toast.error(t('groupMembers.loadMembersFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handleAddMember = async () => {
    if (!group || !newMemberUsername.trim()) return

    // Check if user already exists in members
    const existingMember = members.find(m => m.user_name === newMemberUsername.trim())
    if (existingMember) {
      toast.error(t('groupMembers.userAlreadyMember'))
      return
    }

    setIsSubmitting(true)
    try {
      const result = await addGroupMemberByUsername(group.name, newMemberUsername.trim(), selectedRole)
      
      if (result.success) {
        toast.success(result.message || t('groups.messages.memberAdded'))
        setShowAddMember(false)
        setNewMemberUsername('')
        setSelectedRole('Reporter')
        loadMembers()
        onSuccess()
      } else {
        toast.error(result.message || t('groupMembers.addMemberFailed'))
      }
    } catch (error: unknown) {
      console.error('Failed to add member:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groupMembers.addMemberFailed')
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRemoveMember = async (userId: number) => {
    if (!group) return

    if (!confirm(t('groupMembers.confirmRemove'))) {
      return
    }

    try {
      await removeGroupMember(group.name, userId)
      toast.success(t('groups.messages.memberRemoved'))
      loadMembers()
      onSuccess()
    } catch (error: unknown) {
      console.error('Failed to remove member:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groupMembers.removeMemberFailed')
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
    } catch (error: unknown) {
      console.error('Failed to update role:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groupMembers.updateRoleFailed')
      toast.error(errorMessage)
    }
  }

  const handleInviteAll = async () => {
    if (!group) return

    if (!confirm(t('groupMembers.confirmInviteAll'))) {
      return
    }

    setIsSubmitting(true)
    try {
      await inviteAllUsers(group.name)
      toast.success(t('groupMembers.inviteAllSuccess'))
      loadMembers()
      onSuccess()
    } catch (error: unknown) {
      console.error('Failed to invite all users:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groupMembers.inviteAllFailed')
      toast.error(errorMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLeaveGroup = async () => {
    if (!group) return

    if (!confirm(t('groupMembers.confirmLeave'))) {
      return
    }

    try {
      await leaveGroup(group.name)
      toast.success(t('groupMembers.leaveSuccess'))
      onSuccess()
      onClose()
    } catch (error: unknown) {
      console.error('Failed to leave group:', error)
      const err = error as { message?: string }
      const errorMessage = err?.message || t('groupMembers.leaveFailed')
      toast.error(errorMessage)
    }
  }

  const getRoleBadgeVariant = (role: GroupRole): 'default' | 'secondary' | 'success' | 'error' | 'warning' | 'info' => {
    switch (role) {
      case 'Owner':
        return 'error'
      case 'Maintainer':
        return 'default'
      case 'Developer':
        return 'secondary'
      case 'Reporter':
        return 'info'
      default:
        return 'info'
    }
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
          {/* Temporarily hidden: Invite All Users button */}
          {false && canInviteAll && (
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
                <Input
                  value={newMemberUsername}
                  onChange={(e) => setNewMemberUsername(e.target.value)}
                  placeholder={t('groupMembers.enterUsername')}
                  disabled={isSubmitting}
                />
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
            
            {/* Role Permission Description */}
            <div className="p-3 bg-muted rounded-md">
              <h4 className="text-sm font-medium mb-2">{t('groupMembers.rolePermissions')}</h4>
              <div className="space-y-2 text-xs text-text-muted">
                {selectedRole === 'Reporter' && (
                  <div>
                    <strong>Reporter：</strong>{t('groupMembers.roleDescriptions.Reporter')}
                  </div>
                )}
                {selectedRole === 'Developer' && (
                  <div>
                    <strong>Developer：</strong>{t('groupMembers.roleDescriptions.Developer')}
                  </div>
                )}
                {selectedRole === 'Maintainer' && (
                  <div>
                    <strong>Maintainer：</strong>{t('groupMembers.roleDescriptions.Maintainer')}
                    <ul className="list-disc list-inside ml-2 mt-1">
                      <li>{t('groupMembers.roleDescriptions.MaintainerDetails.manageResources')}</li>
                      <li>{t('groupMembers.roleDescriptions.MaintainerDetails.manageMembers')}</li>
                      <li>{t('groupMembers.roleDescriptions.MaintainerDetails.updateRoles')}</li>
                      <li>{t('groupMembers.roleDescriptions.MaintainerDetails.canLeave')}</li>
                    </ul>
                  </div>
                )}
                {selectedRole === 'Owner' && (
                  <div>
                    <strong>Owner：</strong>{t('groupMembers.roleDescriptions.Owner')}
                    <ul className="list-disc list-inside ml-2 mt-1">
                      <li>{t('groupMembers.roleDescriptions.OwnerDetails.fullControl')}</li>
                      <li>{t('groupMembers.roleDescriptions.OwnerDetails.deleteGroup')}</li>
                      <li>{t('groupMembers.roleDescriptions.OwnerDetails.transferOwnership')}</li>
                      <li>{t('groupMembers.roleDescriptions.OwnerDetails.cannotLeave')}</li>
                    </ul>
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                setShowAddMember(false)
                setNewMemberUsername('')
              }}>
                {t('actions.cancel')}
              </Button>
              <Button size="sm" onClick={handleAddMember} disabled={!newMemberUsername.trim() || isSubmitting}>
                {t('groupMembers.add')}
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
                      {t('groupMembers.username')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groups.role')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groupMembers.invitedBy')}
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-text-primary">
                      {t('groupMembers.joinDate')}
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-text-primary">
                      {t('groupMembers.actions')}
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
                            <Badge variant="info" className="ml-2">
                              {t('groupMembers.you')}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {canUpdateRole && !isMe && !(myRole === 'Maintainer' && isOwner) ? (
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
                                {myRole === 'Owner' && (
                                  <SelectItem value="Owner">
                                    {t('groups.roles.Owner')}
                                  </SelectItem>
                                )}
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
                              {t('groupMembers.remove')}
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
