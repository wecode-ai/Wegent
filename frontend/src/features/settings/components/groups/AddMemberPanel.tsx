// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { UserPlusIcon } from 'lucide-react'
import { toast } from 'sonner'
import type { Group, GroupRole } from '@/types/group'
import type { SearchUser } from '@/types/api'
import type { GroupExtensionConfig } from '@/features/groups/extension-loader'
import { addGroupMemberByUsername } from '@/apis/groups'
import { BASE_ROLES, ASSIGNABLE_ROLES } from '@/types/base-role'

interface AddUserFormProps {
  selectedUsers: SearchUser[]
  onSelectedUsersChange: (users: SearchUser[]) => void
  selectedRole: GroupRole
  onRoleChange: (role: GroupRole) => void
  editableRoleOptions: GroupRole[]
  isSubmitting: boolean
  onSubmit: () => void
  onCancel: () => void
  showTitle?: boolean
}

function AddUserForm({
  selectedUsers,
  onSelectedUsersChange,
  selectedRole,
  onRoleChange,
  editableRoleOptions,
  isSubmitting,
  onSubmit,
  onCancel,
  showTitle = true,
}: AddUserFormProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-3">
      {showTitle && <h3 className="text-sm font-medium">{t('groups:groups.actions.addMember')}</h3>}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <UserSearchSelect
            selectedUsers={selectedUsers}
            onSelectedUsersChange={onSelectedUsersChange}
            disabled={isSubmitting}
            placeholder={t('groups:groupMembers.searchPlaceholder')}
          />
        </div>
        <div>
          <Select value={selectedRole} onValueChange={(value: GroupRole) => onRoleChange(value)}>
            <SelectTrigger data-testid="add-member-role-select">
              <SelectValue placeholder={t(`groups:groups.roles.${selectedRole}`)}>
                {t(`groups:groups.roles.${selectedRole}`)}
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
        </div>
      </div>

      {/* Role Permission Description */}
      <div className="p-3 bg-muted rounded-md text-xs text-text-muted">
        <strong>{t(`groups:groups.roles.${selectedRole}`)}：</strong>
        {t(`groups:groupMembers.roleDescriptions.${selectedRole}`)}
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={isSubmitting}
          data-testid="add-member-cancel-button"
        >
          {t('common:actions.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={selectedUsers.length === 0 || isSubmitting}
          data-testid="add-member-submit-button"
        >
          <UserPlusIcon className="w-4 h-4 mr-2" />
          {isSubmitting
            ? t('groups:groupMembers.adding')
            : t('groups:groupMembers.addCount', { count: selectedUsers.length })}
        </Button>
      </div>
    </div>
  )
}

interface AddMemberPanelProps {
  group: Group
  extensionConfig: GroupExtensionConfig | null
  myRole?: GroupRole
  existingMemberUsernames: string[]
  defaultTab?: 'addUser' | 'addEntity'
  onAddUserSuccess: () => void
  onAddEntitySuccess: () => void
  onCancel: () => void
}

export function AddMemberPanel({
  group,
  extensionConfig,
  myRole,
  existingMemberUsernames,
  defaultTab,
  onAddUserSuccess,
  onAddEntitySuccess,
  onCancel,
}: AddMemberPanelProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<'addUser' | 'addEntity'>(defaultTab || 'addUser')
  const [selectedUsers, setSelectedUsers] = useState<SearchUser[]>([])
  const [selectedRole, setSelectedRole] = useState<GroupRole>('Reporter')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const editableRoleOptions = myRole === 'Owner' ? BASE_ROLES : ASSIGNABLE_ROLES

  const handleAddMembers = async () => {
    if (selectedUsers.length === 0) return

    setIsSubmitting(true)
    let successCount = 0
    let alreadyMemberCount = 0
    const errors: string[] = []

    try {
      for (const user of selectedUsers) {
        if (existingMemberUsernames.includes(user.user_name)) {
          alreadyMemberCount++
          continue
        }

        try {
          const result = await addGroupMemberByUsername(group.name, user.user_name, selectedRole)
          if (result.success) {
            successCount++
          } else {
            errors.push(
              `${user.user_name}: ${result.message || t('groups:groupMembers.addMemberFailed')}`
            )
          }
        } catch (error: unknown) {
          const err = error as { message?: string }
          errors.push(
            `${user.user_name}: ${err?.message || t('groups:groupMembers.addMemberFailed')}`
          )
        }
      }

      if (successCount > 0) {
        toast.success(t('groups:groupMembers.addMembersSuccess', { count: successCount }))
      }
      if (alreadyMemberCount > 0) {
        toast.info(t('groups:groupMembers.alreadyMembers', { count: alreadyMemberCount }))
      }
      if (errors.length > 0) {
        errors.forEach(err => toast.error(err))
      }

      setSelectedRole('Reporter')
      setSelectedUsers([])
      onAddUserSuccess()
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div
      className="p-4 border border-border rounded-lg bg-surface space-y-3"
      data-testid="add-member-panel"
    >
      {extensionConfig ? (
        <Tabs
          value={activeTab}
          onValueChange={(value: string) => setActiveTab(value as 'addUser' | 'addEntity')}
        >
          <TabsList>
            <TabsTrigger value="addUser" data-testid="add-member-user-tab">
              {t('groups:groupMembers.addUserTab')}
            </TabsTrigger>
            <TabsTrigger value="addEntity" data-testid="add-member-entity-tab">
              {extensionConfig.addTabLabel}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="addUser">
            <AddUserForm
              selectedUsers={selectedUsers}
              onSelectedUsersChange={setSelectedUsers}
              selectedRole={selectedRole}
              onRoleChange={setSelectedRole}
              editableRoleOptions={editableRoleOptions}
              isSubmitting={isSubmitting}
              onSubmit={handleAddMembers}
              onCancel={onCancel}
              showTitle={false}
            />
          </TabsContent>
          <TabsContent value="addEntity">
            <extensionConfig.addForm
              key={`add-${group.name}`}
              groupName={group.name}
              onSuccess={onAddEntitySuccess}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <AddUserForm
          selectedUsers={selectedUsers}
          onSelectedUsersChange={setSelectedUsers}
          selectedRole={selectedRole}
          onRoleChange={setSelectedRole}
          editableRoleOptions={editableRoleOptions}
          isSubmitting={isSubmitting}
          onSubmit={handleAddMembers}
          onCancel={onCancel}
        />
      )}
    </div>
  )
}
