import { isDesktopRuntime } from '@/lib/runtime-environment'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false

  return Boolean(
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
  )
}

export function installDesktopNavigationGuard(target: Document = document): () => void {
  if (!isDesktopRuntime()) return () => undefined

  const preventBackspaceNavigation = (event: KeyboardEvent) => {
    if (event.key !== 'Backspace' || isEditableTarget(event.target)) return
    event.preventDefault()
  }

  target.addEventListener('keydown', preventBackspaceNavigation)

  return () => {
    target.removeEventListener('keydown', preventBackspaceNavigation)
  }
}
