import {
  standInRoleName,
  type PersonalStandInSettings,
  type StandInRole,
  type StandInShareApi,
  type StandInShareEntry,
} from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { Radio, RadioGroup } from '@wegent/collaboration/controls/RadioGroup'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { useState } from 'react'
import { StandInNavigationButton } from './StandInRoleSelector'
import { StandInReviewDialog } from './StandInReviewDialog'

export function StandInShareControl({
  api,
  settings,
  roles,
  active,
  beforeOpen,
  onOpenShare,
}: {
  api: StandInShareApi
  settings: PersonalStandInSettings
  roles: StandInRole[]
  active: boolean
  beforeOpen(open: () => void): void
  onOpenShare(entry: StandInShareEntry): void
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<Awaited<ReturnType<StandInShareApi['list']>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { userId, executionDeviceId: device } = settings

  async function perform(action: () => Promise<void>) {
    setError('')
    setBusy(true)
    try {
      await action()
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const refresh = () => perform(async () => setShares(await api.list(userId, device)))

  return (
    <>
      <StandInNavigationButton
        selected={open}
        data-testid="stand-in-shares-open"
        aria-haspopup="dialog"
        onClick={() =>
          beforeOpen(() => {
            setOpen(true)
            setShares(null)
            void refresh()
          })
        }
      >
        {t('standIn.sharing.title')}
      </StandInNavigationButton>
      {active && open && (
        <StandInReviewDialog
          open
          compact
          busy={busy}
          title={t('standIn.sharing.title')}
          testId="stand-in-shares-dialog"
          onClose={() => setOpen(false)}
        >
          {error && (
            <div role="alert" className="mb-3 text-error">
              {error}
              {!shares && (
                <Button
                  variant="ghost"
                  data-testid="stand-in-shares-refresh"
                  onClick={() => void refresh()}
                >
                  {t('standIn.reload')}
                </Button>
              )}
            </div>
          )}
          {busy && (
            <p role="status" className="mb-3 text-text-secondary">
              {t('standIn.loading')}
            </p>
          )}
          {shares && (
            <ShareContents
              api={api}
              settings={settings}
              roles={roles}
              received={shares.received}
              sent={shares.sent}
              busy={busy}
              perform={perform}
              onPublished={next => setShares(next)}
              onOpenShare={entry => {
                setOpen(false)
                onOpenShare(entry)
              }}
            />
          )}
        </StandInReviewDialog>
      )}
    </>
  )
}

function ShareContents({
  api,
  settings,
  roles,
  received,
  sent,
  busy,
  perform,
  onPublished,
  onOpenShare,
}: {
  api: StandInShareApi
  settings: PersonalStandInSettings
  roles: StandInRole[]
  received: StandInShareEntry[]
  sent: StandInShareEntry[]
  busy: boolean
  perform(action: () => Promise<void>): Promise<void>
  onPublished(shares: Awaited<ReturnType<StandInShareApi['list']>>): void
  onOpenShare(entry: StandInShareEntry): void
}) {
  const { t } = useTranslation('common')
  const [publishing, setPublishing] = useState(false)
  const [source, setSource] = useState('assistant:@primary')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ id: number; user_name: string }[] | null>(null)
  const [recipient, setRecipient] = useState<number | null>(null)
  const [allowCopy, setAllowCopy] = useState(true)
  const [copied, setCopied] = useState<Map<string, number>>(() => new Map())
  const [revoking, setRevoking] = useState<StandInShareEntry | null>(null)
  const [updating, setUpdating] = useState<StandInShareEntry | null>(null)
  const { userId, executionDeviceId: device } = settings
  const directory = new Map(
    [...roles, ...settings.roles].map(role => [
      JSON.stringify([role.id, role.executionDeviceId]),
      role,
    ])
  )
  const repeatedIds = new Set<string>()
  const seenIds = new Set<string>()
  for (const role of directory.values()) {
    if (seenIds.has(role.id)) repeatedIds.add(role.id)
    seenIds.add(role.id)
  }

  const shareKey = (entry: StandInShareEntry) =>
    `${entry.owner_user_id}:${entry.resource_kind}:${entry.source_id}`
  const copy = (entry: StandInShareEntry, update = false) =>
    perform(async () => {
      await api.copy(userId, device, entry, update)
      setCopied(current => new Map(current).set(shareKey(entry), entry.revision))
      setUpdating(null)
    })

  async function publish() {
    if (recipient === null) return
    const separator = source.indexOf(':')
    const selected = directory.get(source)
    const id = selected?.id ?? source.slice(separator + 1)
    const team = settings.teams?.find(team => team.id === id && source.startsWith('team:'))
    const { publication_revisions: baseRevisions } = await api.list(userId, device)
    const root = await api.definition(
      userId,
      selected?.executionDeviceId ?? device,
      team ? 'team' : 'assistant',
      id
    )
    const assistants = team
      ? await Promise.all(
          Object.keys(team.members).map(id =>
            api.definition(
              userId,
              team.memberRoutes?.[id]?.executionDeviceId ?? device,
              'assistant',
              id
            )
          )
        )
      : []
    await api.publish(userId, device, {
      recipient_user_id: recipient,
      allow_copy: allowCopy,
      root,
      assistants,
      base_revisions: baseRevisions,
    })
    setPublishing(false)
    setRecipient(null)
    setQuery('')
    setMatches(null)
    onPublished(await api.list(userId, device))
  }

  if (publishing) {
    return (
      <div className="space-y-4">
        <fieldset className="space-y-4" disabled={busy}>
          <div className="grid gap-1">
            {t('standIn.sharing.resource')}
            <SelectField
              accessibleLabel={t('standIn.sharing.resource')}
              testId="stand-in-share-resource"
              value={source}
              disabled={busy}
              onChange={setSource}
              options={[
                { value: 'assistant:@primary', label: t('standIn.personal.default_role') },
                ...[...directory].map(([value, role], index) => {
                  const name = standInRoleName(role, index, t('standIn.personal.unnamed_assistant'))
                  return {
                    value,
                    label: repeatedIds.has(role.id) ? `${name} · ${role.executionDeviceId}` : name,
                  }
                }),
                ...(settings.teams ?? []).map(team => ({
                  value: `team:${team.id}`,
                  label: team.name,
                })),
              ]}
            />
          </div>
          <form
            onSubmit={event => {
              event.preventDefault()
              if (query.trim())
                void perform(async () => {
                  const found = await api.searchUsers(userId, device, query.trim())
                  setMatches(found.users.filter(item => item.id !== userId))
                })
            }}
          >
            <label className="grid gap-1">
              {t('standIn.sharing.recipient')}
              <TextField
                data-testid="stand-in-share-recipient-search"
                value={query}
                onChange={event => {
                  setQuery(event.target.value)
                  setMatches(null)
                  setRecipient(null)
                }}
              />
            </label>
            <Button
              type="submit"
              variant="outline"
              className="mt-2"
              data-testid="stand-in-share-search"
              disabled={!query.trim()}
            >
              {t('standIn.sharing.search')}
            </Button>
          </form>
          {matches?.length === 0 && <p role="status">{t('standIn.sharing.no_users')}</p>}
          {!!matches?.length && (
            <RadioGroup
              name="stand-in-share-recipient"
              aria-label={t('standIn.sharing.recipient')}
              value={String(recipient ?? '')}
              onValueChange={value => setRecipient(Number(value))}
              disabled={busy}
            >
              {matches.map(person => (
                <label key={person.id} className="flex min-h-11 items-center gap-2 md:min-h-8">
                  <Radio
                    value={String(person.id)}
                    data-testid={`stand-in-share-recipient-${person.id}`}
                  />
                  {person.user_name}
                </label>
              ))}
            </RadioGroup>
          )}
          <label className="flex min-h-11 items-center gap-2 md:min-h-8">
            <Checkbox
              data-testid="stand-in-share-allow-copy"
              checked={allowCopy}
              disabled={busy}
              onCheckedChange={checked => setAllowCopy(checked === true)}
            />
            {t('standIn.sharing.allow_copy')}
          </label>
          <p className="text-text-secondary">{t('standIn.sharing.connections')}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              data-testid="stand-in-share-cancel"
              onClick={() => setPublishing(false)}
            >
              {t('standIn.teams.cancel')}
            </Button>
            <Button
              data-testid="stand-in-share-send"
              onClick={() => void perform(publish)}
              disabled={recipient === null}
            >
              {t('standIn.sharing.send')}
            </Button>
          </div>
        </fieldset>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Button data-testid="stand-in-share-new" disabled={busy} onClick={() => setPublishing(true)}>
        {t('standIn.sharing.new')}
      </Button>
      <section className="space-y-2">
        <h3 className="font-medium">{t('standIn.sharing.received')}</h3>
        {received.length === 0 && (
          <p className="text-text-secondary">{t('standIn.sharing.empty')}</p>
        )}
        {received.map(entry => {
          const key = shareKey(entry)
          const localRevision = copied.get(key) ?? entry.local_revision
          const hasUpdate = localRevision != null && localRevision < entry.revision
          return (
            <div key={key} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {entry.name} · {entry.owner_name}
              </span>
              <div className="flex flex-wrap items-center gap-1">
                {!entry.revoked && !entry.derived && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid={`stand-in-share-use-${entry.source_id}`}
                    onClick={() =>
                      void perform(async () => {
                        await api.direct(userId, device, entry)
                        onOpenShare(entry)
                      })
                    }
                  >
                    {t(entry.direct_enabled ? 'standIn.sharing.continue' : 'standIn.sharing.use')}
                  </Button>
                )}
                {entry.revoked ? (
                  <span className="text-text-secondary">{t('standIn.sharing.revoked')}</span>
                ) : entry.allow_copy && localRevision == null ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid={`stand-in-share-copy-${entry.source_id}`}
                    onClick={() => void copy(entry)}
                  >
                    {t('standIn.sharing.copy')}
                  </Button>
                ) : entry.allow_copy && hasUpdate ? (
                  <Button
                    variant="outline"
                    disabled={busy}
                    data-testid={`stand-in-share-update-${entry.source_id}`}
                    onClick={() => setUpdating(entry)}
                  >
                    {t(
                      entry.resource_kind === 'team'
                        ? 'standIn.sharing.update_team'
                        : 'standIn.sharing.update_assistant'
                    )}
                  </Button>
                ) : localRevision != null ? (
                  <span className="text-text-secondary">{t('standIn.sharing.copied')}</span>
                ) : null}
              </div>
            </div>
          )
        })}
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">{t('standIn.sharing.sent')}</h3>
        {sent.length === 0 && <p className="text-text-secondary">{t('standIn.sharing.empty')}</p>}
        {sent.map(entry => (
          <div
            key={`${entry.resource_kind}:${entry.source_id}:${entry.recipient_user_id}`}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span>
              {entry.name} · {entry.recipient_name}
            </span>
            {entry.revoked ? (
              <span className="text-text-secondary">{t('standIn.sharing.revoked')}</span>
            ) : (
              <Button
                variant="ghost"
                disabled={busy}
                data-testid={`stand-in-share-revoke-${entry.source_id}-${entry.recipient_user_id}`}
                onClick={() => setRevoking(entry)}
              >
                {t('standIn.sharing.revoke')}
              </Button>
            )}
          </div>
        ))}
      </section>
      <ConfirmDialog
        open={revoking !== null}
        destructive
        title={t('standIn.sharing.revoke')}
        description={t('standIn.sharing.revoke_confirmation', { name: revoking?.recipient_name })}
        cancelLabel={t('standIn.teams.cancel')}
        confirmLabel={t('standIn.sharing.revoke')}
        confirmTestId="stand-in-share-confirm-revoke"
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (!revoking || busy) return
          const entry = revoking
          void perform(async () => {
            await api.revoke(userId, device, entry)
            setRevoking(null)
            onPublished(await api.list(userId, device))
          })
        }}
      />
      <ConfirmDialog
        open={updating !== null}
        title={t(
          updating?.resource_kind === 'team'
            ? 'standIn.sharing.update_team'
            : 'standIn.sharing.update_assistant'
        )}
        description={t(
          updating?.resource_kind === 'team'
            ? 'standIn.sharing.update_team_confirmation'
            : 'standIn.sharing.update_assistant_confirmation',
          { name: updating?.name }
        )}
        cancelLabel={t('standIn.teams.cancel')}
        confirmLabel={t('standIn.sharing.update_confirm')}
        confirmTestId="stand-in-share-confirm-update"
        dialogTestId="stand-in-share-update-confirmation"
        pending={busy}
        onClose={() => setUpdating(null)}
        onConfirm={() => {
          if (updating && !busy) void copy(updating, true)
        }}
      />
    </div>
  )
}
