export interface ComposerSubmitOptions {
  guideWhenBusy?: boolean
  interruptWhenBusy?: boolean
}

export type ComposerFollowUpBehavior = 'queue' | 'guide'

export interface ComposerInputHandle {
  readonly element: HTMLElement | null
  focus(): void
  getValue(): string
  insertReference(reference: string): void
  setValue(value: string, selectionOffset?: number): void
}

export function primaryComposerSubmitOptions(
  isStreaming: boolean,
  followUpBehavior: ComposerFollowUpBehavior
): ComposerSubmitOptions | undefined {
  return isStreaming && followUpBehavior === 'guide' ? { guideWhenBusy: true } : undefined
}
