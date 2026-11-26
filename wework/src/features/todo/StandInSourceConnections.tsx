import type { StandInRole, StandInSourceConnection } from '@/api/personalStandIn'
import type { ConnectionProviderDescriptor, StandInExecutorApi } from '@/api/standIn'
import { LocalConnectorAuthDialog } from '@/components/plugins/LocalConnectorAuthDialog'
import { Button } from '@/components/ui/button'
import {
  isDingTalkDelegationSource,
  matchesDingTalkAccount,
} from '@/features/collaboration-exp/stand-in/dingtalkDelegation'
import { useTranslation } from '@/hooks/useTranslation'
import { Checkbox } from '@wegent/collaboration/controls/Checkbox'
import { Radio, RadioGroup } from '@wegent/collaboration/controls/RadioGroup'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { MessageSquare, Plus, Search, X } from 'lucide-react'
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { createSourceConnectionsModel } from './sourceConnectionsModel'
import { StandInConnectionHeader } from './StandInConnectionHeader'
import { StandInProcessingSettings } from './StandInProcessingSettings'

type SourceConnectionsProps = {
  role: StandInRole
  provider: ConnectionProviderDescriptor
  api: StandInExecutorApi
  deviceId: string
  localDeviceId: string
  disabled: boolean
  onChange(role: StandInRole): void
  onReady?(): void
  delegatedDingTalk?: boolean
}

export function StandInSourceConnections(props: SourceConnectionsProps) {
  const scope = JSON.stringify([
    props.deviceId,
    props.localDeviceId,
    props.role.id,
    props.role.executionDeviceId,
    props.provider.id,
    props.provider.authTarget?.pluginKey,
    props.provider.authTarget?.connectorSlug,
    props.delegatedDingTalk,
    props.delegatedDingTalk ? props.provider.availability.profile : undefined,
    props.delegatedDingTalk ? props.provider.availability.accountId : undefined,
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
  delegatedDingTalk = false,
}: SourceConnectionsProps) {
  const { t, i18n } = useTranslation('common')
  const input = useMemo(
    () => ({
      role,
      provider,
      api,
      deviceId,
      disabled,
      onChange,
      onReady,
      delegatedDingTalk,
      allResourcesLabel: t('standIn.workspace.all_resources'),
      cliUnavailableLabel: t('standIn.workspace.connection_cli_request_unavailable', {
        provider: provider.displayName,
      }),
    }),
    [role, provider, api, deviceId, disabled, onChange, onReady, delegatedDingTalk, t]
  )
  const [model] = useState(() => createSourceConnectionsModel(input))
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, input),
    [model, input]
  )
  const {
    adding,
    excluding,
    newPolicy,
    kind,
    scope,
    selection,
    query,
    results,
    nextCursor,
    busy,
    error,
    searched,
    authOpen,
  } = useSyncExternalStore(subscribe, model.getSnapshot, model.getSnapshot)
  const setAdding = (value: Parameters<typeof model.set<'adding'>>[1]) => model.set('adding', value)
  const setExcluding = (value: Parameters<typeof model.set<'excluding'>>[1]) =>
    model.set('excluding', value)
  const setNewPolicy = (value: Parameters<typeof model.set<'newPolicy'>>[1]) =>
    model.set('newPolicy', value)
  const setKind = (value: Parameters<typeof model.set<'kind'>>[1]) => model.set('kind', value)
  const setScope = (value: Parameters<typeof model.set<'scope'>>[1]) => model.set('scope', value)
  const setSelection = (value: Parameters<typeof model.set<'selection'>>[1]) =>
    model.set('selection', value)
  const setQuery = (value: Parameters<typeof model.set<'query'>>[1]) => model.set('query', value)
  const setResults = (value: Parameters<typeof model.set<'results'>>[1]) =>
    model.set('results', value)
  const setNextCursor = (value: Parameters<typeof model.set<'nextCursor'>>[1]) =>
    model.set('nextCursor', value)
  const setError = (value: Parameters<typeof model.set<'error'>>[1]) => model.set('error', value)
  const setSearched = (value: Parameters<typeof model.set<'searched'>>[1]) =>
    model.set('searched', value)
  const setAuthOpen = (value: Parameters<typeof model.set<'authOpen'>>[1]) =>
    model.set('authOpen', value)
  const { search, add, addAll, closeExclusionEditor, isConnected, identity } = model
  const authorizationRequired =
    provider.availability.status === 'auth_required' || error?.code === 'connector_auth_required'
  const allRows = role.connections ?? []
  const providerRows = allRows.filter(row => row.providerId === provider.id)
  const rows = providerRows.filter(
    row =>
      !delegatedDingTalk ||
      !provider.availability.accountId ||
      !row.accountId ||
      matchesDingTalkAccount(provider.availability, row)
  )
  const hiddenRows = providerRows.filter(row => !rows.includes(row))
  const prefix =
    provider.id === '@wegent/dsh-connection-dingtalk/dingtalk'
      ? 'stand-in-dingtalk'
      : 'stand-in-connection-' + provider.id
  const updateRows = (next: StandInSourceConnection[]) =>
    onChange({
      ...role,
      connections: [...allRows.filter(row => row.providerId !== provider.id), ...hiddenRows, ...next],
    })
  const authorization = authOpen && provider.authTarget && (
    <LocalConnectorAuthDialog
      open
      target={provider.authTarget}
      title={t('standIn.workspace.connect_source', { name: provider.displayName })}
      onCancel={() => setAuthOpen(false)}
      onSuccess={model.authorized}
    />
  )
  const connectedScope = (
    <div className="space-y-2">
      {rows.map(row => (
        <div
          key={`${row.profile}:${row.kind}:${row.id}`}
          className="flex flex-wrap items-center gap-2 border-b border-border/50 py-2"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{row.name}</p>
            <p className="text-xs text-text-secondary">
              {delegatedDingTalk
                ? t(
                    !isDingTalkDelegationSource(row)
                      ? 'standIn.dingtalk_delegation.source_reconfirm'
                      : row.kind === 'group'
                        ? 'standIn.dingtalk_delegation.group_mentions'
                        : 'standIn.dingtalk_delegation.direct'
                  )
                : `${provider.resourceLabels?.[row.kind] ?? row.kind} · ${row.configurationSummary ?? t('standIn.workspace.connection_default_configuration')}`}
            </p>
          </div>
          {delegatedDingTalk && isDingTalkDelegationSource(row) && (
            <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
              <Checkbox
                data-testid={`${prefix}-pause-${row.id}`}
                aria-label={t('standIn.dingtalk_delegation.pause_source', { name: row.name })}
                checked={row.paused === true}
                disabled={disabled}
                onCheckedChange={checked =>
                  updateRows(rows.map(value => value === row ? { ...value, paused: checked === true } : value))
                }
              />
              {t('standIn.dingtalk_delegation.paused')}
            </label>
          )}
          {!delegatedDingTalk && provider.id === '@wegent/dsh-connection-dingtalk/dingtalk' &&
            row.kind === 'group' &&
            row.scope !== 'all' && (
              <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                {t('standIn.workspace.group_message_scope')}
                <SelectRoot
                  value={normalizeSelectValue(row.collectionKey ?? 'mentions')}
                  disabled={disabled}
                  onValueChange={selectedValue => {
                    if (selectedValue === null) return
                    const allMessages = selectedValue === 'all-messages'
                    updateRows(
                      rows.map(value => {
                        if (value !== row) return value
                        const next = { ...value }
                        if (allMessages) next.collectionKey = 'all-messages'
                        else delete next.collectionKey
                        next.configurationSummary = t(
                          allMessages
                            ? 'standIn.workspace.group_all_messages'
                            : 'standIn.workspace.group_mentions'
                        )
                        return next
                      })
                    )
                  }}
                >
                  <SelectTrigger
                    density="compact"
                    data-testid={`${prefix}-message-scope-${row.id}`}
                    aria-label={t('standIn.workspace.group_message_scope_for', { name: row.name })}
                    className="[&>option]:bg-background [&>option]:text-text-primary"
                  />
                  <SelectContent>
                    <SelectItem value="mentions">
                      {t('standIn.workspace.group_mentions')}
                    </SelectItem>
                    <SelectItem value="all-messages">
                      {t('standIn.workspace.group_all_messages')}
                    </SelectItem>
                  </SelectContent>
                </SelectRoot>
              </label>
            )}
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${prefix}-remove-${row.id}`}
            aria-label={t('standIn.workspace.remove_connection', { name: row.name })}
            disabled={disabled}
            onClick={() => {
              if (excluding && identity(excluding) === identity(row)) closeExclusionEditor()
              updateRows(rows.filter(value => value !== row))
            }}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </ControlButton>
          {!delegatedDingTalk && provider.id === '@wegent/dsh-connection-dingtalk/dingtalk' && row.scope === 'all' && (
            <div className="w-full space-y-2">
              <p className="text-sm">{t('standIn.workspace.connection_blacklist')}</p>
              {row.excludedResources?.map(resource => (
                <div key={resource.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{resource.name}</span>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`${prefix}-blacklist-remove-${row.kind}-${row.profile}-${resource.id}`}
                    aria-label={t('standIn.workspace.blacklist_remove', { name: resource.name })}
                    disabled={disabled}
                    onClick={() =>
                      updateRows(
                        rows.map(value =>
                          value === row
                            ? {
                                ...value,
                                excludedResources: value.excludedResources?.filter(
                                  item => item.id !== resource.id
                                ),
                              }
                            : value
                        )
                      )
                    }
                    className="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-muted md:min-h-8 md:min-w-8"
                  >
                    <X className="h-4 w-4" />
                  </ControlButton>
                </div>
              ))}
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${prefix}-blacklist-add-${row.kind}-${row.profile}`}
                disabled={disabled || busy || authorizationRequired}
                onClick={() => {
                  model.invalidateSearch()
                  setAdding(false)
                  setExcluding(row)
                  setKind(row.kind)
                  setScope('selected')
                  setSelection([])
                  setQuery('')
                  setResults([])
                  setNextCursor(undefined)
                  setSearched(false)
                  setError(null)
                }}
                className="min-h-11 text-sm underline md:min-h-8"
              >
                {t('standIn.workspace.blacklist_add')}
              </ControlButton>
            </div>
          )}
        </div>
      ))}
    </div>
  )
  if (authorizationRequired)
    return (
      <section
        className="space-y-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
        data-testid={`${prefix}-authorization`}
      >
        <StandInConnectionHeader
          icon={MessageSquare}
          title={provider.displayName}
          description={t('standIn.workspace.message_connection_help')}
        />
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
        {connectedScope}
        {authorization}
      </section>
    )
  const showAdding = excluding || adding || rows.length === 0
  return (
    <section
      className="space-y-4 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11"
      data-testid={`${prefix}-connections`}
    >
      {!delegatedDingTalk && (
        <StandInConnectionHeader
          icon={MessageSquare}
          title={provider.displayName}
          description={t('standIn.workspace.message_connection_help')}
        />
      )}
      {connectedScope}
      {!showAdding && (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid={`${prefix}-add`}
          disabled={disabled}
          onClick={() => {
            setAdding(value => !value)
            setSelection([])
            setError(null)
          }}
          className="inline-flex min-h-9 items-center gap-2 text-sm text-text-secondary hover:underline"
        >
          <Plus className="h-4 w-4" />
          {t('standIn.workspace.add_connection')}
        </ControlButton>
      )}
      {showAdding && (
        <form
          onSubmit={event => {
            event.preventDefault()
            void search()
          }}
          className="space-y-3"
        >
          {excluding && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm">
                {t('standIn.workspace.blacklist_help', { name: excluding.name })}
              </p>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${prefix}-blacklist-cancel`}
                onClick={closeExclusionEditor}
                className="min-h-11 text-sm underline md:min-h-8"
              >
                {t('standIn.workspace.blacklist_cancel')}
              </ControlButton>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {scope === 'selected' && !excluding && (
              <SelectRoot
                value={normalizeSelectValue(kind)}
                disabled={busy}
                onValueChange={selectedValue => {
                  if (selectedValue === null) return

                  setKind(selectedValue)
                  setScope('selected')
                  setResults([])
                  setNextCursor(undefined)
                  setSearched(false)
                }}
              >
                <SelectTrigger
                  aria-label={t('standIn.workspace.message_kind')}
                  data-testid={`${prefix}-kind`}
                  className="min-h-11 md:min-h-9"
                />
                <SelectContent>
                  {provider.resourceKinds.map(resourceKind => (
                    <SelectItem key={resourceKind} value={String(resourceKind)}>
                      {provider.resourceLabels?.[resourceKind] ?? resourceKind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectRoot>
            )}
            {scope === 'selected' && (
              <>
                <ControlInput
                  aria-label={t('standIn.workspace.search_connections')}
                  data-testid={`${prefix}-query`}
                  value={query}
                  onChange={event => {
                    model.invalidateSearch()
                    setQuery(event.target.value)
                    setResults([])
                    setNextCursor(undefined)
                    setSearched(false)
                  }}
                  className="min-h-11 min-w-0 flex-1 bg-transparent md:min-h-9"
                  placeholder={t('standIn.workspace.search_connections')}
                />
                <ControlButton
                  variant="outline"
                  size="sm"
                  type="submit"
                  data-testid={`${prefix}-search`}
                  disabled={disabled || busy || !query.trim()}
                  className="flex min-h-9 items-center gap-1 rounded-md border border-border px-3 text-sm disabled:opacity-50"
                >
                  <Search className="h-4 w-4" />
                  {t('standIn.workspace.search')}
                </ControlButton>
              </>
            )}
          </div>
          {!delegatedDingTalk && !excluding && Boolean(provider.allResourceKinds?.length) && (
            <RadioGroup
              value={scope}
              name="connection-scope"
              aria-label={t('standIn.workspace.connection_scope')}
              onValueChange={next => {
                if (next === 'all' || next === 'selected') {
                  setScope(next)
                  setError(null)
                }
              }}
              render={<fieldset />}
              className="flex flex-wrap gap-4"
              disabled={disabled || busy}
            >
              <legend className="mb-2 w-full text-sm font-medium">
                {t('standIn.workspace.connection_scope')}
              </legend>
              {(['all', 'selected'] as const).map(value => (
                <label key={value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                  <Radio value={value} data-testid={`${prefix}-scope-${value}`} />
                  {value === 'all'
                    ? (provider.allResourceLabel ?? t('standIn.workspace.all_resources'))
                    : t('standIn.workspace.selected_resources')}
                </label>
              ))}
            </RadioGroup>
          )}
          {scope === 'all' && (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">
                {t('standIn.workspace.all_resources_help')}{' '}
                {new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(
                  (provider.allResourceKinds ?? []).map(
                    resourceKind =>
                      provider.allResourceLabels?.[resourceKind] ??
                      provider.resourceLabels?.[resourceKind] ??
                      resourceKind
                  )
                )}
              </p>
              <Button
                size="sm"
                type="button"
                data-testid={`${prefix}-add-all`}
                disabled={disabled || busy}
                onClick={() => void addAll()}
                className="h-8"
              >
                {t('standIn.workspace.connect_all')}
              </Button>
            </div>
          )}
          {busy && (
            <p role="status" className="text-sm text-text-secondary">
              {t('standIn.loading')}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm text-error">
              <p>{error.message}</p>
            </div>
          )}
          {scope === 'selected' && searched && !results.length && (
            <p className="text-sm text-text-secondary">
              {t('standIn.workspace.no_connections_found')}
            </p>
          )}
          {scope === 'selected' && (
            <>
              {results.some(row => !isConnected(row)) && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`${prefix}-select-results`}
                  disabled={disabled || busy}
                  className="min-h-8 text-sm underline"
                  onClick={() =>
                    setSelection(previous => [
                      ...previous,
                      ...results.filter(
                        row =>
                          !isConnected(row) &&
                          !previous.some(value => identity(value) === identity(row))
                      ),
                    ])
                  }
                >
                  {t('standIn.workspace.select_results')}
                </ControlButton>
              )}
              <div className="max-h-52 overflow-y-auto">
                {results.map(row => {
                  const connected = isConnected(row)
                  const selected = selection.some(value => identity(value) === identity(row))
                  return (
                    <label
                      key={identity(row)}
                      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        data-testid={`${prefix}-result-${row.id}`}
                        disabled={disabled || connected}
                        checked={connected || selected}
                        onCheckedChange={checked =>
                          setSelection(previous =>
                            checked === true
                              ? previous.some(value => identity(value) === identity(row))
                                ? previous
                                : [...previous, row]
                              : previous.filter(value => identity(value) !== identity(row))
                          )
                        }
                      />
                      <span>{row.name}</span>
                      <span>
                        {t(
                          connected
                            ? excluding
                              ? 'standIn.workspace.blacklisted'
                              : 'standIn.workspace.connected'
                            : selected
                              ? 'standIn.workspace.resource_selected'
                              : 'standIn.workspace.select_resource'
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
              {nextCursor && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`${prefix}-search-more`}
                  disabled={busy || disabled}
                  className="min-h-9 text-sm underline"
                  onClick={() => void search(nextCursor)}
                >
                  {t('standIn.workspace.load_more')}
                </ControlButton>
              )}
              {selection.length > 0 && (
                <div className="flex items-center gap-3">
                  <Button
                    size="sm"
                    type="button"
                    data-testid={`${prefix}-add-selected`}
                    disabled={disabled || busy}
                    className="min-h-9 rounded-md bg-text-primary px-3 text-sm text-background disabled:opacity-50"
                    onClick={() => add(selection)}
                  >
                    {t('standIn.workspace.add_selected', { count: selection.length })}
                  </Button>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`${prefix}-clear-selection`}
                    disabled={disabled || busy}
                    className="min-h-9 text-sm underline"
                    onClick={() => setSelection([])}
                  >
                    {t('standIn.workspace.clear_selection')}
                  </ControlButton>
                </div>
              )}
            </>
          )}
          <p className="text-xs text-text-secondary">{t('standIn.workspace.connection_help')}</p>
        </form>
      )}
      {!delegatedDingTalk && <StandInProcessingSettings
        disabled={disabled}
        rows={
          rows.length
            ? rows.map(row => ({
                key: identity(row),
                name: row.name,
                policy: row.policy,
                outbound: provider.id === '@wegent/dsh-connection-dingtalk/dingtalk',
                testId: `${prefix}-policy-${row.id}`,
                onChange: policy =>
                  updateRows(rows.map(value => (value === row ? { ...value, policy } : value))),
              }))
            : [
                {
                  key: 'new',
                  name: provider.displayName,
                  policy: newPolicy,
                  outbound: provider.id === '@wegent/dsh-connection-dingtalk/dingtalk',
                  testId: `${prefix}-new-policy`,
                  onChange: policy =>
                    setNewPolicy({ ...policy, immediate: policy.immediate ?? false }),
                },
              ]
        }
      />}
      {authorization}
    </section>
  )
}
