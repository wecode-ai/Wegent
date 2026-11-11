import { useEffect, useMemo, useState } from 'react'
import {
  IssueCreate,
  createCollaborationTranslator,
  projectStatuses,
  type CollaborationIssue,
  type CollaborationProject,
  type IssueCreateProps,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import { TemplateDialog } from '@wegent/collaboration/templates'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createGroupWorkspaceApi, groupBoardContext } from './groupWorkspaceApi'

const field =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary focus-visible:ring-2 focus-visible:ring-focus'

/** Project classification never chooses the owning group or imports its roster. */
export function ThreadCreateDialog({
  form,
  api,
  groups,
  store,
  locale,
  accountScope,
  externalForm,
}: {
  form: Omit<IssueCreateProps, 'project'> & { project?: CollaborationProject }
  api: SharedWorkspaceApi
  groups: ChatGroupApi | undefined
  store: 'local' | 'cloud'
  locale: 'zh-CN' | 'en'
  accountScope: string
  externalForm?: IssueCreateProps
}) {
  const { t } = useTranslation('collaboration')
  const [useGroup, setUseGroup] = useState(false)
  if (externalForm)
    return (
      <>
        <div hidden={useGroup}>
          <IssueCreate
            {...externalForm}
            allIssues={externalForm.allIssues.filter(item => !item.group_id)}
            defaults={{
              status: externalForm.project.board_config?.statuses?.[0]?.id ?? 'inbox',
              tags: [],
              parent: null,
              ...externalForm.defaults,
              draftScope: `external:${accountScope}:${store}:${externalForm.project.id}:${externalForm.defaults?.draftScope ?? ''}`,
            }}
            environmentNotice={({ saving }) => (
              <>
                {typeof externalForm.environmentNotice === 'function'
                  ? externalForm.environmentNotice({ saving })
                  : externalForm.environmentNotice}
                {!externalForm.defaults?.parent &&
                  groups &&
                  externalForm.project.status === 'active' &&
                  (store === 'local' ||
                    ['Owner', 'Maintainer', 'Developer'].includes(
                      externalForm.project.access_role ?? ''
                    )) && (
                    <div className="space-y-2 text-sm text-text-muted">
                      <p>{t('externalCreateHint')}</p>
                      <Button
                        type="button"
                        variant="ghost"
                        data-testid="external-create-group-thread"
                        disabled={saving}
                        onClick={() => setUseGroup(true)}
                      >
                        {t('externalCreateGroupThread')}
                      </Button>
                    </div>
                  )}
              </>
            )}
          />
        </div>
        {useGroup && (
          <GroupThreadCreateDialog
            form={{ ...form, onClose: () => setUseGroup(false) }}
            api={api}
            groups={groups}
            store={store}
            locale={locale}
            accountScope={accountScope}
          />
        )}
      </>
    )
  return (
    <GroupThreadCreateDialog
      form={form}
      api={api}
      groups={groups}
      store={store}
      locale={locale}
      accountScope={accountScope}
    />
  )
}

function GroupThreadCreateDialog({
  form,
  api,
  groups,
  store,
  locale,
  accountScope,
}: {
  form: Omit<IssueCreateProps, 'project'> & { project?: CollaborationProject }
  api: SharedWorkspaceApi
  groups: ChatGroupApi | undefined
  store: 'local' | 'cloud'
  locale: 'zh-CN' | 'en'
  accountScope: string
}) {
  const { t } = useTranslation('collaboration')
  const [groupId, setGroupId] = useState(form.defaults?.parent?.group_id ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdGroup, setCreatedGroup] = useState<{
    owner: ChatGroupApi
    group: ChatGroup
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const request = useMemo(() => ({ groups, api, revision }), [groups, api, revision])
  const [catalog, setCatalog] = useState<{
    owner: object
    items: ChatGroup[]
    failed: boolean
  } | null>(null)
  const [prepared, setPrepared] = useState<{
    owner: object
    group: ChatGroup
    items: CollaborationIssue[]
  } | null>(null)
  const currentCatalog = catalog?.owner === request ? catalog : null
  const available = currentCatalog?.items ?? []
  const loading = Boolean(groups) && !currentCatalog
  const catalogError = !groups || currentCatalog?.failed ? t('loadFailed') : null
  const ready = prepared?.owner === request ? prepared : null
  const eligible = available.filter(
    group => group.status === 'active' && ['Owner', 'Maintainer', 'Developer'].includes(group.role)
  )
  const parentGroup = form.defaults?.parent?.group_id
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

  const scoped = useMemo<SharedWorkspaceApi | null>(() => {
    if (!ready || !groups) return null
    const groupApi = createGroupWorkspaceApi(api, groups, ready.group.id, store)
    const milestones = api.milestones
    const projectId = form.project?.id
    const milestoneScope = { groupId: ready.group.id, projectId }
    return {
      ...groupApi,
      issues: {
        ...groupApi.issues,
        create: (id, input) =>
          groupApi.issues.create(id, {
            ...input,
            ...(projectId ? { classificationProjectId: projectId } : {}),
          }),
      },
      milestones:
        milestones && projectId && ['local', 'backend'].includes(form.project?.task_provider ?? '')
          ? {
              getCacheScope: () => milestoneScope,
              list: () => milestones.list(projectId),
              create: (_id, input) => milestones.create(projectId, input),
              update: (_id, id, input) => milestones.update(projectId, id, input),
              remove: (_id, id, version) => milestones.remove(projectId, id, version),
            }
          : undefined,
    }
  }, [ready, groups, api, store, form.project?.id, form.project?.task_provider])

  if (ready && scoped) {
    const project = groupBoardContext(ready.group, store)
    const translate = form.translate ?? createCollaborationTranslator(locale)
    const desired = form.defaults?.status
    const statuses = projectStatuses(project, form.messages, translate)
    const supported = !desired || statuses.some(status => status.id === desired)
    return (
      <IssueCreate
        {...form}
        api={scoped}
        project={project}
        allIssues={ready.items}
        defaults={{
          ...form.defaults,
          tags: form.defaults?.tags ?? [],
          parent: form.defaults?.parent ?? null,
          status: supported && desired ? desired : statuses[0]!.id,
          draftScope: `thread-create:${accountScope}:${store}:${ready.group.id}:${form.project?.id ?? ''}:${form.defaults?.draftScope ?? ''}`,
        }}
        environmentReadiness={undefined}
        environmentNotice={
          <div className="space-y-1 text-sm text-text-muted" data-testid="thread-create-context">
            <p>
              {form.project
                ? t('threadCreateContext', { group: ready.group.name, project: form.project.name })
                : t('threadGroupContext', { group: ready.group.name })}
            </p>
            {!supported && <p>{t('threadGroupStatus')}</p>}
          </div>
        }
      />
    )
  }

  const next = async () => {
    if (!groups || busy || loading || (creatingGroup && !name.trim())) return
    setBusy(true)
    setError(null)
    try {
      if (form.defaults?.parent && !parentGroup) throw new Error(t('threadParentRequiresGroup'))
      let group = eligible.find(group => group.id === groupId)
      if (creatingGroup) {
        group = createdGroup?.owner === groups ? createdGroup.group : undefined
        if (!group) {
          group = (await groups.create({ name: name.trim() })).group
          setCreatedGroup({ owner: groups, group })
        }
      }
      if (!group || (parentGroup && parentGroup !== group.id)) throw new Error(t('selectGroup'))
      const [info, items] = await Promise.all([groups.get(group.id), api.issues.list(group.id)])
      if (
        info.group.status !== 'active' ||
        !['Owner', 'Maintainer', 'Developer'].includes(info.group.role)
      )
        throw new Error(t('readOnly'))
      const parent = form.defaults?.parent
      if (parent && !items.some(item => item.id === parent.id && item.group_id === group.id))
        throw new Error(t('threadParentUnavailable'))
      setPrepared({ owner: request, group: info.group, items })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('loadFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <TemplateDialog
      title={t('newThread')}
      description={t('threadChooseGroupHint')}
      closeLabel={t('close')}
      onClose={form.onClose}
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
        {form.project && (
          <p className="text-sm text-text-muted">
            {t('threadProjectTarget', { project: form.project.name })}
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
                setError(null)
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
            onClick={form.onClose}
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
