import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { X } from 'lucide-react'
import type { ReactNode } from 'react'

export function ProjectBoardSettingsDialog({
  children,
  closeLabel,
  onClose,
  title,
}: {
  children: ReactNode
  closeLabel: string
  onClose(): void
  title: string
}) {
  return (
    <DialogSurface
      onClose={onClose}
      render={
        <div
          aria-label={title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6"
          data-testid="project-board-settings-dialog"
          onMouseDown={event => {
            if (event.currentTarget === event.target) onClose()
          }}
        />
      }
    >
      <div className="flex max-h-[86vh] w-full max-w-[880px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <header className="flex h-14 shrink-0 items-center border-b border-border px-6">
          <h2 className="text-heading-sm font-medium">{title}</h2>
          <ControlButton
            variant="unstyled"
            aria-label={closeLabel}
            className="-mr-2 ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary"
            data-testid="project-board-settings-close"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </ControlButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </DialogSurface>
  )
}
