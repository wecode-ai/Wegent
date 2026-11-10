import { Check, ChevronRight, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { IMPrivateSession } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { StandInReviewDialog } from './StandInReviewDialog'

export function StandInImConnectionDialog({
  channel,
  name,
  deviceName,
  offline,
  signedIn,
  sessions,
  loading,
  saving,
  error,
  connected,
  onConnect,
  onRefresh,
  onClose,
}: {
  channel: string
  name: string
  deviceName?: string
  offline: boolean
  signedIn: boolean
  sessions: IMPrivateSession[]
  loading: boolean
  saving: string | null
  error: 'load' | 'save' | null
  connected(session: IMPrivateSession): boolean
  onConnect(key: string): Promise<void>
  onRefresh(): void
  onClose(): void
}) {
  const { t } = useTranslation('common')
  const [selection, setSelection] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const selected =
    sessions.find(row => row.session_key === selection) ??
    sessions.find(connected) ??
    (sessions.length === 1 ? sessions[0] : undefined)
  const isConnected = Boolean(selected && connected(selected))
  return (
    <StandInReviewDialog
      open
      compact
      title={t('standIn.im.dialog_title', { channel })}
      testId="stand-in-im-dialog"
      busy={Boolean(saving)}
      onClose={onClose}
    >
      <div className="mx-auto max-w-lg space-y-5" data-testid="stand-in-im-connections">
        <div className="space-y-2 rounded-2xl bg-muted/50 px-5 py-6 text-center">
          <MessageSquare aria-hidden="true" className="mx-auto mb-3 h-7 w-7 text-text-secondary" />
          <h3 className="text-lg font-medium">{t('standIn.im.connect_channel', { channel })}</h3>
          <p className="text-sm text-text-secondary">
            {t('standIn.im.target_help', { name, channel })}
          </p>
          {deviceName && <p className="text-xs text-text-muted">{deviceName}</p>}
        </div>
        {offline && (
          <p role="status" className="text-sm text-text-secondary">
            {t('standIn.im.offline')}
          </p>
        )}
        {!signedIn ? (
          <p className="text-sm text-text-secondary">{t('standIn.im.sign_in')}</p>
        ) : (
          <>
            {loading && (
              <p
                role="status"
                data-testid="stand-in-im-loading"
                className="text-sm text-text-muted"
              >
                {t('standIn.im.loading')}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-error">
                {t(error === 'load' ? 'standIn.im.load_failed' : 'standIn.im.save_failed')}
              </p>
            )}
            {!loading && !error && !sessions.length && (
              <div
                className="space-y-2 text-sm text-text-secondary"
                data-testid="stand-in-im-empty"
              >
                <p>{t('standIn.im.empty_channel', { channel })}</p>
                <ol className="list-decimal space-y-1 pl-5">
                  <li>{t('standIn.im.setup_bot', { channel })}</li>
                  <li>{t('standIn.im.setup_bind')}</li>
                </ol>
              </div>
            )}
            {sessions.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-text-secondary">{t('standIn.im.choose_session')}</p>
                <div className="space-y-1">
                  {sessions.map(session => {
                    const active = connected(session)
                    const picked = selected?.session_key === session.session_key
                    return (
                      <button
                        key={session.session_key}
                        type="button"
                        data-testid={`stand-in-im-connect-${session.session_key}`}
                        aria-pressed={picked}
                        disabled={loading || Boolean(saving)}
                        className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50 ${picked ? 'bg-muted' : 'hover:bg-muted/50'}`}
                        onClick={() => setSelection(session.session_key)}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-base">
                            {session.display_name || session.sender_id}
                          </span>
                          <span className="mt-1 block text-sm text-text-secondary">
                            {t(
                              session.mode !== 'stand_in'
                                ? 'standIn.im.chat_mode'
                                : active
                                  ? 'standIn.im.connected'
                                  : session.stand_in
                                    ? 'standIn.im.other'
                                    : 'standIn.im.default'
                            )}
                          </span>
                        </span>
                        <span
                          aria-hidden="true"
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${picked ? 'border-text-primary' : 'border-text-muted'}`}
                        >
                          {picked && <span className="h-2 w-2 rounded-full bg-text-primary" />}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {selected && !isConnected && (
                  <p className="text-xs text-text-secondary">
                    {t('standIn.im.rebind_help', { name })}
                  </p>
                )}
                {isConnected && (
                  <p
                    role="status"
                    className="flex items-center gap-2 text-sm"
                    data-testid="stand-in-im-saved"
                  >
                    <Check aria-hidden="true" className="h-4 w-4" />
                    {t('standIn.im.saved', { name })}
                  </p>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              {sessions.length > 0 && (
                <Button
                  data-testid="stand-in-im-submit"
                  className="min-h-11 w-full rounded-full"
                  disabled={loading || Boolean(saving) || !selected}
                  onClick={() => {
                    if (isConnected) onClose()
                    else if (selected) void onConnect(selected.session_key)
                  }}
                >
                  {saving
                    ? t('standIn.im.saving')
                    : isConnected
                      ? t('standIn.im.done')
                      : t('standIn.im.connect_target', { name })}
                </Button>
              )}
              <Button
                variant={sessions.length ? 'ghost' : 'primary'}
                data-testid="stand-in-im-refresh"
                className="min-h-11 w-full rounded-full"
                disabled={loading || Boolean(saving)}
                onClick={onRefresh}
              >
                {t('standIn.im.refresh')}
              </Button>
            </div>
            <div className="text-xs text-text-secondary">
              <button
                type="button"
                data-testid="stand-in-im-mode-help"
                aria-expanded={helpOpen}
                className="flex min-h-11 items-center gap-1 py-3 md:min-h-0 md:py-1"
                onClick={() => setHelpOpen(value => !value)}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={`h-3 w-3 ${helpOpen ? 'rotate-90' : ''}`}
                />
                {t('standIn.im.mode_help')}
              </button>
              {helpOpen && <p className="mt-2 leading-relaxed">{t('standIn.im.description')}</p>}
            </div>
          </>
        )}
      </div>
    </StandInReviewDialog>
  )
}
