// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useRef } from 'react'
import { FolderOutput, MoreHorizontal, Pencil, Shield, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'

export function KnowledgeBaseActions({
  kbId,
  mobile = false,
  onPermissions,
  onMigrate,
  onEdit,
  onDelete,
}: {
  kbId: number
  mobile?: boolean
  onPermissions?: () => void
  onMigrate?: () => void
  onEdit?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation('knowledge')
  const moreTrigger = useRef<HTMLButtonElement>(null)
  const pendingAction = useRef<(() => void) | null>(null)
  const actions = [
    {
      id: 'permission',
      label: 'document.navigation.permissionDetails',
      onClick: onPermissions,
      Icon: Shield,
    },
    { id: 'edit', label: 'document.table.edit', onClick: onEdit, Icon: Pencil },
  ]
  const moreActions = [
    ...(mobile ? actions : []),
    { id: 'migrate', label: 'document.migrate.title', onClick: onMigrate, Icon: FolderOutput },
    { id: 'delete', label: 'document.table.delete', onClick: onDelete, Icon: Trash2 },
  ].filter(action => action.onClick)
  return (
    <div className="flex flex-nowrap items-center justify-end gap-0">
      {!mobile &&
        actions
          .filter(action => action.onClick)
          .map(({ id, label, onClick, Icon }) => (
            <Button
              key={id}
              variant="ghost"
              size="icon"
              className="h-11 w-11 min-h-11 min-w-11 shrink-0 md:h-8 md:w-8 md:min-h-8 md:min-w-8"
              data-testid={`${id}-kb-${kbId}`}
              aria-label={t(label)}
              title={t(label)}
              onClick={event => {
                event.stopPropagation()
                onClick?.()
              }}
            >
              <Icon className="h-3.5 w-3.5" />
            </Button>
          ))}
      {moreActions.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              ref={moreTrigger}
              variant="ghost"
              size="icon"
              className="h-11 w-11 min-h-11 min-w-11 shrink-0 md:h-8 md:w-8 md:min-h-8 md:min-w-8"
              data-testid={`more-kb-${kbId}`}
              aria-label={t('document.table.more')}
              title={t('document.table.more')}
              onClick={event => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onClick={event => event.stopPropagation()}
            onCloseAutoFocus={event => {
              const action = pendingAction.current
              if (!action) return
              event.preventDefault()
              pendingAction.current = null
              // Let the menu release its focus scope before opening another dialog.
              queueMicrotask(() => {
                if (!moreTrigger.current?.isConnected) return
                moreTrigger.current.focus()
                action()
              })
            }}
          >
            {moreActions.map(({ id, label, onClick, Icon }) => (
              <DropdownMenuItem
                key={id}
                className="min-h-11 gap-2 md:min-h-8 md:py-1"
                danger={id === 'delete'}
                data-testid={`${id}-kb-${kbId}`}
                onSelect={() => {
                  pendingAction.current = onClick ?? null
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
