// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { canManageNamespace } from '@/utils/namespace-permissions'
import { clearNamespaceRoleMapCache } from '@/features/knowledge/document/hooks/useNamespaceRoleMap'

interface GroupManagerProps {
  onGroupsChange?: () => void
}

export function GroupManager({ onGroupsChange }: GroupManagerProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const { user } = useUser()
  const isAdmin = user?.role === 'admin'
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

  // Navigate to group settings page
  const handleGroupClick = (group: Group) => {
    router.push(`/settings?section=groups&tab=group-team&group=${encodeURIComponent(group.name)}`)
  }

  const handleSuccess = () => {
    clearNamespaceRoleMapCache()
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
            <table className="w-full min-w-[880px]">
              <thead className="bg-muted">
                <tr>
                  <th className="min-w-[240px] px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.name')}
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium text-text-primary">
                    {t('groups:groups.description')}
                  </th>
                  <th className="min-w-[110px] px-4 py-3 text-left text-sm font-medium text-text-primary whitespace-nowrap">
                    {t('groups:groups.visibility')}
                  </th>
                  <th className="min-w-[110px] px-4 py-3 text-left text-sm font-medium text-text-primary whitespace-nowrap">
                    {t('groups:groups.level')}
                  </th>
                  <th className="min-w-[120px] px-4 py-3 text-left text-sm font-medium text-text-primary whitespace-nowrap">
                    {t('groups:groups.myRole')}
                  </th>
                  <th className="min-w-[96px] px-4 py-3 text-left text-sm font-medium text-text-primary whitespace-nowrap">
                    {t('groups:groups.members')}
                  </th>
                  <th className="w-[120px] min-w-[120px] px-4 py-3 text-center text-sm font-medium text-text-primary">
                    {t('groups:groupMembers.actions')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {groups.map(group => {
                  const canManage = canManageNamespace({
                    namespaceRole: group.my_role,
                    isAdmin,
                  })

                  return (
                    <tr key={group.id} className="hover:bg-surface">
                      <td className="min-w-[240px] px-4 py-3 text-sm">
                        <button
                          onClick={() => handleGroupClick(group)}
                          className="block max-w-[240px] truncate text-left font-medium text-primary transition-colors hover:text-primary/80 hover:underline"
                          title={group.display_name || group.name}
                        >
                          {group.display_name || group.name}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-sm text-text-secondary">
                        {group.description ? (
                          <span
                            className="block max-w-[280px] truncate lg:max-w-[360px]"
                            title={group.description}
                          >
                            {group.description}
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="min-w-[110px] px-4 py-3 text-sm whitespace-nowrap">
                        <Badge variant={group.visibility === 'public' ? 'success' : 'secondary'}>
                          {t(`groups:groups.${group.visibility}`)}
                        </Badge>
                      </td>
                      <td className="min-w-[110px] px-4 py-3 text-sm whitespace-nowrap">
                        {group.level === 'organization' ? (
                          <Badge variant="default">{t('groups:groups.levels.organization')}</Badge>
                        ) : (
                          <Badge variant="secondary">{t('groups:groups.levels.group')}</Badge>
                        )}
                      </td>
                      <td className="min-w-[120px] px-4 py-3 text-sm whitespace-nowrap">
                        {group.my_role ? (
                          <Badge variant="secondary">
                            {t(`groups:groups.roles.${group.my_role}`)}
                          </Badge>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="min-w-[96px] px-4 py-3 text-sm text-text-secondary whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleMembersClick(group)}
                          title={t('groups:groupManager.viewMembers')}
                          aria-label={`${t('groups:groupManager.viewMembers')} ${group.display_name || group.name}, ${t('groups:groups.members')}: ${group.member_count || 0}`}
                          data-testid={`group-members-button-${group.id}`}
                          className="inline-flex items-center gap-2 rounded-md px-2 py-1 -mx-2 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
                        >
                          <UsersIcon className="w-4 h-4" />
                          <span>{group.member_count || 0}</span>
                        </button>
                      </td>
                      <td className="w-[120px] min-w-[120px] px-4 py-3 text-sm">
                        <div className="flex items-center justify-center gap-2">
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEditClick(group)}
                              title={t('groups:groupManager.editGroup')}
                              data-testid={`group-edit-button-${group.id}`}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                          )}
                          {canManage && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(group)}
                              title={t('groups:groupManager.deleteGroup')}
                              data-testid={`group-delete-button-${group.id}`}
                            >
                              <TrashIcon className="w-4 h-4 text-error" />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
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
