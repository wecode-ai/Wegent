import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'

interface Registration {
  environment_id: string
  device_id: string
  token: string
}
export function WorkspaceRunnerRegistrationDialog({
  workspaceId,
  register,
  onClose,
  onDone,
}: {
  workspaceId: string
  register(workspaceId: string, name: string): Promise<Registration>
  onClose(): void
  onDone(): Promise<void>
}) {
  const { t } = useTranslation('common')
  const [name, setName] = useState('')
  const [registration, setRegistration] = useState<Registration | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useDialogKeyboard<HTMLElement>(() => {
    if (!busy) {
      if (registration) void onDone()
      else onClose()
    }
  })
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setRegistration(await register(workspaceId, name.trim()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="runner-register-title"
        className="w-full max-w-lg space-y-4 rounded-lg border border-border bg-popover p-5 shadow-lg"
        data-testid="workspace-runner-registration"
      >
        <h2 id="runner-register-title" className="text-sm font-semibold">
          {t('workbench.runner_register')}
        </h2>
        {registration ? (
          <>
            <p className="text-sm text-text-secondary">{t('workbench.runner_registration_hint')}</p>
            <label className="block space-y-1 text-sm">
              DEVICE_ID
              <input
                readOnly
                className="w-full rounded border border-border bg-background p-2"
                data-testid="workspace-runner-device-id"
                value={registration.device_id}
              />
            </label>
            <label className="block space-y-1 text-sm">
              WEGENT_AUTH_TOKEN
              <input
                readOnly
                className="w-full rounded border border-border bg-background p-2"
                data-testid="workspace-runner-token"
                value={registration.token}
              />
            </label>
            <p className="text-xs text-text-muted">{t('workbench.runner_registration_revoke')}</p>
          </>
        ) : (
          <label className="block space-y-1 text-sm">
            {t('workbench.runner_environment')}
            <input
              autoFocus
              className="w-full rounded border border-border bg-background p-2"
              data-testid="workspace-runner-name"
              value={name}
              onChange={event => setName(event.target.value)}
              maxLength={100}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {registration ? (
            <Button data-testid="workspace-runner-done" onClick={() => void onDone()}>
              {t('workbench.close')}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                disabled={busy}
                data-testid="workspace-runner-cancel"
                onClick={onClose}
              >
                {t('workbench.cancel')}
              </Button>
              <Button
                disabled={busy || !name.trim()}
                data-testid="workspace-runner-register"
                onClick={() => void submit()}
              >
                {t('workbench.runner_register')}
              </Button>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
