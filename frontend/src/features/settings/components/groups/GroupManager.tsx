// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { listGroups } from '@/apis/groups'
import type { Group } from '@/types/group'
import { PlusIcon, PencilIcon, TrashIcon, UsersIcon } from 'lucide-react'
import { toast } from 'sonner'
import { CreateGroupDialog } from './CreateGroupDialog'
import { EditGroupDialog } from './EditGroupDialog'
import { DeleteGroupConfirmDialog } from './DeleteGroupConfirmDialog'
import { GroupMembersDialog } from './GroupMembersDialog'
import { useUser } from '@/features/common/UserContext'

interface GroupManagerProps {
  onGroupsChange?: () => void
}

export function GroupManager({ onGroupsChange }: GroupManagerProps) {
  const { t } = useTranslation()
  const { user } = useUser()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)

  // Dialog states
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showMembersDialog, setShowMembersDialog] = useState(false)
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)

  useEffect(() => {
    loadGroups()
  }, [])

  const loadGroups = async () => {
    try {
      setLoading(true)
      const response = await listGroups({ page: 1, limit: 100 })
      setGroups(response.items || [])
    } catch (error) {
      console.error('Failed to load groups:', error)
      toast.error('Failed to load groups')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateClick = () => {
    setShowCreateDialog(true)
  }

  const handleEditClick = (group: Group) => {
    setSelectedGroup(group)
    setShowEditDialog(true)
  }

  const handleDeleteClick = (group: Group) => {
    setSelectedGroup(group)
    setShowDeleteDialog(true)
  }

  const handleMembersClick = (group: Group) => {
    setSelectedGroup(group)
    setShowMembersDialog(true)
  }

  const handleSuccess = () => {
    loadGroups()
    onGroupsChange?.()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-text-secondary">{t('common:actions.loading')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">{t('groups:groups.title')}</h2>
          <p className="text-sm text-text-secondary mt-1">{t('groups:groupManager.subtitle')}</p>
        </div>
        <Button onClick={handleCreateClick}>
          <PlusIcon className="w-4 h-4 mr-2" />
          {t('groups:groups.create')}
        </Button>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 bg-surface rounded-lg border border-border">
          <UsersIcon className="w-12 h-12 mx-auto text-text-muted mb-4" />
          <p className="text-text-secondary">{t('groups:groupManager.noGroups')}</p>
          <Button variant="outline" className="mt-4" onClick={handleCreateClick}>
            <PlusIcon className="w-4 h-4 mr-2" />
            {t('groups:groups.create')}
          </Button>
        </div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.name')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.displayName')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.visibility')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.myRole')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.members')}
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-medium text-text-primary">
                    {t('common:actions.edit')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {groups.map(group => (
                  <tr key={group.id} className="hover:bg-surface">
                    <td className="px-4 py-3 text-sm font-medium text-text-primary">
                      {group.name}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {group.display_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <Badge variant={group.visibility === 'public' ? 'success' : 'secondary'}>
                        {t(`groups:groups.${group.visibility}`)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {group.my_role ? (
                        <Badge variant="secondary">
                          {t(`groups:groups.roles.${group.my_role}`)}
                        </Badge>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-text-secondary">
                      {group.member_count || 0}
                    </td>
                    <td className="px-4 py-3 text-sm text-right">
                      <div className="flex items-center justify-end gap-2">
                        {group.my_role === 'Owner' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEditClick(group)}
                            title={t('groups:groupManager.editGroup')}
                          >
                            <PencilIcon className="w-4 h-4" />
                          </Button>
                        )}
                        {(group.my_role === 'Owner' || group.my_role === 'Maintainer') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleMembersClick(group)}
                            title={t('groups:groupManager.manageMembers')}
                          >
                            <UsersIcon className="w-4 h-4" />
                          </Button>
                        )}
                        {group.my_role === 'Owner' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteClick(group)}
                            title={t('groups:groupManager.deleteGroup')}
                          >
                            <TrashIcon className="w-4 h-4 text-error" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <CreateGroupDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onSuccess={handleSuccess}
      />

      <EditGroupDialog
        isOpen={showEditDialog}
        onClose={() => {
          setShowEditDialog(false)
          setSelectedGroup(null)
        }}
        onSuccess={handleSuccess}
        group={selectedGroup}
      />

      <DeleteGroupConfirmDialog
        isOpen={showDeleteDialog}
        onClose={() => {
          setShowDeleteDialog(false)
          setSelectedGroup(null)
        }}
        onSuccess={handleSuccess}
        group={selectedGroup}
      />

      <GroupMembersDialog
        isOpen={showMembersDialog}
        onClose={() => {
          setShowMembersDialog(false)
          setSelectedGroup(null)
        }}
        onSuccess={handleSuccess}
        group={selectedGroup}
        currentUserId={user?.id}
      />
    </div>
  )
}
