import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IssueCreate,
  createCollaborationTranslator,
  projectStatuses,
  type CollaborationIssue,
  type CollaborationProject,
  type IssueCreateProps,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { ChatGroup, ChatGroupApi } from '@/api/chatGroups'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { createGroupWorkspaceApi, groupBoardContext } from './groupWorkspaceApi'
import { ThreadGroupPicker } from './ThreadGroupPicker'

/** Project classification never chooses the owning group or imports its roster. */
export function ThreadCreateDialog({
  form,
  api,
  groups,
  store,
  locale,
  accountScope,
  externalForm,
  initialGroupId,
}: {
  form: Omit<IssueCreateProps, 'project'> & { project?: CollaborationProject }
  api: SharedWorkspaceApi
  groups: ChatGroupApi | undefined
  store: 'local' | 'cloud'
  locale: 'zh-CN' | 'en'
  accountScope: string
  externalForm?: IssueCreateProps
  initialGroupId?: string
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
            initialGroupId={initialGroupId}
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
      initialGroupId={initialGroupId}
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
  initialGroupId,
}: {
  form: Omit<IssueCreateProps, 'project'> & { project?: CollaborationProject }
  api: SharedWorkspaceApi
  groups: ChatGroupApi | undefined
  store: 'local' | 'cloud'
  locale: 'zh-CN' | 'en'
  accountScope: string
  initialGroupId?: string
}) {
  const { t } = useTranslation('collaboration')
  const owner = useMemo(
    () => ({
      api,
      groups,
      store,
      accountScope,
      projectId: form.project?.id,
      parentId: form.defaults?.parent?.id,
      initialGroupId,
    }),
    [api, groups, store, accountScope, form.project?.id, form.defaults?.parent?.id, initialGroupId]
  )
  const lifetime = useRef<object | null>(owner)
  useLayoutEffect(() => {
    lifetime.current = owner
    return () => {
      lifetime.current = null
    }
  }, [owner])
  const [prepared, setPrepared] = useState<{
    owner: object
    group: ChatGroup
    items: CollaborationIssue[]
  } | null>(null)
  if (prepared?.owner === owner)
    return (
      <PreparedThreadCreate
        form={form}
        api={api}
        groups={groups}
        store={store}
        locale={locale}
        accountScope={accountScope}
        group={prepared.group}
        items={prepared.items}
      />
    )
  const scopeKey = JSON.stringify([
    accountScope,
    store,
    form.project?.id,
    form.defaults?.parent?.id,
    initialGroupId,
  ])
  return (
    <ThreadGroupPicker
      key={scopeKey}
      groups={groups}
      scopeKey={scopeKey}
      parentGroup={form.defaults?.parent?.group_id}
      initialGroupId={initialGroupId}
      requireParentGroup={Boolean(form.defaults?.parent)}
      projectName={form.project?.name}
      onClose={form.onClose}
      onChoose={async group => {
        const items = await api.issues.list(group.id)
        if (lifetime.current !== owner) return
        const parent = form.defaults?.parent
        if (parent && !items.some(item => item.id === parent.id && item.group_id === group.id))
          throw new Error(t('threadParentUnavailable'))
        setPrepared({ owner, group, items })
      }}
    />
  )
}

function PreparedThreadCreate({
  form,
  api,
  groups,
  store,
  locale,
  accountScope,
  group,
  items,
}: {
  form: Omit<IssueCreateProps, 'project'> & { project?: CollaborationProject }
  api: SharedWorkspaceApi
  groups: ChatGroupApi | undefined
  store: 'local' | 'cloud'
  locale: 'zh-CN' | 'en'
  accountScope: string
  group: ChatGroup
  items: CollaborationIssue[]
}) {
  const { t } = useTranslation('collaboration')
  const scoped = useMemo<SharedWorkspaceApi | null>(() => {
    if (!groups) return null
    const groupApi = createGroupWorkspaceApi(api, groups, group.id, store)
    const milestones = api.milestones
    const projectId = form.project?.id
    const milestoneScope = { groupId: group.id, projectId }
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
  }, [group, groups, api, store, form.project?.id, form.project?.task_provider])
  if (scoped) {
    const project = groupBoardContext(group, store)
    const translate = form.translate ?? createCollaborationTranslator(locale)
    const desired = form.defaults?.status
    const statuses = projectStatuses(project, form.messages, translate)
    const supported = !desired || statuses.some(status => status.id === desired)
    return (
      <IssueCreate
        {...form}
        api={scoped}
        project={project}
        allIssues={items}
        defaults={{
          ...form.defaults,
          tags: form.defaults?.tags ?? [],
          parent: form.defaults?.parent ?? null,
          status: supported && desired ? desired : statuses[0]!.id,
          draftScope: `thread-create:${accountScope}:${store}:${group.id}:${form.project?.id ?? ''}:${form.defaults?.draftScope ?? ''}`,
        }}
        environmentReadiness={undefined}
        environmentNotice={
          <div className="space-y-1 text-sm text-text-muted" data-testid="thread-create-context">
            <p>
              {form.project
                ? t('threadCreateContext', { group: group.name, project: form.project.name })
                : t('threadGroupContext', { group: group.name })}
            </p>
            {!supported && <p>{t('threadGroupStatus')}</p>}
          </div>
        }
      />
    )
  }
  return null
}
