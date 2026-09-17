import type { ReactNode } from 'react'

export function ComposerErrorBanner({ error, action }: { error?: ReactNode; action?: ReactNode }) {
  return error ? (
    <div
      className="mb-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
      data-testid="chat-input-error"
      role="alert"
    >
      {error}
      {action}
    </div>
  ) : null
}
