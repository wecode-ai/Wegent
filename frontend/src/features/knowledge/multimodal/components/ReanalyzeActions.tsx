// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-analyze UI fragments for multimodal documents.
 *
 * Two export variants matching the two places DocumentItem renders actions:
 * - ReanalyzeDropdownItem: for the dropdown menu
 * - ReanalyzeIconButton: for the inline icon button row
 *
 * Both are conditional (render null when canReanalyze is false), so the
 * open-source DocumentItem just places them unconditionally and they
 * self-hide for non-multimodal docs.
 */

import { PencilLine } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown'
import { useTranslation } from '@/hooks/useTranslation'

/** Dropdown menu item for "modify prompt & re-analyze". Renders null if !show. */
export function ReanalyzeDropdownItem({
  show,
  disabled,
  onClick,
}: {
  show: boolean
  disabled?: boolean
  onClick: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation('knowledge')
  if (!show) return null
  return (
    <DropdownMenuItem onClick={onClick} disabled={disabled}>
      <PencilLine className="w-3.5 h-3.5 mr-2" />
      {t('document.document.reanalyze')}
    </DropdownMenuItem>
  )
}

/** Inline icon button for re-analyze. Renders null if !show. */
export function ReanalyzeIconButton({
  show,
  disabled,
  documentId,
  onClick,
}: {
  show: boolean
  disabled?: boolean
  documentId: number
  onClick: (e: React.MouseEvent) => void
}) {
  const { t } = useTranslation('knowledge')
  if (!show) return null
  return (
    <button
      className="p-1.5 rounded-md text-text-muted hover:text-primary hover:bg-primary/10 transition-colors"
      onClick={onClick}
      disabled={disabled}
      title={t('document.document.reanalyze')}
      data-testid={`reanalyze-button-${documentId}`}
    >
      <PencilLine className="w-4 h-4" />
    </button>
  )
}
