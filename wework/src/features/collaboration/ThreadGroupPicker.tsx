import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TemplateDialog } from '@wegent/collaboration/templates'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus'

/** Require an explicit owning group without copying project membership or authority. */
export function ThreadGroupPicker({
  groups,
  scopeKey,
  projectName,
  parentGroup,
  initialGroupId,
  requireParentGroup,
  onClose,
  onChoose,
}: {
  groups: ChatGroupApi | undefined
  scopeKey: string
  projectName?: string
  parentGroup?: string | null
  initialGroupId?: string
  requireParentGroup?: boolean
  onClose(): void
  onChoose(group: ChatGroup): Promise<void>
}) {
  const { t } = useTranslation('collaboration')
  const [groupId, setGroupId] = useState(parentGroup ?? initialGroupId ?? '')
  const [name, setName] = useState('')
  const [busyRequest, setBusyRequest] = useState<object | null>(null)
  const [errorState, setErrorState] = useState<{ owner: object; message: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [createdGroup, setCreatedGroup] = useState<{
    owner: ChatGroupApi
    scopeKey: string
    group: ChatGroup
  } | null>(null)
  const request = useMemo(() => ({ groups, scopeKey, revision }), [groups, scopeKey, revision])
  const busy = busyRequest === request
  const error = errorState?.owner === request ? errorState.message : null
  const lifetime = useRef<object | null>(request)
  useLayoutEffect(() => {
    lifetime.current = request
    return () => {
      lifetime.current = null
    }
  }, [request])
  const [catalog, setCatalog] = useState<{
    owner: object
    items: ChatGroup[]
    failed: boolean
  } | null>(null)
  const currentCatalog = catalog?.owner === request ? catalog : null
  const loading = Boolean(groups) && !currentCatalog
  const catalogError = !groups || currentCatalog?.failed ? t('loadFailed') : null
  const eligible = (currentCatalog?.items ?? []).filter(
    group => group.status === 'active' && ['Owner', 'Maintainer', 'Developer'].includes(group.role)
  )
  const parentUnavailable =
    parentGroup &&
    currentCatalog &&
    !currentCatalog.failed &&
    !eligible.some(group => group.id === parentGroup)
  const visibleError = error ?? catalogError ?? (parentUnavailable ? t('readOnly') : null)
  const creatingGroup =
    !parentGroup &&
    (groupId === '__new__' || (currentCatalog && !currentCatalog.failed && eligible.length === 0))
  useEffect(() => {
    let active = true
    if (!groups) return
    void groups
      .list()
      .then(result => {
        if (active) setCatalog({ owner: request, items: result.items, failed: false })
      })
      .catch(() => {
        if (active) setCatalog({ owner: request, items: [], failed: true })
      })
    return () => {
      active = false
    }
  }, [groups, request])
  const next = async () => {
    if (!groups || busy || loading || (creatingGroup && !name.trim())) return
    setBusyRequest(request)
    setErrorState(null)
    const current = () => lifetime.current === request
    try {
      if (requireParentGroup && !parentGroup) throw new Error(t('threadParentRequiresGroup'))
      let group = eligible.find(group => group.id === groupId)
      if (creatingGroup) {
        group =
          createdGroup?.owner === groups && createdGroup.scopeKey === scopeKey
            ? createdGroup.group
            : undefined
        if (!group) {
          group = (await groups.create({ name: name.trim() })).group
          if (!current()) return
          setCreatedGroup({ owner: groups, scopeKey, group })
        }
      }
      if (!group || (parentGroup && parentGroup !== group.id)) throw new Error(t('selectGroup'))
      const info = await groups.get(group.id)
      if (!current()) return
      if (
        info.group.status !== 'active' ||
        !['Owner', 'Maintainer', 'Developer'].includes(info.group.role)
      )
        throw new Error(t('readOnly'))
      await onChoose(info.group)
    } catch (cause) {
      if (current())
        setErrorState({
          owner: request,
          message: cause instanceof Error ? cause.message : t('loadFailed'),
        })
    } finally {
      if (current()) setBusyRequest(null)
    }
  }
  return (
    <TemplateDialog
      title={t('newThread')}
      description={t('threadChooseGroupHint')}
      closeLabel={t('close')}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="space-y-4"
        data-testid="thread-create-group-dialog"
        onSubmit={event => {
          event.preventDefault()
          void next()
        }}
      >
        <label className="block space-y-2 text-sm text-text-primary">
          <span>{t('threadOwningGroup')}</span>
          <select
            className={field}
            data-testid="thread-create-group-select"
            value={creatingGroup ? '__new__' : groupId}
            disabled={loading || busy || Boolean(parentGroup)}
            onChange={event => setGroupId(event.target.value)}
          >
            <option value="">{t('selectGroup')}</option>
            {eligible.map(group => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
            {!parentGroup && <option value="__new__">{t('newGroup')}</option>}
          </select>
        </label>
        {creatingGroup && (
          <label className="block space-y-2 text-sm text-text-primary">
            <span>{t('groupName')}</span>
            <input
              className={field}
              data-testid="thread-create-new-group-name"
              value={name}
              required
              maxLength={255}
              disabled={busy || createdGroup?.owner === groups}
              onChange={event => setName(event.target.value)}
            />
            <p className="text-xs text-text-muted">{t('threadNewGroupHint')}</p>
          </label>
        )}
        {projectName && (
          <p className="text-sm text-text-muted">
            {t('threadProjectTarget', { project: projectName })}
          </p>
        )}
        {loading && (
          <p role="status" className="text-sm text-text-muted">
            {t('loading')}
          </p>
        )}
        {visibleError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {visibleError}
            </p>
            <Button
              type="button"
              variant="ghost"
              data-testid="thread-create-groups-retry"
              disabled={busy}
              onClick={() => {
                setErrorState(null)
                setRevision(value => value + 1)
              }}
            >
              {t('retry')}
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="thread-create-group-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            data-testid="thread-create-group-next"
            disabled={
              loading ||
              busy ||
              !groups ||
              (creatingGroup ? !name.trim() : !eligible.some(group => group.id === groupId))
            }
          >
            {t(creatingGroup ? 'threadCreateGroupContinue' : 'continue')}
          </Button>
        </div>
      </form>
    </TemplateDialog>
  )
}
