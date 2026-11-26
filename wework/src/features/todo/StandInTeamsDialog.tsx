import {
  standInRoleName,
  type PersonalStandInSettings,
  type StandInRole,
  type StandInTeam,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { TextField as Input } from '@wegent/collaboration/controls/TextField'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useState } from 'react'
import { StandInReviewDialog } from './StandInReviewDialog'
import { UsersRound } from 'lucide-react'
import { IconButton } from '@wegent/collaboration/controls/IconButton'
import { Tooltip } from '@/components/ui/tooltip'

type TeamControlProps = Omit<Parameters<typeof StandInTeamsDialog>[0], 'onClose'> & {
  active: boolean
  selected?: StandInTeam
  beforeOpen(open: () => void): void
}

export function StandInTeamControl({
  active,
  selected,
  beforeOpen,
  onOpenTeam,
  ...props
}: TeamControlProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label={t('standIn.teams.title')} side="bottom" align="end">
        <IconButton
          aria-label={t('standIn.teams.title')}
          aria-expanded={open}
          aria-current={selected ? 'page' : undefined}
          data-testid="stand-in-teams-open"
          aria-haspopup="dialog"
          onClick={() => beforeOpen(() => setOpen(true))}
        >
          <UsersRound aria-hidden="true" className="size-4" />
        </IconButton>
      </Tooltip>
      {active && open && (
        <StandInTeamsDialog
          {...props}
          onClose={() => setOpen(false)}
          onOpenTeam={team => {
            setOpen(false)
            onOpenTeam(team)
          }}
        />
      )}
    </>
  )
}

function StandInTeamsDialog({
  api,
  settings,
  roles,
  onClose,
  onOpenTeam,
}: {
  api: StandInExecutorApi
  settings: PersonalStandInSettings
  roles: StandInRole[]
  onClose(): void
  onOpenTeam(team: StandInTeam): void
}) {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState<StandInTeam | null>(null)
  const [initialDraft, setInitialDraft] = useState<StandInTeam | null>(null)
  const [discard, setDiscard] = useState<'close' | 'back' | null>(null)
  const [removing, setRemoving] = useState<StandInTeam | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const teams = settings.teams ?? []
  const leadRoles = settings.roles.filter(
    role => role.executionDeviceId === settings.executionDeviceId
  )
  const directory = new Map([...roles, ...settings.roles].map(role => [role.id, role]))
  const memberDevices = new Map<string, Map<string, StandInRole>>()
  for (const role of [...roles, ...settings.roles]) {
    const locations = memberDevices.get(role.id) ?? new Map<string, StandInRole>()
    locations.set(role.executionDeviceId, role)
    memberDevices.set(role.id, locations)
  }
  const candidates = new Map(
    [...directory.values()].map((role, index) => [
      role.id,
      standInRoleName(role, index, t('standIn.personal.unnamed_assistant')),
    ])
  )
  candidates.set('@primary', t('standIn.personal.default_role'))

  const edit = (team: StandInTeam) => {
    setInitialDraft(team)
    setDraft(team)
    setError('')
  }
  const requestLeave = (target: 'close' | 'back') => {
    if (draft && JSON.stringify(draft) !== JSON.stringify(initialDraft)) setDiscard(target)
    else if (target === 'close') onClose()
    else setDraft(null)
  }

  async function save(next: StandInTeam[]) {
    setBusy(true)
    setError('')
    try {
      await api.personalSave(
        settings.userId,
        { ...settings, teams: next },
        settings.executionDeviceId
      )
      setDraft(null)
      setRemoving(null)
    } catch (cause) {
      setError(getStandInErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <StandInReviewDialog
        open
        compact
        busy={busy}
        suspended={discard !== null}
        title={t(
          removing
            ? 'standIn.teams.remove'
            : draft
              ? teams.some(team => team.id === draft.id)
                ? 'standIn.teams.edit_title'
                : 'standIn.teams.create'
              : 'standIn.teams.title'
        )}
        testId="stand-in-teams-dialog"
        onClose={() => requestLeave('close')}
      >
        {error && (
          <p className="mb-3 text-error" role="alert">
            {error}
          </p>
        )}
        {removing ? (
          <div className="space-y-4">
            <p>{t('standIn.teams.remove_confirmation', { name: removing.name })}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                data-testid="stand-in-team-remove-cancel"
                disabled={busy}
                onClick={() => setRemoving(null)}
              >
                {t('standIn.teams.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                data-testid="stand-in-team-remove-confirm"
                disabled={busy}
                onClick={() => void save(teams.filter(team => team.id !== removing.id))}
              >
                {t('standIn.teams.remove')}
              </Button>
            </div>
          </div>
        ) : draft ? (
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault()
              const memberRoutes = Object.fromEntries(
                Object.keys(draft.members).flatMap(id => {
                  if (id === draft.leadId) return []
                  const route = draft.memberRoutes?.[id]
                  if (!route || route.executionDeviceId === settings.executionDeviceId) return []
                  return [[id, { executionDeviceId: route.executionDeviceId, name: route.name }]]
                })
              )
              const next = { ...draft, name: draft.name.trim(), memberRoutes }
              void save(
                teams.some(team => team.id === next.id)
                  ? teams.map(team => (team.id === next.id ? next : team))
                  : [...teams, next]
              )
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <label className="grid gap-1">
                {t('standIn.teams.name')}
                <Input
                  className="border-text-secondary/80"
                  data-testid="stand-in-team-name"
                  value={draft.name}
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                  required
                />
              </label>
              <div className="grid gap-1">
                {t('standIn.teams.lead')}
                <SelectField
                  accessibleLabel={t('standIn.teams.lead')}
                  testId="stand-in-team-lead"
                  value={draft.leadId}
                  disabled={busy}
                  onChange={leadId => {
                    const duty = Object.hasOwn(draft.members, leadId) ? draft.members[leadId] : ''
                    const members = { ...draft.members, [leadId]: duty }
                    if (leadId !== '@primary') delete members['@primary']
                    setDraft({ ...draft, leadId, members })
                  }}
                  options={[
                    ...(draft.leadId !== '@primary' &&
                    !leadRoles.some(role => role.id === draft.leadId)
                      ? [{ value: draft.leadId, label: draft.leadId }]
                      : []),
                    { value: '@primary', label: t('standIn.personal.default_role') },
                    ...leadRoles.map(role => ({
                      value: role.id,
                      label: candidates.get(role.id) ?? role.name,
                    })),
                  ]}
                />
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-1 font-medium">{t('standIn.teams.members')}</legend>
                {[...new Set([...candidates.keys(), ...Object.keys(draft.members)])]
                  .filter(id => id !== '@primary' || draft.leadId === id)
                  .map(id => {
                    const included = Object.hasOwn(draft.members, id)
                    const name = candidates.get(id) ?? id
                    const isLead = draft.leadId === id
                    const locations = memberDevices.get(id)
                    const currentDevice =
                      draft.memberRoutes?.[id]?.executionDeviceId ?? settings.executionDeviceId
                    return (
                      <div key={id} className="space-y-1">
                        <label className="flex min-h-11 items-center gap-2 md:min-h-8">
                          <Checkbox
                            data-testid={`stand-in-team-member-${id}`}
                            checked={included}
                            disabled={busy || isLead}
                            onCheckedChange={checked => {
                              const members = { ...draft.members, [id]: '' }
                              const memberRoutes = { ...draft.memberRoutes }
                              const role = directory.get(id)
                              if (checked !== true) {
                                delete members[id]
                                delete memberRoutes[id]
                              } else if (
                                role &&
                                role.executionDeviceId !== settings.executionDeviceId
                              ) {
                                memberRoutes[id] = {
                                  executionDeviceId: role.executionDeviceId,
                                  name: role.name,
                                }
                              }
                              setDraft({ ...draft, members, memberRoutes })
                            }}
                          />
                          {name}
                          {isLead && (
                            <span className="text-text-secondary">{t('standIn.teams.lead')}</span>
                          )}
                        </label>
                        {included &&
                          !isLead &&
                          locations &&
                          (locations.size > 1 || !locations.has(currentDevice)) && (
                            <SelectField
                              accessibleLabel={name}
                              testId={`stand-in-team-member-device-${id}`}
                              value={currentDevice}
                              disabled={busy}
                              options={[...new Set([currentDevice, ...locations.keys()])].map(
                                device => ({
                                  value: device,
                                  label: device,
                                })
                              )}
                              onChange={device => {
                                const memberRoutes = { ...draft.memberRoutes }
                                if (device === settings.executionDeviceId) delete memberRoutes[id]
                                else {
                                  memberRoutes[id] = {
                                    executionDeviceId: device,
                                    name: locations.get(device)?.name ?? name,
                                  }
                                }
                                setDraft({ ...draft, memberRoutes })
                              }}
                            />
                          )}
                        {included && (
                          <label className="grid gap-1 pl-6 text-text-secondary">
                            {t('standIn.teams.duty')}
                            <Input
                              data-testid={`stand-in-team-duty-${id}`}
                              aria-label={t('standIn.teams.duty_for', { name })}
                              className="border-text-secondary/80 text-text-primary"
                              value={draft.members[id]}
                              onChange={event =>
                                setDraft({
                                  ...draft,
                                  members: { ...draft.members, [id]: event.target.value },
                                })
                              }
                            />
                          </label>
                        )}
                      </div>
                    )
                  })}
              </fieldset>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="stand-in-team-edit-cancel"
                  onClick={() => requestLeave('back')}
                >
                  {t('standIn.teams.cancel')}
                </Button>
                <Button
                  type="submit"
                  data-testid="stand-in-team-save"
                  disabled={!draft.name.trim()}
                >
                  {t('standIn.teams.save')}
                </Button>
              </div>
            </fieldset>
          </form>
        ) : (
          <div className="space-y-3">
            {teams.length === 0 && (
              <p className="text-text-secondary">{t('standIn.teams.empty')}</p>
            )}
            {teams.map(team => (
              <div key={team.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{team.name}</span>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={t('standIn.teams.open_named', { name: team.name })}
                    data-testid={`stand-in-team-open-${team.id}`}
                    onClick={() => onOpenTeam(team)}
                    className="min-w-0 justify-start"
                  >
                    {t('standIn.teams.open')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`stand-in-team-edit-${team.id}`}
                    aria-label={t('standIn.teams.edit_named', { name: team.name })}
                    onClick={() => edit(team)}
                  >
                    {t('standIn.teams.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`stand-in-team-remove-${team.id}`}
                    aria-label={t('standIn.teams.remove_named', { name: team.name })}
                    onClick={() => setRemoving(team)}
                  >
                    {t('standIn.teams.remove')}
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              data-testid="stand-in-team-create"
              onClick={() =>
                edit({
                  id: crypto.randomUUID(),
                  name: '',
                  leadId: '@primary',
                  members: { '@primary': '' },
                })
              }
            >
              {t('standIn.teams.create')}
            </Button>
          </div>
        )}
      </StandInReviewDialog>
      <ConfirmDialog
        open={discard !== null}
        destructive
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmLabel={t('standIn.personal.discard')}
        confirmTestId="stand-in-team-discard"
        cancelTestId="stand-in-team-keep-editing"
        onClose={() => setDiscard(null)}
        onConfirm={() => {
          if (discard === 'close') onClose()
          setDraft(null)
          setDiscard(null)
        }}
      />
    </>
  )
}
