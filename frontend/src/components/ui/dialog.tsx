'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const Dialog = DialogPrimitive.Root

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  // Prevent closing dialog when ESC key is pressed
  preventEscapeClose?: boolean
  // Prevent closing dialog when clicking outside
  preventOutsideClick?: boolean
  // Callback to check for unsaved changes before closing, returns true if there are unsaved changes
  onBeforeClose?: () => boolean
  // Callback to close the dialog after user confirms (required when onBeforeClose is provided)
  onConfirmClose?: () => void
  // Custom title for confirmation dialog (optional)
  confirmTitle?: string
  // Custom description for confirmation dialog (optional)
  confirmDescription?: string
  // Hide the close button (X)
  hideCloseButton?: boolean
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(
  (
    {
      className,
      children,
      preventEscapeClose,
      preventOutsideClick,
      onBeforeClose,
      onConfirmClose,
      confirmTitle,
      confirmDescription,
      hideCloseButton,
      onEscapeKeyDown,
      onPointerDownOutside,
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('common')
    const [showConfirmDialog, setShowConfirmDialog] = React.useState(false)
    const [_pendingCloseAction, setPendingCloseAction] = React.useState<
      'escape' | 'outside' | 'button' | null
    >(null)

    // Handle ESC key press
    const handleEscapeKeyDown = React.useCallback(
      (event: KeyboardEvent) => {
        if (preventEscapeClose) {
          event.preventDefault()
          return
        }

        if (onBeforeClose && onBeforeClose()) {
          event.preventDefault()
          setPendingCloseAction('escape')
          setShowConfirmDialog(true)
          return
        }

        onEscapeKeyDown?.(event)
      },
      [preventEscapeClose, onBeforeClose, onEscapeKeyDown]
    )

    // Handle clicking outside
    const handlePointerDownOutside = React.useCallback(
      (event: CustomEvent<{ originalEvent: PointerEvent }>) => {
        if (preventOutsideClick) {
          event.preventDefault()
          return
        }

        if (onBeforeClose && onBeforeClose()) {
          event.preventDefault()
          setPendingCloseAction('outside')
          setShowConfirmDialog(true)
          return
        }

        onPointerDownOutside?.(event)
      },
      [preventOutsideClick, onBeforeClose, onPointerDownOutside]
    )

    // Handle close button click
    const handleCloseButtonClick = React.useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        if (onBeforeClose && onBeforeClose()) {
          event.preventDefault()
          setPendingCloseAction('button')
          setShowConfirmDialog(true)
          return
        }
        // If no onBeforeClose or no unsaved changes, close the dialog directly
        if (onConfirmClose) {
          onConfirmClose()
        }
      },
      [onBeforeClose, onConfirmClose]
    )

    // Handle confirm close
    const handleConfirmClose = React.useCallback(() => {
      setShowConfirmDialog(false)
      setPendingCloseAction(null)
      // Use the onConfirmClose callback if provided, otherwise fall back to dispatching escape key
      if (onConfirmClose) {
        onConfirmClose()
      } else {
        // Fallback: Dispatch a custom event to trigger dialog close
        const dialogContent = document.querySelector('[data-state="open"][role="dialog"]')
        if (dialogContent) {
          // Find the dialog close button and click it, or dispatch escape key
          const event = new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true,
          })
          dialogContent.dispatchEvent(event)
        }
      }
    }, [onConfirmClose])

    // Handle cancel
    const handleCancelClose = React.useCallback(() => {
      setShowConfirmDialog(false)
      setPendingCloseAction(null)
    }, [])

    return (
      <>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            ref={ref}
            className={cn(
              'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-base text-text-primary p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
              className
            )}
            onEscapeKeyDown={handleEscapeKeyDown}
            onPointerDownOutside={handlePointerDownOutside}
            {...props}
          >
            {children}
            {!hideCloseButton &&
              (onBeforeClose ? (
                <button
                  type="button"
                  onClick={handleCloseButtonClick}
                  className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground"
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </button>
              ) : (
                <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogPrimitive.Close>
              ))}
          </DialogPrimitive.Content>
        </DialogPortal>

        <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmTitle || t('dialog.confirm_close_title')}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDescription || t('dialog.confirm_close_description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleCancelClose}>
                {t('dialog.confirm_close_cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleConfirmClose}
                className="bg-primary text-white hover:bg-primary/90 border-primary"
              >
                {t('dialog.confirm_close_confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    )
  }
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
