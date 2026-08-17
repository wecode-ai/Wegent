// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import type { ReactNode } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CardPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
}

/** Shared responsive panel shell for rich asynchronous cards. */
export function CardPanel({ open, onOpenChange, title, description, children }: CardPanelProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
