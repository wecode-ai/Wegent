// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Canvas Toggle Button
 */

'use client'

import React from 'react'
import { FileCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

interface CanvasToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
}

export function CanvasToggle({ enabled, onToggle }: CanvasToggleProps) {
  const { t } = useTranslation('canvas')

  return (
    <Button
      variant={enabled ? 'default' : 'ghost'}
      size="sm"
      onClick={() => onToggle(!enabled)}
      className="gap-2"
    >
      <FileCode className="h-4 w-4" />
      <span>{t('toggle', enabled ? 'Close Canvas' : 'Open Canvas')}</span>
    </Button>
  )
}
