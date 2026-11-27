import {
  STAND_IN_DINGTALK_PROVIDER,
  type StandInHandlingPolicy,
  type StandInRole,
  type StandInSourceConnection,
} from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import { Search } from 'lucide-react'
import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ConnectionChoice,
  ConnectionRulePicker,
  type ConnectionScopeRule,
} from './ConnectionScopeFields'
import { ConnectionScopeList, ConnectionScopeRow } from './ConnectionScopeList'
import { useConnectionScopeBack, useConnectionScopeTitle } from './connectionScopeNavigation'
import { createSourceConnectionsModel, hasAllDingTalkMessages } from './sourceConnectionsModel'
import { StandInConnectionForm } from './StandInConnectionForm'
import { StandInProcessingSettings } from './StandInProcessingSettings'
import { StandInSourceNavigationContext } from './standInOverviewSource'

type SourceConnectionsProps = {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  onReady?(): void
}

export function StandInSourceConnections(props: SourceConnectionsProps) {
  const scope = JSON.stringify([
    props.deviceId,
    props.localDeviceId,
    props.role.id,
    props.role.executionDeviceId,
    props.provider.id,
    props.provider.availability.profile,
    props.provider.authTarget?.pluginKey,
    props.provider.authTarget?.connectorSlug,
  ])
  const [owner, setOwner] = useState({ api: props.api, scope, revision: 0 })
  if (owner.api !== props.api || owner.scope !== scope)
    setOwner({ api: props.api, scope, revision: owner.revision + 1 })
  return <StandInSourceConnectionsContent key={owner.revision} {...props} />
}

function StandInSourceConnectionsContent({
  role,
  provider,
  api,
  deviceId,
  localDeviceId,
  disabled,
  onChange,
  onReady,
}: SourceConnectionsProps) {
  const { t } = useTranslation('common')
  const requestedSourceId = useContext(StandInSourceNavigationContext)
  const focusedRequestedSource = useRef(false)
  const focusTarget = (target: HTMLElement) => {
    if (focusedRequestedSource.current) return
    focusedRequestedSource.current = true
    target.scrollIntoView?.({ block: 'center' })
    target.focus({ preventScroll: true })
  }
  const focusRequestedSource = (node: HTMLButtonElement | null) => {
    if (node && requestedSourceId) focusTarget(node)
  }
  const focusRequestedSourceFallback = (node: HTMLElement | null) => {
    if (
      !node ||
      !requestedSourceId ||
      focusedRequestedSource.current ||
      !rows.some(row => row.id === requestedSourceId)
    )
      return
    focusTarget(node)
  }
  const input = useMemo(
    () => ({
      role,
      provider,
      api,
      deviceId,
      disabled,
      onChange,
      onReady,
      allResourcesLabel: t('standIn.workspace.all_resources'),
      allMessagesLabel: t('standIn.workspace.dingtalk_every_group_message'),
      cliUnavailableLabel: t('standIn.workspace.connection_cli_request_unavailable', {
        provider: provider.displayName,
      }),
    }),
    [role, provider, api, deviceId, disabled, onChange, onReady, t]
  )
  const [model] = useState(() => createSourceConnectionsModel(input))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const { kind, query, results, nextCursor, busy, error, searched, authOpen } =
    useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const setKind = (value: Parameters<typeof model.set<'kind'>>[1]) => model.set('kind', value)
  const setQuery = (value: Parameters<typeof model.set<'query'>>[1]) => model.set('query', value)
  const setResults = (value: Parameters<typeof model.set<'results'>>[1]) =>
    model.set('results', value)
  const setNextCursor = (value: Parameters<typeof model.set<'nextCursor'>>[1]) =>
    model.set('nextCursor', value)
  const setSearched = (value: Parameters<typeof model.set<'searched'>>[1]) =>
    model.set('searched', value)
  const setAuthOpen = (value: Parameters<typeof model.set<'authOpen'>>[1]) =>
    model.set('authOpen', value)
  const { search, select, selectAll, setAllDingTalkMessages, changeDingTalkRule, identity } = model
  const [editor, setScopeEditor] = useState<'choose' | 'all' | 'kind' | 'item' | null>(null)
  const setScopeTitle = useConnectionScopeTitle()
  const setEditor = (next: typeof editor, title?: string) => {
    setScopeEditor(next)
    setScopeTitle?.(
      next === 'choose'
        ? t('standIn.workspace.connection_add_scope')
        : next === 'all'
          ? t('standIn.workspace.dingtalk_every_message')
          : (title ?? null)
    )
  }
  const [editingItem, setEditingItem] = useState<string | null>(null)
  const [editedRule, setEditedRule] = useState<ConnectionScopeRule | null>(null)
  const authorizationRequired =
    provider.availability.status === 'auth_required' || error?.code === 'connector_auth_required'
  const allRows = role.connections ?? []
  const rows = allRows.filter(row => row.providerId === provider.id)
  const dingTalk = provider.id === STAND_IN_DINGTALK_PROVIDER
  const profile = provider.availability.profile
  const accountRows = rows.filter(row => !dingTalk || row.profile === profile)
  const otherAccountRows = rows.filter(row => dingTalk && row.profile !== profile)
  const complete = hasAllDingTalkMessages(accountRows)
  const prefix = dingTalk ? 'stand-in-dingtalk' : 'stand-in-connection-' + provider.id
  const updateRows = model.replaceProviderRows
  const kindRows = accountRows.filter(row => !dingTalk || row.kind === kind)
  const editedItem =
    editor === 'item' ? accountRows.find(row => identity(row) === editingItem) : undefined
  const wildcard = kindRows.find(row => row.scope === 'all')
  const rule =
    editedRule ??
    (wildcard
      ? wildcard.excludedResources?.length
        ? 'exclude'
        : 'all'
      : kindRows.length
        ? 'include'
        : 'off')
  const showResults = dingTalk
    ? rule === 'include' || rule === 'exclude'
    : provider.resourceKinds.some(
        resourceKind => !accountRows.some(row => row.kind === resourceKind && row.scope === 'all')
      )
  const triggerLabel = t('standIn.workspace.connection_trigger')
  const editable = !disabled && !busy && Boolean(profile)
  const [kindParent, setKindParent] = useState<'choose' | 'all' | null>(null)
  const goToKind = (nextKind: string, parent: 'choose' | 'all' | null = null) => {
    setKindParent(parent)
    model.resetSearch()
    setEditedRule(null)
    setKind(nextKind)
    setEditor('kind', kindLabel(nextKind))
  }
  useConnectionScopeBack(
    editor
      ? () => {
          model.resetSearch()
          setEditor(editor === 'kind' ? kindParent : null)
        }
      : null
  )
  const chooseRule = (next: ConnectionScopeRule) => {
    setEditedRule(next)
    changeDingTalkRule(kind, next)
  }
  const wildcardLabel = t(
    kind === 'group'
      ? 'standIn.workspace.dingtalk_all_groups'
      : 'standIn.workspace.dingtalk_all_direct_messages'
  )
  const selectedLabel = t(
    kind === 'group'
      ? 'standIn.workspace.dingtalk_selected_groups'
      : 'standIn.workspace.dingtalk_selected_contacts'
  )
  const kindLabel = (resourceKind: string) =>
    t(
      resourceKind === 'group'
        ? 'standIn.workspace.connection_source_group'
        : 'standIn.workspace.connection_source_direct'
    )
  const authorization = authOpen && provider.authTarget && (
    <LocalConnectorAuthDialog
      open
      target={provider.authTarget}
      title={t('standIn.workspace.connect_source', { name: provider.displayName })}
      onCancel={() => setAuthOpen(false)}
      onSuccess={model.authorized}
    />
  )
  const groupMessagePicker = (row: StandInSourceConnection) => (
    <ConnectionChoice
      key={identity(row)}
      label={kindRows.length === 1 ? triggerLabel : row.name}
      value={row.collectionKey === 'all-messages' ? 'all-messages' : 'mentions'}
      disabled={disabled || authorizationRequired}
      testId={`${prefix}-message-scope-${row.id}`}
      options={[
        { value: 'all-messages', label: t('standIn.workspace.trigger_new_message') },
        { value: 'mentions', label: t('standIn.workspace.group_mentions') },
      ]}
      onChange={value => {
        const all = value === 'all-messages'
        const next = {
          ...row,
          configurationSummary: t(
            all ? 'standIn.workspace.group_all_messages' : 'standIn.workspace.group_mentions'
          ),
        }
        if (all) next.collectionKey = 'all-messages'
        else delete next.collectionKey
        if (next.scope === 'all')
          next.name = all
            ? t('standIn.workspace.dingtalk_every_group_message')
            : (provider.allResourceLabels?.group ?? t('standIn.workspace.group_mentions'))
        updateRows(rows.map(existing => (existing === row ? next : existing)))
      }}
    />
  )
  const visibleRows = authorizationRequired ? accountRows : kindRows
  const concreteRows = visibleRows.filter(row => row.scope !== 'all')
  const exact = new Map(concreteRows.map(row => [identity(row), row]))
  const excludedRows = visibleRows
    .filter(row => row.scope === 'all')
    .flatMap(({ providerId, profile, kind, excludedResources }) =>
      (excludedResources ?? []).map(({ id, name }) => ({ providerId, profile, kind, id, name }))
    )
  const resultsById = new Map(
    [...concreteRows, ...excludedRows, ...results]
      .filter(row => !dingTalk || row.profile === profile)
      .map(row => [identity(row), row])
  )
  const savedScope = [...resultsById].map(([id, row]) => {
    const all = accountRows.find(
      value => value.scope === 'all' && value.kind === row.kind && value.profile === row.profile
    )
    const concrete = exact.get(id)
    const excluded = all?.excludedResources?.some(resource => resource.id === row.id)
    const covered = Boolean(all && !excluded)
    return (
      <div key={id} className="flex flex-wrap items-center gap-x-3 text-sm">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 md:min-h-8">
          <Checkbox
            data-testid={`${prefix}-result-${row.id}`}
            checked={
              dingTalk && rule === 'exclude' ? Boolean(excluded) : Boolean(concrete) || covered
            }
            disabled={
              disabled || busy || (authorizationRequired && !concrete) || (covered && !dingTalk)
            }
            onCheckedChange={checked =>
              select(row, (checked === true) !== (dingTalk && rule === 'exclude'))
            }
          />
          <span className="min-w-0 break-words">{row.name}</span>
          {!dingTalk && covered && (
            <span className="text-xs text-text-secondary">
              {t('standIn.workspace.connection_included')}
            </span>
          )}
        </label>
      </div>
    )
  })
  const allScope = [
    ...new Set([
      ...(authorizationRequired ? [] : (provider.allResourceKinds ?? [])),
      ...accountRows.filter(row => row.scope === 'all').map(row => row.kind),
    ]),
  ].map(resourceKind => {
    const selection = accountRows.find(row => row.scope === 'all' && row.kind === resourceKind)
    return (
      <div key={resourceKind} className="flex flex-wrap items-center gap-x-3 text-sm">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 md:min-h-8">
          <Checkbox
            data-testid={`${prefix}-scope-all-${resourceKind}`}
            checked={Boolean(selection)}
            disabled={disabled || busy || (authorizationRequired && !selection)}
            onCheckedChange={value => void selectAll(resourceKind, value === true)}
          />
          <span>
            {dingTalk && resourceKind === 'group'
              ? t('standIn.workspace.dingtalk_all_groups')
              : (provider.allResourceLabels?.[resourceKind] ??
                provider.allResourceLabel ??
                t('standIn.workspace.all_resources'))}
          </span>
        </label>
      </div>
    )
  })
  const storedOtherAccounts = otherAccountRows.length > 0 && (
    <section className="space-y-2 border-t border-border pt-3">
      <h4 className="text-sm font-medium">{t('standIn.workspace.connection_other_accounts')}</h4>
      {otherAccountRows.map(row => (
        <label key={identity(row)} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
          <Checkbox
            data-testid={`${prefix}-result-${row.kind}-${row.id}-${row.profile}`}
            checked
            disabled={disabled}
            onCheckedChange={() => updateRows(rows.filter(value => value !== row))}
          />
          {row.name} · {row.profile}
        </label>
      ))}
    </section>
  )
  const effectivePolicy = (policy: StandInHandlingPolicy) => ({
    ...policy,
    immediate: policy.immediate ?? true,
    sessionStrategy: policy.sessionStrategy ?? 'reuse',
  })
  const combinePolicies =
    dingTalk &&
    editor === 'all' &&
    complete &&
    accountRows.length === 2 &&
    dequal(effectivePolicy(accountRows[0].policy), effectivePolicy(accountRows[1].policy))
  const visiblePolicies = editedItem
    ? [editedItem]
    : dingTalk && editor === 'kind'
      ? kindRows
      : accountRows
  const policyRows = (combinePolicies ? accountRows.slice(0, 1) : visiblePolicies).map(row => ({
    key: identity(row),
    name: combinePolicies ? t('standIn.workspace.dingtalk_every_message') : row.name,
    policy: row.policy,
    outbound: role.id !== '@primary' && dingTalk,
    testId:
      row.scope === 'all'
        ? `${prefix}-policy-all-${combinePolicies ? 'messages' : row.kind}`
        : `${prefix}-policy-${row.id}`,
    onChange: (policy: StandInHandlingPolicy) =>
      updateRows(
        rows.map(value =>
          (combinePolicies ? accountRows.includes(value) : value === row)
            ? { ...value, policy }
            : value
        )
      ),
  }))
  const queryLabel = t(
    dingTalk
      ? kind === 'group'
        ? 'standIn.workspace.dingtalk_search_groups'
        : 'standIn.workspace.dingtalk_search_contacts'
      : 'standIn.workspace.search_connections'
  )
  const accountName =
    [provider.availability.accountName, provider.availability.organizationName]
      .filter(Boolean)
      .join(' · ') ||
    provider.availability.accountId ||
    provider.availability.profile
  if (authorizationRequired)
    return (
      <section
        ref={focusRequestedSourceFallback}
        tabIndex={requestedSourceId ? -1 : undefined}
        className="space-y-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
        data-testid={`${prefix}-authorization`}
      >
        <StandInConnectionForm
          compact={dingTalk}
          account={
            <>
              <p role="alert" className="text-sm text-text-secondary">
                {t('standIn.errors.connector_auth_required')}
              </p>
              {provider.authTarget && deviceId === localDeviceId ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`${prefix}-connect`}
                  disabled={disabled}
                  onClick={() => setAuthOpen(true)}
                  className="min-h-9 text-sm underline"
                >
                  {t('standIn.workspace.connect_source', { name: provider.displayName })}
                </ControlButton>
              ) : (
                <p className="text-sm text-text-secondary">
                  {t('standIn.workspace.authorize_on_device')}
                </p>
              )}
            </>
          }
          scope={
            <>
              {allScope}
              {savedScope}
              {storedOtherAccounts}
            </>
          }
        />
        {authorization}
      </section>
    )
  return (
    <section
      ref={focusRequestedSourceFallback}
      tabIndex={requestedSourceId ? -1 : undefined}
      className="space-y-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
      data-testid={`${prefix}-connections`}
    >
      <StandInConnectionForm
        compact={dingTalk}
        account={
          <p className="text-sm">
            {accountName ?? t('standIn.workspace.connection_account_ready')}
          </p>
        }
        scope={
          <>
            {dingTalk && !editor && (
              <>
                <ConnectionScopeList
                  disabled={!editable}
                  empty={
                    accountRows.length ? undefined : t('standIn.workspace.dingtalk_not_receiving')
                  }
                  testId={`${prefix}-add-scope`}
                  onAdd={() => setEditor('choose')}
                >
                  {complete ? (
                    <ConnectionScopeRow
                      name={t('standIn.workspace.dingtalk_every_message')}
                      description={t('standIn.workspace.dingtalk_every_message_help')}
                      ref={
                        accountRows.some(row => row.id === requestedSourceId)
                          ? focusRequestedSource
                          : undefined
                      }
                      testId={`${prefix}-open-all-scope`}
                      disabled={!editable}
                      onClick={() => setEditor('all')}
                      onRemove={() => updateRows(otherAccountRows)}
                    />
                  ) : (
                    accountRows.map(row => (
                      <ConnectionScopeRow
                        key={identity(row)}
                        name={
                          row.kind === 'direct' && row.scope === 'all'
                            ? t('standIn.workspace.dingtalk_all_direct_messages')
                            : row.name
                        }
                        description={[
                          row.kind === 'group'
                            ? t(
                                row.collectionKey === 'all-messages'
                                  ? 'standIn.workspace.trigger_new_message'
                                  : 'standIn.workspace.group_mentions'
                              )
                            : row.scope !== 'all'
                              ? kindLabel(row.kind)
                              : null,
                          row.excludedResources?.length
                            ? t('standIn.workspace.connection_excluded_count', {
                                count: row.excludedResources.length,
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        testId={`${prefix}-open-scope-${row.kind}-${row.id}`}
                        disabled={!editable}
                        ref={row.id === requestedSourceId ? focusRequestedSource : undefined}
                        onRemove={() => updateRows(rows.filter(value => value !== row))}
                        onClick={() => {
                          if (row.scope === 'all') {
                            goToKind(row.kind)
                          } else {
                            model.resetSearch()
                            setKind(row.kind)
                            setEditingItem(identity(row))
                            setEditor('item', row.name)
                          }
                        }}
                      />
                    ))
                  )}
                </ConnectionScopeList>
                {storedOtherAccounts}
              </>
            )}
            {dingTalk && editor && (
              <div className="space-y-2">
                {editor === 'item' ? (
                  editedItem && (
                    <>
                      {editedItem.kind === 'group' && groupMessagePicker(editedItem)}
                      <ControlButton
                        variant="outline"
                        type="button"
                        size="sm"
                        disabled={!editable}
                        data-testid={`${prefix}-remove-item-scope`}
                        onClick={() => {
                          updateRows(rows.filter(row => row !== editedItem))
                          setEditor(null)
                        }}
                      >
                        {t('standIn.workspace.connection_remove_scope')}
                      </ControlButton>
                    </>
                  )
                ) : editor === 'choose' || editor === 'all' ? (
                  <>
                    <ul className="divide-y divide-border">
                      {editor === 'choose' && !complete && (
                        <ConnectionScopeRow
                          name={t('standIn.workspace.dingtalk_every_message')}
                          description={t('standIn.workspace.dingtalk_every_message_help')}
                          testId={`${prefix}-scope-all`}
                          disabled={!editable}
                          direct
                          onClick={() => {
                            setAllDingTalkMessages()
                            setEditor(null)
                          }}
                        />
                      )}
                      {['group', 'direct'].map(resourceKind => (
                        <ConnectionScopeRow
                          key={resourceKind}
                          name={kindLabel(resourceKind)}
                          testId={`${prefix}-kind-${resourceKind}`}
                          disabled={!editable}
                          onClick={() => goToKind(resourceKind, editor)}
                        />
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    {rule === 'off' ? (
                      <ul className="divide-y divide-border">
                        <ConnectionScopeRow
                          name={wildcardLabel}
                          testId={`${prefix}-choose-all`}
                          disabled={!editable}
                          onClick={() => chooseRule('all')}
                        />
                        <ConnectionScopeRow
                          name={selectedLabel}
                          testId={`${prefix}-choose-selected`}
                          disabled={!editable}
                          onClick={() => chooseRule('include')}
                        />
                      </ul>
                    ) : (
                      <ConnectionRulePicker
                        value={rule}
                        rules={['all', 'include', 'exclude']}
                        labels={{ all: wildcardLabel, include: selectedLabel }}
                        onChange={chooseRule}
                        disabled={!editable}
                        testId={`${prefix}-rule`}
                      />
                    )}
                  </>
                )}
              </div>
            )}
            {!dingTalk && allScope}
            {(!dingTalk || editor === 'kind') && showResults && (
              <>
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    void search()
                  }}
                >
                  {!dingTalk && provider.resourceKinds.length > 1 && (
                    <SelectRoot
                      value={normalizeSelectValue(kind)}
                      disabled={disabled || busy}
                      onValueChange={value => {
                        if (value === null) return
                        setKind(value)
                        setResults([])
                        setNextCursor(undefined)
                        setSearched(false)
                      }}
                    >
                      <SelectTrigger
                        aria-label={t('standIn.workspace.message_kind')}
                        data-testid={`${prefix}-kind`}
                      />
                      <SelectContent>
                        {provider.resourceKinds.map(value => (
                          <SelectItem key={value} value={value}>
                            {provider.resourceLabels?.[value] ?? value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  )}
                  <ControlInput
                    data-testid={`${prefix}-query`}
                    value={query}
                    disabled={disabled || busy}
                    onChange={event => {
                      setQuery(event.target.value)
                      setResults([])
                      setNextCursor(undefined)
                      setSearched(false)
                    }}
                    className="min-w-0 flex-1"
                    aria-label={queryLabel}
                    placeholder={queryLabel}
                  />
                  <ControlButton
                    variant="outline"
                    size="sm"
                    type="submit"
                    data-testid={`${prefix}-search`}
                    disabled={disabled || busy || !query.trim()}
                  >
                    <Search className="h-4 w-4" />
                    {t('standIn.workspace.search')}
                  </ControlButton>
                </form>
                {savedScope.length > 0 && (
                  <div className="max-h-48 overflow-y-auto">{savedScope}</div>
                )}
                {busy && <p role="status">{t('standIn.loading')}</p>}
                {error && (
                  <p role="alert" className="text-sm text-error">
                    {error.message}
                  </p>
                )}
                {searched && !results.length && (
                  <p>{t('standIn.workspace.no_connections_found')}</p>
                )}
                {nextCursor && (
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`${prefix}-search-more`}
                    disabled={disabled || busy}
                    onClick={() => void search(nextCursor)}
                  >
                    {t('standIn.workspace.load_more')}
                  </ControlButton>
                )}
              </>
            )}
            {dingTalk && editor === 'kind' && kind === 'group' && kindRows.length > 0 && (
              <div className="space-y-2">
                {kindRows.length > 1 && <h4 className="text-sm font-medium">{triggerLabel}</h4>}
                {kindRows.map(groupMessagePicker)}
              </div>
            )}
            {dingTalk && editor === 'kind' && kindRows.length > 0 && (
              <ControlButton
                variant="outline"
                type="button"
                size="sm"
                className="self-start"
                disabled={!editable}
                data-testid={`${prefix}-remove-kind-scope`}
                onClick={() => {
                  changeDingTalkRule(kind, 'off')
                  setEditor(null)
                }}
              >
                {t('standIn.workspace.connection_remove_scope')}
              </ControlButton>
            )}
          </>
        }
        processing={
          policyRows.length > 0 &&
          (!dingTalk || editor === 'kind' || editor === 'all' || editor === 'item') && (
            <StandInProcessingSettings compact={dingTalk} disabled={disabled} rows={policyRows} />
          )
        }
      />
      {authorization}
    </section>
  )
}
