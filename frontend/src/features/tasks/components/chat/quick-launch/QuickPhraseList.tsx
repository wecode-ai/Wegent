'use client'

import { ArrowLeft, Paperclip } from 'lucide-react'

import type { QuickInputPreset, QuickLauncher } from './types'

const QUICK_PHRASE_STAGGER_MS = 35
const QUICK_PHRASE_MAX_STAGGER_MS = 140

interface QuickPhraseListProps {
  launcher: QuickLauncher
  isExiting?: boolean
  onBack: () => void
  onPresetSelect: (preset: QuickInputPreset) => void
}

export function QuickPhraseList({
  launcher,
  isExiting = false,
  onBack,
  onPresetSelect,
}: QuickPhraseListProps) {
  if (launcher.inputPresets.length === 0) {
    return null
  }

  return (
    <div
      className={`mx-auto mt-6 w-full max-w-[620px] motion-reduce:animate-none ${
        isExiting
          ? 'pointer-events-none animate-out fade-out-0 slide-out-to-top-1 duration-150'
          : 'animate-in fade-in-0 slide-in-from-bottom-1 duration-150'
      }`}
      data-testid="quick-phrase-list"
    >
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
        {launcher.inputPresets.map((preset, index) => {
          const animationDelay = Math.min(
            index * QUICK_PHRASE_STAGGER_MS,
            QUICK_PHRASE_MAX_STAGGER_MS
          )
          const hasAttachments = (preset.source_attachment_ids?.length ?? 0) > 0

          return (
            <button
              key={`${preset.id}-${index}`}
              type="button"
              onClick={() => onPresetSelect(preset)}
              className={`min-h-11 rounded-lg border border-border bg-base px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:border-primary/30 hover:bg-hover hover:text-text-primary ${
                isExiting
                  ? ''
                  : 'animate-in fade-in-0 slide-in-from-left-2 duration-200 motion-reduce:animate-none'
              }`}
              style={
                isExiting
                  ? undefined
                  : {
                      animationDelay: `${animationDelay}ms`,
                      animationFillMode: 'both',
                    }
              }
              data-testid={`quick-phrase-${index}`}
            >
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
                  {preset.title}
                </span>
                {hasAttachments && (
                  <Paperclip
                    className="h-3.5 w-3.5 flex-shrink-0 text-text-muted"
                    data-testid={`quick-phrase-attachment-icon-${index}`}
                  />
                )}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
