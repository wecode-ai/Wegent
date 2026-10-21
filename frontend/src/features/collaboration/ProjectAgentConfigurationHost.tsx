// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WebAgentResourceForm } from './WebAgentResourceForm'

export const webProjectAgentConfigurationHost: ProjectAgentConfigurationHost = {
  supportsExistingAgentSelection: true,
  renderAgentCreator(props) {
    return <WebAgentResourceForm {...props} />
  },
  renderDialog({ busy, children, closeLabel, description, onClose, testIds, title }) {
    return (
      <Dialog
        open
        onOpenChange={open => {
          if (!open && !busy) onClose()
        }}
      >
        <DialogContent
          className="flex max-h-[90dvh] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-[20px] p-0 sm:max-w-[520px] sm:rounded-[20px]"
          closeButtonProps={{
            'aria-label': closeLabel,
            className:
              'right-3 top-3 flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted md:right-4 md:top-4 md:h-8 md:w-8',
            'data-testid': testIds.close,
            disabled: busy,
          }}
          data-testid={testIds.dialog}
          overlayProps={{ 'data-testid': testIds.backdrop, className: 'bg-black/[0.14]' }}
          onOpenAutoFocus={event => {
            const search =
              event.target instanceof HTMLElement
                ? event.target.querySelector<HTMLInputElement>('input[type="search"]')
                : null
            if (search) {
              event.preventDefault()
              search.focus()
            }
          }}
          preventEscapeClose={busy}
          preventOutsideClick={busy}
        >
          <DialogHeader className="space-y-1 px-5 pb-4 pr-12 pt-5">
            <DialogTitle className="text-lg leading-6">{title}</DialogTitle>
            <DialogDescription className="text-sm leading-5 text-text-muted">
              {description}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col">{children}</div>
        </DialogContent>
      </Dialog>
    )
  },
}
