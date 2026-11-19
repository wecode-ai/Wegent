import { InlinePanel } from '../controls/InlinePanel'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { TemplateDialog } from './TemplateDialog'

/** Reuse the active project dialog for embedded template steps. */
export function TemplatePanel({
  embedded = false,
  footerTarget,
  ...props
}: ComponentProps<typeof TemplateDialog> & {
  embedded?: boolean
  footerTarget?: HTMLElement | null
}) {
  if (!embedded) return <TemplateDialog {...props} />
  return (
    <InlinePanel
      onEscape={() => {
        if (!props.busy) props.onClose()
      }}
      aria-label={props.title}
      className="collaboration-template-detail"
      data-testid="template-inline-detail"
    >
      {props.description && <p className="collaboration-template-muted">{props.description}</p>}
      {props.children}
      {footerTarget ? (
        createPortal(props.footer, footerTarget)
      ) : (
        <footer className="collaboration-template-actions">{props.footer}</footer>
      )}
    </InlinePanel>
  )
}
