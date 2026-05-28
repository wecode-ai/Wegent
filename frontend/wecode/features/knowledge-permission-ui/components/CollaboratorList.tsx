// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Search, Plus } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { CollaboratorItem } from './CollaboratorItem'
import { AddCollaboratorDialog } from './AddCollaboratorDialog'
import { useCollaborators } from '../hooks/useCollaborators'

const ENTITY_TYPE_KEYS = [
  { key: 'user', labelKey: 'document.permission.collaboratorType.user' },
  { key: 'namespace', labelKey: 'document.permission.collaboratorType.group' },
  { key: 'org_department', labelKey: 'document.permission.collaboratorType.department' },
] as const

interface CollaboratorListProps {
  kbId: number
}

export function CollaboratorList({ kbId }: CollaboratorListProps) {
  const { t } = useTranslation('knowledge')
  const {
    filteredCollaborators,
    groupedCollaborators,
    loading,
    error,
    searchQuery,
    setSearchQuery,
    refresh,
    updateRole,
    remove,
    myRole,
  } = useCollaborators(kbId)

  const [addDialogOpen, setAddDialogOpen] = useState(false)

  return (
    <div className="flex flex-col h-full" data-testid="collaborator-list">
      {/* Header actions */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            className="pl-9 h-8 text-sm"
            placeholder={t('document.permission.searchCollaborators')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            data-testid="search-collaborators-input"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddDialogOpen(true)}
          data-testid="add-collaborator-button"
        >
          <Plus className="w-4 h-4 mr-1.5" />
          {t('document.permission.addCollaborator')}
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {error && <div className="text-sm text-red-500 text-center py-4">{error}</div>}

        {loading && filteredCollaborators.length === 0 && (
          <div className="text-sm text-text-secondary text-center py-4">
            {t('document.permission.loading')}
          </div>
        )}

        {!loading && filteredCollaborators.length === 0 && searchQuery && (
          <div className="text-sm text-text-secondary text-center py-4">
            {t('document.permission.noMatchingResults')}
          </div>
        )}

        {!loading && filteredCollaborators.length === 0 && !searchQuery && (
          <div className="text-sm text-text-secondary text-center py-4">
            {t('document.permission.noCollaborators')}
          </div>
        )}

        {/* All collaborators main title */}
        {filteredCollaborators.length > 0 && (
          <h3 className="text-base font-medium text-text-primary mb-2 px-3">
            {t('document.permission.allCollaborators', {
              count: filteredCollaborators.length,
            })}
          </h3>
        )}

        {/* Grouped collaborators */}
        {ENTITY_TYPE_KEYS.map(({ key, labelKey }) => {
          const items = groupedCollaborators[key]
          if (!items || items.length === 0) return null
          return (
            <div key={key} className="mb-3">
              <h4 className="text-sm font-medium text-text-muted mb-1 px-3">
                {t('document.permission.entitySectionCount', {
                  label: t(labelKey),
                  count: items.length,
                })}
              </h4>
              <div className="space-y-0">
                {items.map(collaborator => (
                  <CollaboratorItem
                    key={collaborator.id}
                    collaborator={collaborator}
                    myRole={myRole}
                    onRoleChange={updateRole}
                    onRemove={remove}
                    loading={loading}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Add collaborator dialog */}
      <AddCollaboratorDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        kbId={kbId}
        onSuccess={() => refresh()}
      />
    </div>
  )
}
