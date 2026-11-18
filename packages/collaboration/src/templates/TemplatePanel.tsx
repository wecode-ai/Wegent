// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ComponentProps } from 'react'
import { createPortal } from 'react-dom'
import { useDialogKeyboard } from '../controls/useDialogKeyboard'
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
  const ref = useDialogKeyboard<HTMLElement>(
    () => {
      if (!props.busy) props.onClose()
    },
    embedded,
    undefined,
    false
  )
  if (!embedded) return <TemplateDialog {...props} />
  return (
    <section
      ref={ref}
      tabIndex={-1}
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
    </section>
  )
}
