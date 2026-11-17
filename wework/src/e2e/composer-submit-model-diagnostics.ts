import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

/** Observe the submitting pane in the key event's turn, without reading its draft. */
export function recordComposerSubmitModel(element: HTMLElement, event: KeyboardEventInit): void {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    !element.matches('[data-testid="chat-message-input"][contenteditable="true"]')
  ) {
    return
  }
  const pane = element.closest<HTMLElement>('[data-testid="desktop-workbench-main"]')
  if (!pane) return
  const buttons = pane.querySelectorAll<HTMLElement>('[data-testid="model-selector-button"]')
  logRuntimeTaskCreateStage('e2e-composer-submit-model', {
    activePane: pane.dataset.activeWorkbenchPane === 'true',
    modelControlCount: buttons.length,
    models: Array.from(buttons)
      .slice(0, 8)
      .map(button => ({
        label: button.textContent?.trim().slice(0, 160) ?? '',
        providerId: button.getAttribute('data-model-provider-id')?.slice(0, 160) ?? null,
      })),
  })
}
