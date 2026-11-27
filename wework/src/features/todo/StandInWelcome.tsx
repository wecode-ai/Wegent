import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { CalendarDays, MessageSquare } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { animateStandInWelcome, type StandInWelcomeShape } from './standInWelcomeMotion'

const examples = [
  { id: 'dingtalk_reply', icon: MessageSquare, shape: 'connection' },
  { id: 'meeting_prep', icon: CalendarDays, shape: 'agenda' },
] as const

export interface StandInStarterRequest {
  prompt?: string
  intent?: 'create'
}

export function StandInConversationTemplates({ onSelect }: { onSelect(prompt: string): void }) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        data-testid="stand-in-chat-templates"
        className="min-h-11 md:min-h-8"
        onClick={() => setExpanded(!expanded)}
      >
        {t('standIn.welcome.templates')}
      </Button>
      {expanded &&
        examples.map(({ id }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant="outline"
            data-testid={`stand-in-chat-template-${id}`}
            className="min-h-11 md:min-h-8"
            onClick={() => {
              onSelect(t(`standIn.welcome.examples.${id}.prompt`))
              setExpanded(false)
            }}
          >
            {t(`standIn.welcome.examples.${id}.title`)}
          </Button>
        ))}
    </div>
  )
}

export function StandInWelcome({
  active,
  busy,
  error,
  selectedPrompt,
  onStart,
  onAdvanced,
}: {
  active: boolean
  busy: boolean
  error?: string
  selectedPrompt?: string
  onStart(prompt?: string): void
  onAdvanced(): void
}) {
  const { t } = useTranslation('common')
  const [selected, setSelected] = useState(() =>
    selectedPrompt
      ? examples.find(({ id }) => t(`standIn.welcome.examples.${id}.prompt`) === selectedPrompt)
      : undefined
  )
  const motion = useRef<{ shape: StandInWelcomeShape; redraw?: () => void }>({
    shape: selected?.shape ?? 'idle',
  })
  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas || !active) return
      const animation = animateStandInWelcome(canvas, () => motion.current.shape)
      motion.current.redraw = animation?.redraw
      return () => {
        motion.current.redraw = undefined
        animation?.dispose()
      }
    },
    [active]
  )
  const key = selected && `standIn.welcome.examples.${selected.id}`
  return (
    <section
      className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-8"
      data-testid="stand-in-welcome"
    >
      <div className="my-auto w-full max-w-xl text-center">
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="mx-auto h-36 w-full max-w-md sm:h-48"
        />
        <h1 className="heading-lg text-balance">{t('standIn.welcome.title')}</h1>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {examples.map(({ id, icon: Icon, shape }, index) => (
            <Button
              key={id}
              type="button"
              variant="outline"
              aria-pressed={selected?.id === id}
              data-testid={`stand-in-welcome-example-${id}`}
              className="min-h-11 rounded-full aria-pressed:border-text-secondary md:min-h-8"
              onClick={() => {
                const next = selected?.id === id ? undefined : examples[index]
                motion.current.shape = next ? shape : 'idle'
                motion.current.redraw?.()
                setSelected(next)
              }}
            >
              <Icon aria-hidden="true" className="size-4" />
              {t(`standIn.welcome.examples.${id}.title`)}
            </Button>
          ))}
        </div>
        {key && (
          <div className="mx-auto mt-4 rounded-xl bg-muted px-4 py-3 text-left">
            <p className="whitespace-pre-wrap text-sm">{t(`${key}.prompt`)}</p>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            data-testid="stand-in-welcome-start"
            disabled={busy}
            aria-busy={busy}
            className="min-h-11 md:min-h-8"
            onClick={() => onStart(key ? t(`${key}.prompt`) : undefined)}
          >
            {t(busy ? 'standIn.loading' : key ? 'standIn.welcome.try' : 'standIn.onboarding.start')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            data-testid="stand-in-welcome-advanced"
            disabled={busy}
            className="min-h-11 md:min-h-8"
            onClick={onAdvanced}
          >
            {t('standIn.welcome.advanced')}
          </Button>
        </div>
      </div>
    </section>
  )
}
