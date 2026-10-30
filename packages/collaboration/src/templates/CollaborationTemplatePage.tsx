// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { Layers3, RefreshCw } from 'lucide-react'
import type { CollaborationLocale } from '../i18n'
import {
  templateIdentity,
  type TemplateListing,
  type TemplateRecord,
  type TemplateSummary,
} from './types'
import type { CollaborationTemplateStore } from './store'
import { useTemplateRecords } from './context'
import { templateMessages } from './messages'
import { TemplateDialog } from './TemplateDialog'
import { TemplateImportDialog } from './TemplateImportDialog'
import { TemplatePreview } from './TemplatePreview'

type Card = {
  key: string
  name: string
  description: string
  version: string
  record?: TemplateRecord
  id: number | null
  ownerId: number
  installed?: boolean
}

export function CollaborationTemplatePage(
  props: ComponentProps<typeof ScopedCollaborationTemplatePage>
) {
  return <ScopedCollaborationTemplatePage key={props.store.library.scope} {...props} />
}

function ScopedCollaborationTemplatePage({
  store,
  locale,
  mode = 'desktop',
  onUse,
}: {
  store: CollaborationTemplateStore
  locale: CollaborationLocale
  mode?: 'desktop' | 'marketplace'
  onUse?(record: TemplateRecord): void
}) {
  const m = templateMessages[locale]
  const local = useTemplateRecords(store)
  const [tab, setTab] = useState<'discover' | 'available' | 'mine'>('discover')
  const [search, setSearch] = useState('')
  const [listings, setListings] = useState<TemplateListing[]>([])
  const [mine, setMine] = useState<TemplateSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [selected, setSelected] = useState<TemplateRecord | null>(null)
  const [selectedInstalled, setSelectedInstalled] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const remote = store.library.remote
    if (!remote) return
    const version = ++generation.current
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      // These requests belong to this page, and each failure stays scoped.
      await Promise.allSettled([
        remote
          .discover({ keyword: search })
          .then(result => {
            if (version !== generation.current) return
            setListings(result.items)
            setNextCursor(result.hasMore ? result.nextCursor : null)
          })
          .catch(() => {
            if (version === generation.current) setRemoteError(m.failed)
          }),
        remote
          .list()
          .then(result => {
            if (version === generation.current) setMine(result)
          })
          .catch(() => {
            if (version === generation.current) setRemoteError(m.failed)
          }),
      ])
    } finally {
      if (version === generation.current) setRemoteLoading(false)
    }
  }, [store, m.failed, search])
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 200)
    return () => {
      window.clearTimeout(timer)
      generation.current++
    }
  }, [refresh])

  const cards = new Map<string, Card>()
  for (const record of local.records) {
    if (tab === 'mine' && record.source !== 'personal') continue
    cards.set(templateIdentity(record), {
      key: templateIdentity(record),
      record,
      id: record.id,
      ownerId: record.ownerId,
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
            record.document.metadata.name === listing.name)
      )
      const key = cached ? templateIdentity(cached) : `listing:${listing.id}`
      const version = listing.current_version?.version ?? '1.0.0'
      cards.set(key, {
        key,
        record:
          cached?.document.spec.version === version ? { ...cached, id: listing.id } : undefined,
        id: listing.id,
        ownerId: cached?.ownerId ?? listing.publisher_user_id,
        name: listing.display_name,
        description: listing.description ?? '',
        version,
        installed: listing.is_installed,
      })
    }
  if (tab === 'mine' || (tab === 'available' && mode === 'marketplace'))
    for (const summary of mine.filter(
      item => tab === 'available' || item.ownerId === store.library.ownerId
    )) {
      const key = `${summary.ownerId}:${summary.namespace}:${summary.name}`
      if (!cards.has(key))
        cards.set(key, {
          key,
          id: summary.id,
          ownerId: summary.ownerId,
          name: summary.displayName,
          description: summary.description,
          version: summary.version,
          installed: true,
        })
    }
  const visible = [...cards.values()].filter(card =>
    `${card.name} ${card.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  )
  const choose = async (card: Card) => {
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
      setSelected(await store.library.remote.get(card.id))
    } catch {
      setError(m.failed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="collaboration-template-page" data-testid="collaboration-template-page">
      <header className="collaboration-template-page-heading">
        <div>
          <h2>{m.title}</h2>
          <p>{m.description}</p>
        </div>
        <div className="collaboration-template-actions">
          <button
            type="button"
            data-testid="template-refresh"
            aria-label={m.refresh}
            disabled={remoteLoading}
            onClick={() => void refresh()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="template-import-open"
            onClick={() => setImportOpen(true)}
          >
            {m.import}
          </button>
        </div>
      </header>
      {!store.library.remote && <p className="collaboration-template-notice">{m.offline}</p>}
      <div className="collaboration-template-toolbar">
        <div role="group" aria-label={m.title}>
          {(['discover', 'available', 'mine'] as const).map(value => (
            <button
              type="button"
              key={value}
              data-testid={`template-tab-${value}`}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {value === 'available' && mode === 'marketplace' ? m.capabilities : m[value]}
            </button>
          ))}
        </div>
        <input
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
          <button
            type="button"
            data-testid="template-retry"
            onClick={() => {
              void store.load().catch(() => undefined)
              void refresh()
            }}
          >
            {m.retry}
          </button>
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
          <button
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
          </button>
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
                        : ''}
              </span>
            </div>
            <h3>{card.name}</h3>
            <p>{card.description}</p>
            <footer>
              <span>
                {m.version} {card.version}
              </span>
              <button
                type="button"
                data-testid={`template-details-${card.record?.document.metadata.name ?? card.id}`}
                disabled={busy}
                onClick={() => void choose(card)}
              >
                {m.details}
              </button>
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
        <button
          type="button"
          data-testid="template-load-more"
          disabled={remoteLoading}
          onClick={async () => {
            const remote = store.library.remote
            if (!remote) return
            const version = generation.current
            setRemoteLoading(true)
            try {
              const result = await remote.discover({
                keyword: search,
                cursor: nextCursor,
              })
              if (version === generation.current) {
                setListings(previous => [...previous, ...result.items])
                setNextCursor(result.hasMore ? result.nextCursor : null)
              }
            } catch {
              if (version === generation.current) setRemoteError(m.failed)
            } finally {
              if (version === generation.current) setRemoteLoading(false)
            }
          }}
        >
          {m.more}
        </button>
      )}
      {selected && (
        <TemplateDialog
          title={selected.document.spec.displayName}
          closeLabel={m.close}
          onClose={() => setSelected(null)}
          busy={busy}
          footer={
            <>
              <button
                type="button"
                data-testid="template-detail-cancel"
                disabled={busy}
                onClick={() => setSelected(null)}
              >
                {m.cancel}
              </button>
              {mode === 'marketplace' ? (
                <button
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
                      setBusy(false)
                    }
                  }}
                >
                  {status ?? (selectedInstalled ? m.cloudAdded : m.cloudAdd)}
                </button>
              ) : (
                <button
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
                      if (onUse) {
                        setSelected(null)
                        onUse(record)
                      } else {
                        setStatus(m.added)
                      }
                    } catch {
                      setError(m.failed)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {status ??
                    (selected.source === 'builtin' ||
                    local.records.some(
                      record => templateIdentity(record) === templateIdentity(selected)
                    )
                      ? m.use
                      : m.download)}
                </button>
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
        </TemplateDialog>
      )}
      {importOpen && (
        <TemplateImportDialog
          store={store}
          locale={locale}
          onClose={() => setImportOpen(false)}
          onSaved={() => {
            setImportOpen(false)
            setTab('mine')
            void refresh()
          }}
        />
      )}
    </section>
  )
}
