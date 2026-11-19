import type {
  createQuickPhrasePreferencesStore,
  QuickPhrase,
} from '@wegent/chat-core/composer-quick-phrases'
import { useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { QuickPhraseMenu } from '../composer/QuickPhraseMenu'
import { QuickPhrasesEditor } from '../composer/QuickPhrasesEditor'
import { DialogSurface } from '../controls/DialogSurface'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { useCollaborationPortalTheme } from '../theme'

export function BrowserQuickPhraseMenu({
  store,
  translate: t,
  disabled,
  onSelect,
}: {
  store: ReturnType<typeof createQuickPhrasePreferencesStore>
  translate: CollaborationTranslate
  disabled: boolean
  onSelect(phrase: QuickPhrase): void
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [manage, setManage] = useState(false)
  const portalTheme = useCollaborationPortalTheme()
  const dialogRef = useRef<HTMLDivElement>(null)

  return (
    <>
      <QuickPhraseMenu
        translate={t}
        disabled={disabled || !snapshot.loaded || snapshot.pending}
        globalPhrases={snapshot.phrases}
        onSelect={onSelect}
        onManage={() => setManage(true)}
        onRemoveStash={phrase => store.save(snapshot.phrases.filter(item => item.id !== phrase.id))}
        onClearStash={() =>
          store.save(snapshot.phrases.filter(item => !item.id.startsWith('stash-')))
        }
      />
      {snapshot.error && !manage && (
        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
          <span>{snapshot.error}</span>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="quick-phrase-load-retry"
            disabled={snapshot.pending}
            className="rounded px-2 hover:bg-muted max-md:min-h-11 max-md:min-w-11"
            onClick={() => void store.load()}
          >
            {t('common.retry')}
          </ControlButton>
        </div>
      )}
      {manage &&
        createPortal(
          <DialogSurface
            inline={false}
            onClose={() => setManage(false)}
            render={
              <div
                {...portalTheme}
                ref={dialogRef}
                aria-label={t('workbench.quick_phrases')}
                data-testid="quick-phrase-preferences-dialog"
                className={`${portalTheme.className} m-auto max-h-[86vh] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-border bg-background p-5 text-text-primary shadow-lg backdrop:bg-black/30`}
              />
            }
          >
            <header className="mb-4 flex items-center justify-between gap-3">
              <h2 className="heading-sm">{t('workbench.quick_phrases')}</h2>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="quick-phrase-preferences-close"
                className="h-8 rounded-lg px-3 text-sm hover:bg-muted max-md:min-h-11 max-md:min-w-11"
                onClick={() => setManage(false)}
              >
                {t('common.close')}
              </ControlButton>
            </header>
            <QuickPhrasesEditor
              translate={t}
              phrases={snapshot.phrases}
              disabled={snapshot.pending}
              onChange={next => store.save(next)}
            />
          </DialogSurface>,
          document.body
        )}
    </>
  )
}
