import { useState } from 'react'
import { navigateTo } from '@/lib/navigation'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import {
  readProviderRecovery,
  restoreProviderRecovery,
  type ModelRecoverySnapshot,
} from '@/features/model-settings/providerModelConfiguration'

const BUTTON =
  'min-h-11 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'

/** Recover connections through opaque Host identities; credentials never enter component state. */
export function ProviderCredentialRecovery({
  disabled,
  configurationAvailable,
}: {
  disabled: boolean
  configurationAvailable: boolean
}) {
  const { t } = useTranslation('modelConnections')
  const [open, setOpen] = useState(false)
  const [snapshot, setSnapshot] = useState<ModelRecoverySnapshot | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const candidate = snapshot?.candidates.find(item => item.id === selected)

  async function refresh() {
    setPending(true)
    setError(null)
    setSuccess(false)
    try {
      setSnapshot(await readProviderRecovery())
    } catch {
      setSnapshot(null)
      setError(t('recoveryUnavailable'))
    } finally {
      setPending(false)
    }
  }

  async function restore() {
    if (!candidate || !snapshot) return
    setPending(true)
    setError(null)
    setSuccess(false)
    try {
      await restoreProviderRecovery(candidate.id, snapshot.revision)
      setSelected(null)
      setSnapshot(await readProviderRecovery())
      setSuccess(true)
    } catch {
      // A failed response may follow a committed publication; refresh before another choice.
      setSelected(null)
      setSnapshot(null)
      setError(t('recoveryFailed'))
    } finally {
      setPending(false)
    }
  }

  if (!open)
    return (
      <button
        type="button"
        className={BUTTON}
        data-testid="provider-recovery-open"
        disabled={disabled}
        onClick={() => {
          setOpen(true)
          void refresh()
        }}
      >
        {t('recoveryTitle')}
      </button>
    )

  return (
    <section
      data-testid="provider-recovery-panel"
      aria-label={t('recoveryTitle')}
      className="space-y-3 border-t border-border pt-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-text-primary">{t('recoveryTitle')}</h4>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON}
            data-testid="provider-recovery-refresh"
            disabled={pending || disabled}
            onClick={() => void refresh()}
          >
            {t('retry')}
          </button>
          <button
            type="button"
            className={BUTTON}
            data-testid="provider-recovery-close"
            disabled={pending}
            onClick={() => {
              setOpen(false)
              setSelected(null)
            }}
          >
            {t('collapse')}
          </button>
        </div>
      </div>
      <p className="text-sm text-text-secondary">{t('recoveryDescription')}</p>
      {pending && (
        <p role="status" className="text-sm text-text-secondary">
          {t('loading')}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="provider-recovery-error" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {success && (
        <p
          role="status"
          data-testid="provider-recovery-success"
          className="text-sm text-text-secondary"
        >
          {t('recoverySuccess')}
        </p>
      )}
      {snapshot?.candidates.map(item => (
        <div
          key={item.id}
          data-testid={`provider-recovery-item-${item.id}`}
          className="space-y-2 border-t border-border py-3"
        >
          <p className="text-sm font-medium text-text-primary">
            {t(item.kind === 'legacy-models' ? 'recoveryLegacy' : 'recoverySaved')}
          </p>
          {item.providers.map((provider, index) => (
            <div key={index} className="text-sm text-text-secondary">
              <p className="break-words">
                {provider.name} · {provider.models.join(', ')}
              </p>
              <p className="break-all">
                {provider.baseUrl} · {provider.apiFormat}
              </p>
            </div>
          ))}
          <button
            type="button"
            className={BUTTON}
            data-testid={`provider-recovery-select-${item.id}`}
            disabled={
              pending || disabled || (item.kind === 'legacy-models' && !configurationAvailable)
            }
            onClick={() => setSelected(item.id)}
          >
            {t(item.kind === 'legacy-models' ? 'recoveryImport' : 'recoveryNewFile')}
          </button>
        </div>
      ))}
      {snapshot?.candidates.length === 0 && (
        <p className="text-sm text-text-secondary">{t('recoveryEmpty')}</p>
      )}
      {!!snapshot?.unreadableArchives && (
        <p className="text-sm text-text-secondary">
          {t('recoveryUnreadable', { count: snapshot.unreadableArchives })}
        </p>
      )}
      {!!snapshot?.cloudConflicts && (
        <p className="text-sm text-text-secondary">
          {t('recoveryCloud')}{' '}
          <a
            href="/settings/connections"
            onClick={event => {
              event.preventDefault()
              navigateTo('/settings/connections')
            }}
            data-testid="provider-recovery-cloud"
            className="text-primary underline"
          >
            {t('connectCloud')}
          </a>
        </p>
      )}
      <ConfirmDialog
        open={!!candidate}
        title={t('recoveryConfirmTitle')}
        description={
          candidate
            ? `${t(candidate.kind === 'legacy-models' ? 'recoveryConfirmLegacy' : 'recoveryConfirmSaved')}\n${candidate.providers.map(provider => `${provider.name}: ${provider.baseUrl} (${provider.apiFormat})`).join('\n')}`
            : ''
        }
        cancelLabel={t('cancel')}
        confirmLabel={t('confirm')}
        confirmTestId="provider-recovery-confirm"
        pending={pending}
        onClose={() => setSelected(null)}
        onConfirm={() => void restore()}
      />
    </section>
  )
}
