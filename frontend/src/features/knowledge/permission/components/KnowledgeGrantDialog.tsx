// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode, RefObject } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'

/** Shared dialog shell for the existing public and internal grant forms. */
export function KnowledgeGrantDialog({
  onClose,
  trigger,
  children,
}: {
  onClose: () => void
  trigger: RefObject<HTMLButtonElement | null>
  children: ReactNode
}) {
  const { t } = useTranslation('knowledge')
  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="flex max-h-[90dvh] w-[calc(100%_-_1rem)] min-w-0 max-w-xl flex-col overflow-hidden max-md:p-4"
        onCloseAutoFocus={event => {
          event.preventDefault()
          trigger.current?.focus()
        }}
        closeButtonProps={{
          className: 'flex min-h-11 min-w-11 items-center justify-center',
          'data-testid': 'close-add-collaborator',
        }}
      >
        <DialogHeader className="shrink-0 pr-10 text-left">
          <DialogTitle>{t('document.permission.addCollaborator')}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="shrink-0">
          {t('document.creation.selectTargets')}
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}
