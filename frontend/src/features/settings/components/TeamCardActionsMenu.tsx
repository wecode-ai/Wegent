// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import {
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  LinkSlashIcon,
  PencilIcon,
  ShareIcon,
  TrashIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline'
import { Loader2, Plug } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'
import type { Group } from '@/types/group'

interface TeamCardActionsMenuProps {
  team: Team
  writableGroups: Group[]
  copying: boolean
  checkingTasks: boolean
  canEdit: boolean
  canAuthorizeChildren: boolean
  canCopy: boolean
  canShare: boolean
  canDelete: boolean
  shared: boolean
  onOpenApi: () => void
  onEdit: () => void
  onAuthorizeChildren: () => void
  onCopy: (targetNamespace: string) => void
  onShare: () => void
  onDelete: () => void
}

const menuIconClassName = 'h-4 w-4 shrink-0'

export function TeamCardActionsMenu({
  team,
  writableGroups,
  copying,
  checkingTasks,
  canEdit,
  canAuthorizeChildren,
  canCopy,
  canShare,
  canDelete,
  shared,
  onOpenApi,
  onEdit,
  onAuthorizeChildren,
  onCopy,
  onShare,
  onDelete,
}: TeamCardActionsMenuProps) {
  const { t } = useTranslation('common')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          title={t('teams.more_actions')}
          aria-label={t('teams.more_actions')}
          className="h-11 w-11 shrink-0 md:h-8 md:w-8"
          data-testid={`team-more-actions-button-${team.id}`}
        >
          <EllipsisHorizontalIcon className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-52"
        data-testid={`team-more-actions-menu-${team.id}`}
      >
        <DropdownMenuItem
          onSelect={onOpenApi}
          className="gap-2"
          data-testid={`team-api-call-menu-item-${team.id}`}
        >
          <Plug className={menuIconClassName} />
          {t('teams.api_call.action')}
        </DropdownMenuItem>

        {(canEdit || canAuthorizeChildren || canCopy || canShare) && <DropdownMenuSeparator />}

        {canEdit && (
          <DropdownMenuItem onSelect={onEdit} className="gap-2">
            <PencilIcon className={menuIconClassName} />
            {t('teams.edit')}
          </DropdownMenuItem>
        )}

        {canAuthorizeChildren && (
          <DropdownMenuItem
            onSelect={onAuthorizeChildren}
            className="gap-2"
            data-testid={`team-child-auth-button-${team.id}`}
          >
            <UserGroupIcon className={menuIconClassName} />
            {t('teams.child_authorization.action')}
          </DropdownMenuItem>
        )}

        {canCopy && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={copying}
              className="gap-2"
              data-testid={`copy-team-button-${team.id}`}
            >
              {copying ? (
                <Loader2 className={`${menuIconClassName} animate-spin`} />
              ) : (
                <DocumentDuplicateIcon className={menuIconClassName} />
              )}
              {t('teams.copy')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-64 w-48 overflow-y-auto">
              <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                {t('teams.copy_to_label')}
              </div>
              <DropdownMenuItem
                onSelect={() => onCopy('default')}
                className="gap-2 text-xs"
                data-testid={`copy-team-to-personal-${team.id}`}
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z"
                    />
                  </svg>
                </span>
                <span className="truncate">{t('teams.copy_to_personal')}</span>
              </DropdownMenuItem>
              {writableGroups.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  {writableGroups.map(group => {
                    const label = group.display_name || group.name

                    return (
                      <DropdownMenuItem
                        key={group.name}
                        onSelect={() => onCopy(group.name)}
                        className="gap-2 text-xs"
                        data-testid={`copy-team-to-group-${team.id}-${group.name}`}
                      >
                        <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-primary/10 text-[9px] font-semibold text-primary">
                          {label.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="truncate">{label}</span>
                      </DropdownMenuItem>
                    )
                  })}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {canShare && (
          <DropdownMenuItem onSelect={onShare} className="gap-2">
            <ShareIcon className={menuIconClassName} />
            {t('teams.share.title')}
          </DropdownMenuItem>
        )}

        {canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} disabled={checkingTasks} danger className="gap-2">
              {shared ? (
                <LinkSlashIcon className={menuIconClassName} />
              ) : (
                <TrashIcon className={menuIconClassName} />
              )}
              {t(shared ? 'teams.unbind' : 'teams.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
