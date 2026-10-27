import { useRef, useState } from 'react'

import type { CollaborationTranslate } from '../i18n'
import { Button } from '../markdown/Button'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationExecutionEnvironment,
  CollaborationMember,
  CollaborationProject,
  ProjectDeviceAccess,
  ProjectDeviceAccessPreview,
} from '../types'

export function ProjectDeviceAccessSettings({
  api,
  projectId,
  environment,
  translate: t,
  onChanged,
  onReload,
}: {
  api: SharedWorkspaceApi
  projectId: string
  environment: CollaborationExecutionEnvironment
  translate: CollaborationTranslate
  onChanged(project: CollaborationProject): Promise<void>
  onReload(): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ProjectDeviceAccess>(environment.use_access!)
  const [version, setVersion] = useState(environment.project_version!)
  const [members, setMembers] = useState<CollaborationMember[] | null>(null)
  const [membersError, setMembersError] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [preview, setPreview] = useState<ProjectDeviceAccessPreview | null>(null)
  const inFlight = useRef(false)
  const id = `project-device-access-${environment.device_id}`
  const stale = version !== environment.project_version
  const label = (scope: ProjectDeviceAccess['scope']) => t(`deviceAccess.${scope}`, scope)
  const eligibleMembers = (members ?? []).filter(
    member =>
      ['Owner', 'Maintainer', 'Developer'].includes(member.role) &&
      (environment.owner_type !== 'user' || String(member.user_id) !== environment.owner_id)
  )

  async function loadMembers() {
    setMembersError(false)
    setMembers(null)
    try {
      setMembers(await api.members.list(projectId))
    } catch {
      setMembersError(true)
    }
  }

  function edit() {
    setDraft(environment.use_access!)
    setVersion(environment.project_version!)
    setError('')
    setSaved(false)
    setPreview(null)
    setOpen(true)
    void loadMembers()
  }

  function change(next: ProjectDeviceAccess) {
    setDraft(next)
    setPreview(null)
    setError('')
  }

  async function commit(plan: ProjectDeviceAccessPreview) {
    const updated = await api.projects.update(projectId, {
      version,
      deviceAccessChange: {
        deviceId: environment.device_id!,
        scope: draft.scope,
        memberIds: draft.member_ids,
        confirmationToken: plan.confirmation_token,
      },
    })
    await onChanged(updated)
    setOpen(false)
    setSaved(true)
  }

  async function save() {
    if (inFlight.current || stale) return
    inFlight.current = true
    setSaving(true)
    setError('')
    try {
      if (preview) {
        await commit(preview)
      } else {
        const response = await api.projects.update(projectId, {
          version,
          deviceAccessChange: {
            deviceId: environment.device_id!,
            scope: draft.scope,
            memberIds: draft.member_ids,
            previewOnly: true,
          },
        })
        const plan = response.device_access_preview
        if (!plan) throw new Error('Missing device permission preview')
        if (plan.affected_execution_count > 0) setPreview(plan)
        else await commit(plan)
      }
    } catch {
      setPreview(null)
      setError(t('deviceAccess.failed', 'Could not save permissions. Reload and try again.'))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <div className="w-full text-sm" data-testid={id}>
      <div className="flex flex-wrap items-center gap-2">
        {environment.can_manage_access ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11 md:min-h-8"
            data-testid={`${id}-edit`}
            aria-expanded={open}
            aria-controls={`${id}-form`}
            disabled={saving}
            onClick={() => (open ? setOpen(false) : edit())}
          >
            {t('deviceAccess.label', 'Use permissions')}: {label(environment.use_access!.scope)}
          </Button>
        ) : (
          <span
            title={t('deviceAccess.ownerOnly', 'Only the device owner can change use permissions.')}
          >
            {t('deviceAccess.label', 'Use permissions')}: {label(environment.use_access!.scope)}
          </span>
        )}
        {environment.unavailable_reason === 'device_use_not_allowed' ? (
          <span className="text-text-muted">
            {t('deviceAccess.unavailable', 'Your account cannot use this device')}
          </span>
        ) : null}
        {saved ? (
          <span role="status">{t('deviceAccess.saved', 'Use permissions saved')}</span>
        ) : null}
      </div>
      {open && environment.can_manage_access ? (
        <form
          id={`${id}-form`}
          className="mt-2 space-y-3 rounded-lg bg-muted p-3"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex flex-wrap items-center gap-2">
            {t('deviceAccess.label', 'Use permissions')}
            <select
              autoFocus
              className="min-h-11 rounded-lg border border-border bg-background px-2 text-text-primary md:min-h-8"
              data-testid={`${id}-scope`}
              value={draft.scope}
              disabled={saving}
              onChange={event =>
                change({
                  scope: event.target.value as ProjectDeviceAccess['scope'],
                  member_ids: [],
                })
              }
            >
              {(['owner', 'project', 'members'] as const).map(scope => (
                <option className="bg-background text-text-primary" key={scope} value={scope}>
                  {label(scope)}
                </option>
              ))}
            </select>
          </label>
          {draft.scope === 'members' ? (
            <fieldset disabled={saving} className="space-y-1">
              <legend>
                {t('deviceAccess.selectMembers', 'Choose project members who may use this device')}
              </legend>
              {membersError ? (
                <div role="alert">
                  {t('deviceAccess.membersFailed', 'Could not load members. Try again.')}
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`${id}-members-retry`}
                    onClick={() => void loadMembers()}
                  >
                    {t('deviceAccess.reload', 'Reload')}
                  </Button>
                </div>
              ) : members === null ? (
                <p role="status">{t('deviceAccess.loading', 'Loading members…')}</p>
              ) : eligibleMembers.length === 0 ? (
                <p>{t('deviceAccess.noMembers', 'No other members can execute.')}</p>
              ) : (
                eligibleMembers.map(member => (
                  <label
                    className="flex min-h-11 items-center gap-2 md:min-h-8"
                    key={member.user_id}
                  >
                    <input
                      type="checkbox"
                      data-testid={`${id}-member-${member.user_id}`}
                      checked={draft.member_ids.includes(member.user_id)}
                      onChange={event =>
                        change({
                          ...draft,
                          member_ids: event.target.checked
                            ? [...draft.member_ids, member.user_id]
                            : draft.member_ids.filter(id => id !== member.user_id),
                        })
                      }
                    />
                    {member.user_name}
                  </label>
                ))
              )}
            </fieldset>
          ) : null}
          {preview ? (
            <p role="alert" data-testid={`${id}-impact`}>
              {t(
                'deviceAccess.impact',
                'This change affects {{runs}} tasks across {{agents}} agents. Queued tasks will be cancelled; running tasks will be asked to stop and await device confirmation.',
                { runs: preview.affected_execution_count, agents: preview.affected_agent_count }
              )}
            </p>
          ) : null}
          {error || stale ? (
            <p role="alert">
              {error ||
                t('deviceAccess.stale', 'Project permissions changed. Reload before editing.')}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid={`${id}-save`}
              disabled={
                saving ||
                stale ||
                (draft.scope === 'members' &&
                  (members === null || membersError || !draft.member_ids.length))
              }
            >
              {preview
                ? t('deviceAccess.confirm', 'Confirm change and cancel tasks')
                : t('deviceAccess.save', 'Save permissions')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="min-h-11 md:min-h-9"
              data-testid={`${id}-cancel`}
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              {t('deviceAccess.cancel', 'Cancel')}
            </Button>
            {error || stale ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-9"
                data-testid={`${id}-reload`}
                disabled={saving}
                onClick={() => {
                  setOpen(false)
                  void onReload()
                }}
              >
                {t('deviceAccess.reload', 'Reload')}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  )
}
