import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from 'react'
import { Layers3, RefreshCw } from 'lucide-react'
import type { CollaborationLocale } from '../i18n'
import { templateIdentity, type TemplateRecord } from './types'
import type { CollaborationTemplateStore } from './store'
import { useTemplateRecords } from './context'
import { localizeBuiltinTemplateRecord } from './builtins'
import { templateMessages } from './messages'
import { TemplatePanel } from './TemplatePanel'
import { TemplateImportDialog } from './TemplateImportDialog'
import { TemplatePreview } from './TemplatePreview'
import { createTemplateCatalogResource } from './templateCatalogResource'
import { useFocusRequest } from '../dom-events'
import {
  createTemplatePageNavigation,
  type TemplatePageNavigation,
  type TemplatePageCard,
} from './templatePageNavigation'

export function CollaborationTemplatePage(
  props: ComponentProps<typeof ScopedCollaborationTemplatePage>
) {
  const [scope, setScope] = useState({ store: props.store, version: 0 })
  if (scope.store !== props.store) setScope({ store: props.store, version: scope.version + 1 })
  return (
    <ScopedCollaborationTemplatePage
      key={`${props.store.library.scope}:${scope.version}`}
      {...props}
    />
  )
}

function ScopedCollaborationTemplatePage({
  store,
  locale,
  mode = 'desktop',
  onUse,
  embedded = false,
  navigation: hostNavigation,
  footerTarget,
}: {
  store: CollaborationTemplateStore
  locale: CollaborationLocale
  mode?: 'desktop' | 'marketplace'
  onUse?(record: TemplateRecord): void
  embedded?: boolean
  navigation?: TemplatePageNavigation
  footerTarget?: HTMLElement | null
}) {
  const m = templateMessages[locale]
  const local = useTemplateRecords(store)
  const [tab, setTab] = useState<'discover' | 'available' | 'mine'>('discover')
  const [search, setSearch] = useState('')
  const catalog = useMemo(
    () => createTemplateCatalogResource(store.library.remote, search),
    [store, search]
  )
  const remote = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
  const { listings, mine, nextCursor, error: remoteError, loading: remoteLoading } = remote
  const refresh = catalog.refresh
  const navigation = useMemo(
    () => hostNavigation ?? createTemplatePageNavigation(store),
    [hostNavigation, store]
  )
  const [pageOwner] = useState(() => ({}))
  const subscribePage = useCallback(
    (listener: () => void) => navigation.subscribePage(pageOwner, listener),
    [navigation, pageOwner]
  )
  const detailState = useSyncExternalStore(
    subscribePage,
    navigation.getSnapshot,
    navigation.getSnapshot
  )
  const { selected: rawSelected, deleting, importOpen, busy, importBusy } = detailState
  const { setSelected, setDeleting, setImportOpen, setBusy, setImportBusy } = navigation
  const current = () => navigation.owner === store && navigation.hasPage(pageOwner)
  const selected = useMemo(
    () => rawSelected && localizeBuiltinTemplateRecord(rawSelected, locale),
    [rawSelected, locale]
  )
  const localizedRecords = useMemo(
    () => local.records.map(record => localizeBuiltinTemplateRecord(record, locale)),
    [local.records, locale]
  )
  const [selectedInstalled, setSelectedInstalled] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pageRef = useRef<HTMLElement>(null)
  const returnTrigger = useRef<HTMLElement | null>(null)
  const focusTarget = useMemo(
    () => ({
      get current() {
        const trigger = returnTrigger.current
        return trigger?.isConnected
          ? trigger
          : (pageRef.current?.querySelector<HTMLInputElement>('[data-testid="template-search"]') ??
              null)
      },
    }),
    []
  )
  useFocusRequest(focusTarget, detailState.focusRequest, {
    enabled:
      embedded &&
      !selected &&
      !deleting &&
      !importOpen &&
      !busy &&
      !importBusy &&
      detailState.focusRequest > 0,
  })
  const cards = new Map<string, TemplatePageCard>()
  for (const [index, record] of localizedRecords.entries()) {
    if (tab === 'mine' && record.source !== 'personal') continue
    cards.set(templateIdentity(record), {
      key: templateIdentity(record),
      record: local.records[index],
      id: record.id,
      ownerId: record.ownerId,
      namespace: record.document.metadata.namespace,
      name: record.document.spec.displayName,
      description: record.document.spec.description,
      version: record.document.spec.version,
    })
  }
  if (tab === 'discover')
    for (const listing of listings) {
      const cached = local.records.find(
        record =>
          record.id === listing.id ||
          (record.ownerId === 0 &&
            record.document.metadata.namespace === 'system' &&
            listing.publisher_namespace === 'system' &&
            listing.publisher_user_id === 0 &&
            record.document.metadata.name === listing.name)
      )
      const key = cached ? templateIdentity(cached) : `listing:${listing.id}`
      const version = listing.current_version?.version ?? '1.0.0'
      const localizedCached =
        cached?.document.spec.version === version
          ? localizeBuiltinTemplateRecord(cached, locale)
          : undefined
      const localizedBuiltin = localizedCached && localizedCached !== cached
      cards.set(key, {
        key,
        record:
          cached?.document.spec.version === version ? { ...cached, id: listing.id } : undefined,
        id: listing.id,
        ownerId: cached?.ownerId ?? listing.publisher_user_id,
        namespace: cached?.document.metadata.namespace ?? listing.publisher_namespace,
        name: localizedBuiltin ? localizedCached.document.spec.displayName : listing.display_name,
        description: localizedBuiltin
          ? localizedCached.document.spec.description
          : (listing.description ?? ''),
        version,
        installed: listing.is_installed,
      })
    }
  if (tab === 'mine' || tab === 'available')
    for (const summary of mine.filter(
      item => tab === 'available' || item.ownerId === store.library.ownerId
    )) {
      const key = `${summary.ownerId}:${summary.namespace}:${summary.name}`
      const cached = cards.get(key)?.record
      if (!cached || (!cached.pendingSync && cached.document.spec.version !== summary.version))
        cards.set(key, {
          key,
          id: summary.id,
          ownerId: summary.ownerId,
          namespace: summary.namespace,
          name: summary.displayName,
          description: summary.description,
          version: summary.version,
          installed: true,
        })
    }
  const visible = [...cards.values()].filter(card =>
    `${card.name} ${card.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  )
  const choose = async (card: TemplatePageCard) => {
    setError(null)
    setStatus(null)
    setSelectedInstalled(
      !!card.installed || card.ownerId === 0 || card.ownerId === store.library.ownerId
    )
    if (card.record) {
      setSelected(card.record)
      return
    }
    if (!card.id || !store.library.remote) return
    setBusy(true)
    try {
      const record = await navigation.getRecord(card.id)
      if (current()) setSelected(record)
    } catch {
      setError(m.failed)
    } finally {
      if (current()) setBusy(false)
    }
  }

  return (
    <section
      ref={pageRef}
      className={`collaboration-template-page${embedded ? ' is-embedded' : ''}`}
      data-testid="collaboration-template-page"
    >
      <div
        hidden={embedded && Boolean(selected || deleting || importOpen)}
        style={{
          display: embedded && (selected || deleting || importOpen) ? 'none' : 'contents',
        }}
      >
        <header className="collaboration-template-page-heading">
          <div>
            {!embedded && <h2>{m.title}</h2>}
            <p>{m.description}</p>
          </div>
          <div className="collaboration-template-actions">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="template-refresh"
              aria-label={m.refresh}
              disabled={remoteLoading}
              onClick={() => void refresh()}
            >
              <RefreshCw aria-hidden="true" />
            </ControlButton>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="template-import-open"
              disabled={busy}
              onClick={event => {
                returnTrigger.current = event.currentTarget
                setImportOpen(true)
              }}
            >
              {m.import}
            </ControlButton>
          </div>
        </header>
        {!store.library.remote && <p className="collaboration-template-notice">{m.offline}</p>}
        <div className="collaboration-template-toolbar">
          <div role="group" aria-label={m.title}>
            {(['discover', 'available', 'mine'] as const).map(value => (
              <ControlButton
                variant="unstyled"
                type="button"
                key={value}
                data-testid={`template-tab-${value}`}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {value === 'available' && mode === 'marketplace' ? m.capabilities : m[value]}
              </ControlButton>
            ))}
          </div>
          <ControlInput
            aria-label={m.search}
            placeholder={m.search}
            data-testid="template-search"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>
        {(remoteError || local.error) && (
          <p role="alert">
            {m.failed}{' '}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="template-retry"
              onClick={() => {
                void store.load().catch(() => undefined)
                void refresh()
              }}
            >
              {m.retry}
            </ControlButton>
          </p>
        )}
        {error && (
          <p role="alert" className="collaboration-template-error">
            {error}
          </p>
        )}
        {local.records.some(record => record.pendingSync) && (
          <div className="collaboration-template-notice">
            <span>{m.pending}</span>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="template-sync"
              disabled={!store.library.remote || local.syncing}
              onClick={() =>
                void store
                  .synchronize()
                  .then(refresh)
                  .catch(() => setError(m.failed))
              }
            >
              {m.sync}
            </ControlButton>
          </div>
        )}
        <div className="collaboration-template-grid">
          {visible.map(card => (
            <article
              key={card.key}
              className="collaboration-template-card"
              data-testid={`template-card-${card.record?.document.metadata.name ?? card.id}`}
            >
              <div className="collaboration-template-card-header">
                <Layers3 aria-hidden="true" />
                <span>
                  {card.record?.pendingSync
                    ? m.pending
                    : card.record?.source === 'builtin'
                      ? m.builtin
                      : card.record?.source === 'personal'
                        ? m.personal
                        : card.record
                          ? m.downloaded
                          : card.installed
                            ? m.accountAvailable
                            : ''}
                </span>
              </div>
              <h3>{card.name}</h3>
              <p>{card.description}</p>
              <footer>
                <span>
                  {m.version} {card.version}
                </span>
                {card.ownerId === store.library.ownerId &&
                  card.namespace === 'default' &&
                  (!card.record || card.record.source === 'personal') && (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className="collaboration-danger-button"
                      data-testid={`template-delete-${card.record?.document.metadata.name ?? card.id}`}
                      disabled={busy || local.syncing}
                      onClick={event => {
                        returnTrigger.current = event.currentTarget
                        setError(null)
                        setDeleting(card)
                      }}
                    >
                      {m.delete}
                    </ControlButton>
                  )}
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={`template-details-${card.record?.document.metadata.name ?? card.id}`}
                  disabled={busy}
                  onClick={event => {
                    returnTrigger.current = event.currentTarget
                    void choose(card)
                  }}
                >
                  {m.details}
                </ControlButton>
              </footer>
              {card.record?.syncError && (
                <p role="alert" className="collaboration-template-error">
                  {m.syncConflict}
                </p>
              )}
            </article>
          ))}
        </div>
        {!visible.length && !remoteLoading && !local.loading && (
          <p className="collaboration-template-empty">{m.noResults}</p>
        )}
        {tab === 'discover' && nextCursor && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="template-load-more"
            disabled={remoteLoading}
            onClick={() => void catalog.loadMore()}
          >
            {m.more}
          </ControlButton>
        )}
      </div>
      {selected && (
        <TemplatePanel
          embedded={embedded}
          footerTarget={footerTarget}
          title={selected.document.spec.displayName}
          closeLabel={embedded ? m.backToTemplates : m.close}
          onClose={() => setSelected(null)}
          busy={busy}
          footer={
            <>
              {(!embedded || !hostNavigation) && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="template-detail-cancel"
                  disabled={busy}
                  onClick={() => setSelected(null)}
                >
                  {embedded ? m.backToTemplates : m.cancel}
                </ControlButton>
              )}
              {mode === 'marketplace' ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="collaboration-primary-button"
                  data-testid="template-account-add"
                  disabled={
                    busy ||
                    !!status ||
                    selectedInstalled ||
                    selected.id === null ||
                    !store.library.remote
                  }
                  onClick={async () => {
                    setBusy(true)
                    try {
                      if (selected.ownerId !== 0 && selected.ownerId !== store.library.ownerId)
                        await store.library.remote!.install(selected.id!)
                      setStatus(m.cloudAdded)
                      void refresh()
                    } catch {
                      setError(m.failed)
                    } finally {
                      if (current()) setBusy(false)
                    }
                  }}
                >
                  {status ?? (selectedInstalled ? m.cloudAdded : m.cloudAdd)}
                </ControlButton>
              ) : null}
              {(mode !== 'marketplace' || onUse) && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="collaboration-primary-button"
                  data-testid="template-use"
                  disabled={busy || (!onUse && !!status)}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      const cached = local.records.find(
                        record =>
                          templateIdentity(record) === templateIdentity(selected) &&
                          record.document.spec.version === selected.document.spec.version
                      )
                      const record = cached ?? (await store.download(selected.id!))
                      if (!current() || !catalog.hasSubscribers()) return
                      if (onUse) {
                        setSelected(null)
                        onUse(localizeBuiltinTemplateRecord(record, locale))
                      } else {
                        setStatus(m.added)
                      }
                    } catch {
                      setError(m.failed)
                    } finally {
                      if (current()) setBusy(false)
                    }
                  }}
                >
                  {(mode === 'marketplace' ? null : status) ??
                    (selected.source === 'builtin' ||
                    local.records.some(
                      record => templateIdentity(record) === templateIdentity(selected)
                    )
                      ? m.use
                      : m.download)}
                </ControlButton>
              )}
            </>
          }
        >
          <TemplatePreview document={selected.document} locale={locale} />
          {error && (
            <p role="alert" className="collaboration-template-error">
              {error}
            </p>
          )}
        </TemplatePanel>
      )}
      {deleting && (
        <TemplatePanel
          embedded={embedded}
          footerTarget={footerTarget}
          title={m.delete}
          closeLabel={m.close}
          onClose={() => setDeleting(null)}
          busy={busy}
          footer={
            <>
              {!embedded && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="template-delete-cancel"
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  {m.cancel}
                </ControlButton>
              )}
              <ControlButton
                variant="unstyled"
                type="button"
                className="collaboration-danger-button"
                data-testid="template-delete-confirm"
                disabled={busy || (deleting.id !== null && !store.library.remote)}
                onClick={async () => {
                  setBusy(true)
                  setError(null)
                  try {
                    const record =
                      deleting.record ?? (await store.library.remote!.get(deleting.id!))
                    await store.delete(record)
                    catalog.remove(record.id, deleting.key)
                    if (current()) setDeleting(null)
                    void refresh()
                  } catch {
                    setError(m.failed)
                  } finally {
                    if (current()) setBusy(false)
                  }
                }}
              >
                {m.delete}
              </ControlButton>
            </>
          }
        >
          <p>{m.deleteHint.replace('{name}', deleting.name)}</p>
          {deleting.id !== null && !store.library.remote && <p>{m.deleteConnectionRequired}</p>}
          {error && <p role="alert">{error}</p>}
        </TemplatePanel>
      )}
      {importOpen && (
        <TemplateImportDialog
          embedded={embedded}
          footerTarget={footerTarget}
          onBusyChange={value => {
            if (current()) setImportBusy(value)
          }}
          store={store}
          locale={locale}
          onClose={() => setImportOpen(false)}
          onSaved={() => {
            if (!current()) return
            setImportOpen(false)
            setTab('mine')
            void refresh()
          }}
        />
      )}
    </section>
  )
}
