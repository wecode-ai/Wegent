import { AlertDialog, AlertDialogContent } from '@ui-sdk/react/alert-dialog'
import {
  Dialog,
  DialogContent,
  type DialogFinalFocus,
  type DialogInitialFocus,
} from '@ui-sdk/react/dialog'
import { cloneElement, useRef, type ReactElement, type ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'

interface DialogSurfaceProps {
  children: ReactNode
  render: ReactElement<{ children?: ReactNode; className?: string }>
  onClose?(): void
  active?: boolean
  /** Keep the content mounted while relinquishing the overlay and its focus ownership. */
  suspended?: boolean
  modal?: boolean
  inline?: boolean
  kind?: 'dialog' | 'alertdialog'
  initialFocus?: DialogInitialFocus
  finalFocus?: DialogFinalFocus
}

export function DialogSurface({
  children,
  render,
  onClose,
  active = true,
  suspended,
  modal = true,
  inline = true,
  kind = 'dialog',
  initialFocus,
  finalFocus,
}: DialogSurfaceProps) {
  const opener = useRef(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  )
  // Embedded panels keep their parent layer's focus ownership.
  if (!active) return cloneElement(render, {}, children)
  const Content = kind === 'alertdialog' ? AlertDialogContent : DialogContent
  const onOpenChange = (open: boolean, details: { cancel(): void }) => {
    if (!open && !suspended) {
      details.cancel()
      onClose?.()
    }
  }
  const content = (
    <Content
      inline={inline}
      keepMounted={suspended !== undefined}
      render={
        inline
          ? render
          : cloneElement(render, {
              className: cn(
                'fixed inset-0 m-auto h-fit max-h-[calc(100dvh-2rem)]',
                render.props.className
              ),
            })
      }
      initialFocus={initialFocus}
      finalFocus={
        suspended
          ? 'none'
          : (finalFocus ?? (() => (opener.current?.isConnected ? opener.current : null)))
      }
    >
      {children}
    </Content>
  )
  return kind === 'alertdialog' ? (
    <AlertDialog open={!suspended} dismissible={Boolean(onClose)} onOpenChange={onOpenChange}>
      {content}
    </AlertDialog>
  ) : (
    <Dialog
      open={!suspended}
      dismissible={Boolean(onClose)}
      modal={modal}
      closeOnOutsidePress={false}
      onOpenChange={onOpenChange}
    >
      {content}
    </Dialog>
  )
}
