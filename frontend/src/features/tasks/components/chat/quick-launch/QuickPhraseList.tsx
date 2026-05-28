'use client'

import { ArrowLeft } from 'lucide-react'

import type { QuickLauncher } from './types'

interface QuickPhraseListProps {
  launcher: QuickLauncher
  onBack: () => void
  onPhraseSelect: (phrase: string) => void
}

export function QuickPhraseList({ launcher, onBack, onPhraseSelect }: QuickPhraseListProps) {
  if (launcher.quickPhrases.length === 0) {
    return null
  }

  return (
    <div className="mx-auto mt-6 w-full max-w-[620px]" data-testid="quick-phrase-list">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 inline-flex h-11 min-w-[44px] items-center gap-1 rounded-md px-2 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
        data-testid="quick-phrase-back"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {launcher.title}
      </button>

      <div className="flex flex-col gap-2">
        {launcher.quickPhrases.map((phrase, index) => (
          <button
            key={`${phrase}-${index}`}
            type="button"
            onClick={() => onPhraseSelect(phrase)}
            className="min-h-11 rounded-lg border border-border bg-base px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:border-primary/30 hover:bg-hover hover:text-text-primary"
            data-testid={`quick-phrase-${index}`}
          >
            {phrase}
          </button>
        ))}
      </div>
    </div>
  )
}
