import type { QuickPhrase } from '@wegent/chat-core/composer-quick-phrases'

/** Insert at the current live value; delayed focus must not restore an old draft. */
export function applyQuickPhrase(
  phrase: QuickPhrase,
  composer: { getValue(): string; setValue(value: string, cursor?: number): void; focus(): void },
  modes: { clearPlan?(): void; cancelGoal?(): void; setPlan?(): void; setGoal?(): void }
) {
  modes.clearPlan?.()
  modes.cancelGoal?.()
  if (phrase.mode === 'plan') modes.setPlan?.()
  if (phrase.mode === 'goal') modes.setGoal?.()
  const value = composer.getValue()
  const next = value ? `${value}\n${phrase.content}` : phrase.content
  composer.setValue(next, next.length)
  composer.focus()
  return next
}
