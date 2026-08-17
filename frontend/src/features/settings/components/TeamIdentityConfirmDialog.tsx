// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useId } from 'react'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface TeamIdentityConfirmDialogProps {
  open: boolean
  title: string
  description: string
  currentName: string
  confirmation: string
  confirmationLabel: string
  cancelLabel: string
  confirmLabel: string
  busy?: boolean
  destructive?: boolean
  highlightDescription?: boolean
  onConfirmationChange: (value: string) => void
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}

export function TeamIdentityConfirmDialog({
  open,
  title,
  description,
  currentName,
  confirmation,
  confirmationLabel,
  cancelLabel,
  confirmLabel,
  busy = false,
  destructive = false,
  highlightDescription = false,
  onConfirmationChange,
  onConfirm,
  onOpenChange,
}: TeamIdentityConfirmDialogProps) {
  const inputId = useId()
  const inputLabelId = useId()

  return (
    <Dialog open={open} onOpenChange={nextOpen => !busy && onOpenChange(nextOpen)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            className={
              highlightDescription
                ? 'flex items-start gap-3 rounded-lg border border-error/30 bg-error/10 p-3 text-left text-error'
                : undefined
            }
          >
            {highlightDescription && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="leading-relaxed">{description}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <p id={inputLabelId} className="select-text text-sm font-medium">
            {confirmationLabel}
          </p>
          <Input
            id={inputId}
            aria-labelledby={inputLabelId}
            value={confirmation}
            onChange={event => onConfirmationChange(event.target.value)}
            autoComplete="off"
            data-testid="team-identity-confirmation-input"
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'primary'}
            onClick={onConfirm}
            disabled={busy || confirmation !== currentName}
            data-testid="confirm-team-identity-change"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
