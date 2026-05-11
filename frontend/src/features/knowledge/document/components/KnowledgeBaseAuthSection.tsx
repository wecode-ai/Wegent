// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { Shield, User, Users, ChevronDown, ChevronRight, X } from 'lucide-react'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/components/ui/collapsible'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { UserSearchSelect } from '@/components/common/UserSearchSelect'
import { listGroups } from '@/apis/groups'
import { useTranslation } from '@/hooks/useTranslation'
import { ASSIGNABLE_ROLES } from '@/types/base-role'
import type { MemberRole, InitialMember } from '@/types/knowledge'
import type { SearchUser } from '@/types/api'
import type { Group } from '@/types/group'

export interface AuthEntry {
  id: string
  label: string
  entityType: 'user' | 'namespace'
  entityId: string
  role: MemberRole
}

interface KnowledgeBaseAuthSectionProps {
  value: AuthEntry[]
  onChange: (entries: AuthEntry[]) => void
}

export function KnowledgeBaseAuthSection({
  value,
  onChange,
}: KnowledgeBaseAuthSectionProps) {
  const { t } = useTranslation('knowledge')
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'user' | 'namespace'>('user')

  const userEntries = value.filter(e => e.entityType === 'user')
  const namespaceEntries = value.filter(e => e.entityType === 'namespace')

  const addUserEntry = (user: SearchUser, role: MemberRole) => {
    const exists = userEntries.some(e => e.entityId === String(user.id))
    if (exists) return
    onChange([
      ...value,
      {
        id: `user-${user.id}`,
        label: user.user_name,
        entityType: 'user',
        entityId: String(user.id),
        role,
      },
    ])
  }

  const removeEntry = (id: string) => {
    onChange(value.filter(e => e.id !== id))
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-text-primary hover:text-primary transition-colors w-full text-left"
          data-testid="auth-section-trigger"
        >
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          <Shield className="w-4 h-4" />
          {t('document.permission.authorization') || '授权'}
          {(userEntries.length + namespaceEntries.length) > 0 && (
            <span className="bg-primary/10 text-primary px-2 py-0.5 rounded-full text-xs">
              {userEntries.length + namespaceEntries.length}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-3">
        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            type="button"
            onClick={() => setActiveTab('user')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'user'
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
            data-testid="auth-tab-user"
          >
            <User className="w-3.5 h-3.5" />
            {t('document.permission.individual') || '个人'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('namespace')}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === 'namespace'
                ? 'border-primary text-primary'
                : 'border-transparent text-text-muted hover:text-text-primary'
            }`}
            data-testid="auth-tab-namespace"
          >
            <Users className="w-3.5 h-3.5" />
            {t('document.permission.namespace') || '群组'}
          </button>
        </div>

        {/* User tab content */}
        {activeTab === 'user' && (
          <UserAuthPanel
            existingEntries={userEntries}
            onAdd={addUserEntry}
            onRemove={removeEntry}
          />
        )}

        {/* Namespace tab content */}
        {activeTab === 'namespace' && (
          <NamespaceAuthPanel
            existingEntries={namespaceEntries}
            onAdd={(entry) => {
              const exists = namespaceEntries.some(e => e.entityId === entry.entityId)
              if (exists) return
              onChange([...value, entry])
            }}
            onRemove={removeEntry}
          />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

// User panel component
interface UserAuthPanelProps {
  existingEntries: AuthEntry[]
  onAdd: (user: SearchUser, role: MemberRole) => void
  onRemove: (id: string) => void
}

function UserAuthPanel({ existingEntries, onAdd, onRemove }: UserAuthPanelProps) {
  const { t } = useTranslation('knowledge')

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <Label className="text-xs">
            {t('document.permission.userName') || '用户'}
          </Label>
          <UserSearchSelect
            selectedUsers={[]}
            onSelectedUsersChange={(users) => {
              if (users.length > 0) {
                const user = users[users.length - 1]
                onAdd({ id: user.id, user_name: user.user_name }, 'Reporter' as MemberRole)
              }
            }}
            placeholder={t('document.permission.searchUserPlaceholder') || '搜索用户...'}
            multiple={false}
          />
        </div>
      </div>

      {existingEntries.length > 0 && (
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {existingEntries.map(entry => (
            <div key={entry.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
              <span className="text-sm truncate flex-1">{entry.label}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-text-muted hover:text-error flex-shrink-0 ml-2"
                onClick={() => onRemove(entry.id)}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Namespace panel component
interface NamespaceAuthPanelProps {
  existingEntries: AuthEntry[]
  onAdd: (entry: AuthEntry) => void
  onRemove: (id: string) => void
}

function NamespaceAuthPanel({ existingEntries, onAdd, onRemove }: NamespaceAuthPanelProps) {
  const { t } = useTranslation('knowledge')
  const [groups, setGroups] = useState<Group[]>([])
  const [fetching, setFetching] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const [selectedRole, setSelectedRole] = useState<MemberRole>('Reporter' as MemberRole)

  useEffect(() => {
    fetchGroups()
  }, [])

  const fetchGroups = async () => {
    setFetching(true)
    try {
      const result = await listGroups({ limit: 100 })
      setGroups(result.items || [])
    } catch (_err) {
      // silently fail
    } finally {
      setFetching(false)
    }
  }

  const handleAdd = () => {
    if (!selectedGroupId) return
    const group = groups.find(g => String(g.id) === selectedGroupId)
    if (!group) return
    onAdd({
      id: `namespace-${group.id}`,
      label: group.display_name || group.name,
      entityType: 'namespace',
      entityId: String(group.id),
      role: selectedRole,
    })
    setSelectedGroupId('')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-2">
          <Label className="text-xs">
            {t('document.permission.selectGroup') || '选择群组'}
          </Label>
          {fetching ? (
            <div className="flex items-center py-2">
              <Spinner className="w-4 h-4" />
            </div>
          ) : (
            <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
              <SelectTrigger className="w-full h-10 min-w-[44px]">
                <SelectValue placeholder={t('document.permission.selectGroupPlaceholder') || '请选择群组'} />
              </SelectTrigger>
              <SelectContent>
                {groups.map(group => (
                  <SelectItem key={group.id} value={String(group.id)}>
                    {group.display_name || group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="space-y-2">
          <Label className="text-xs">
            {t('document.permission.role.label') || '角色'}
          </Label>
          <Select value={selectedRole} onValueChange={v => setSelectedRole(v as MemberRole)}>
            <SelectTrigger className="w-28 h-10 min-w-[44px]">
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
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-6 h-10"
          disabled={!selectedGroupId}
          onClick={handleAdd}
          data-testid="auth-add-namespace"
        >
          {t('document.permission.add') || '添加'}
        </Button>
      </div>

      {existingEntries.length > 0 && (
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {existingEntries.map(entry => (
            <div key={entry.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm truncate">{entry.label}</span>
                <span className="text-xs text-text-muted flex-shrink-0">
                  {t(`document.permission.role.${entry.role}`)}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-text-muted hover:text-error flex-shrink-0 ml-2"
                onClick={() => onRemove(entry.id)}
              >
                <X className="w-3 h-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
