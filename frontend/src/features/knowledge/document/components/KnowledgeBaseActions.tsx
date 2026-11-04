// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { FolderOutput, Pencil, Shield, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function KnowledgeBaseActions({
  kbId,
  onPermissions,
  onMigrate,
  onEdit,
  onDelete,
}: {
  kbId: number
  onPermissions?: () => void
  onMigrate?: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation('knowledge')
  const actions = [
    {
      id: 'permission',
      label: 'document.navigation.permissionDetails',
      onClick: onPermissions,
      Icon: Shield,
    },
    { id: 'migrate', label: 'document.migrate.title', onClick: onMigrate, Icon: FolderOutput },
    { id: 'edit', label: 'document.table.edit', onClick: onEdit, Icon: Pencil },
    { id: 'delete', label: 'document.table.delete', onClick: onDelete, Icon: Trash2 },
  ]
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {actions
        .filter(action => action.onClick)
        .map(({ id, label, onClick, Icon }) => (
          <Button
            key={id}
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11"
            data-testid={`${id}-kb-${kbId}`}
            aria-label={t(label)}
            title={t(label)}
            onClick={event => {
              event.stopPropagation()
              onClick?.()
            }}
          >
            <Icon className="h-4 w-4" />
          </Button>
        ))}
    </div>
  )
}
