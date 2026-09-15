import { Link2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { InstalledPluginComponents } from '@/types/api'
import { navigateTo } from '@/lib/navigation'

type Connector = NonNullable<InstalledPluginComponents['connectors']>[number]
type Props = {
  connectors: Connector[]
  installed: boolean
  authBySlug?: Record<string, 'connected' | 'disconnected'>
  onManage?: (slug: string) => void
}

type Group = { key: string; name: string; connectors: Connector[] }

function groupConnectors(connectors: Connector[]): Group[] {
  const groups = new Map<string, Group>()
  for (const connector of connectors) {
    const group = connector.authorizationGroup
    const key = group ? `group:${group.id}` : `connector:${connector.slug}`
    const existing = groups.get(key)
    if (existing) existing.connectors.push(connector)
    else
      groups.set(key, {
        key,
        name: group?.displayName || connector.displayName || connector.slug,
        connectors: [connector],
      })
  }
  return [...groups.values()]
}

function ConnectorSourceDialog({
  group,
  authBySlug,
  onClose,
  onManage,
}: {
  group: Group
  authBySlug: Props['authBySlug']
  onClose: () => void
  onManage: (slug: string) => void
}) {
  const { t } = useTranslation()
  const dialog = useRef<HTMLDialogElement>(null)
  const [slug, setSlug] = useState(
    () =>
      group.connectors.find(item => authBySlug?.[item.slug] === 'connected')?.slug ||
      group.connectors[0].slug
  )
  const connector = group.connectors.find(item => item.slug === slug)!
  const connected = authBySlug?.[slug] === 'connected'
  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement as HTMLElement | null
    element.showModal()
    return () => {
      element.close()
      previous?.focus()
    }
  }, [])
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="connector-source-title"
      data-testid="plugin-connector-source-dialog"
      className="plugin-dialog-surface fixed top-1/2 right-auto bottom-auto left-1/2 m-0 h-fit -translate-x-1/2 -translate-y-1/2 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[480px] overflow-y-auto p-5 text-text-primary backdrop:bg-black/35"
    >
      <h2 id="connector-source-title" className="heading-subsection">
        {group.name}
      </h2>
      <label className="mt-4 block text-sm" htmlFor="connector-source-select">
        {t('workbench.plugin_connector_source')}
      </label>
      <select
        id="connector-source-select"
        data-testid="plugin-connector-source-select"
        value={slug}
        onChange={event => setSlug(event.target.value)}
        className="mt-2 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus md:h-9"
      >
        {group.connectors.map(item => (
          <option key={item.slug} value={item.slug} className="bg-background text-text-primary">
            {item.displayName || item.slug}
            {authBySlug?.[item.slug] === 'connected'
              ? ` · ${t('workbench.plugin_connector_connected')}`
              : ''}
          </option>
        ))}
      </select>
      <p className="mt-3 text-sm text-text-secondary">
        {connector.description || t('workbench.plugin_connector_source_hint')}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          data-testid="plugin-connector-source-cancel"
          onClick={onClose}
          className="h-11 rounded-lg border border-border px-3 text-sm hover:bg-surface md:h-9"
        >
          {t('common.cancel', '取消')}
        </button>
        <button
          type="button"
          data-testid="plugin-connector-source-continue"
          onClick={() => {
            onClose()
            onManage(slug)
          }}
          className="h-11 rounded-lg bg-text-primary px-3 text-sm text-background md:h-9"
        >
          {connected
            ? t('workbench.plugin_disconnect_connection', '退出登录')
            : t('workbench.plugin_connect_login', '登录')}
        </button>
      </div>
    </dialog>
  )
}

export function PluginConnectorSection({ connectors, installed, authBySlug, onManage }: Props) {
  const { t } = useTranslation()
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null)
  const groups = groupConnectors(connectors)
  const manage = (slug: string) => (onManage ? onManage(slug) : navigateTo('/settings/connections'))
  if (!groups.length) return null
  return (
    <section className="mt-7 space-y-3" data-testid="plugin-connector-section">
      <h2 className="text-base font-medium leading-5 text-text-primary">
        {t('workbench.plugin_detail_authorization', '应用授权')}{' '}
        <span className="ml-1 rounded-full bg-surface px-2 py-0.5 text-xs text-text-muted">
          {groups.length}
        </span>
      </h2>
      <div className="overflow-hidden rounded-xl border border-border/30">
        {groups.map(group => {
          const connector = group.connectors[0]
          const grouped = Boolean(connector.authorizationGroup)
          const connected = group.connectors.filter(item => authBySlug?.[item.slug] === 'connected')
          const state = authBySlug?.[connector.slug]
          return (
            <div
              key={group.key}
              className="grid grid-cols-[38px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface text-text-secondary">
                <Link2 className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <strong className="block truncate text-sm font-medium">{group.name}</strong>
                <small className="block text-xs leading-4 text-text-secondary">
                  {connected.length
                    ? `${t('workbench.plugin_connector_connected')} · ${connected.map(item => item.displayName || item.slug).join(', ')}`
                    : grouped
                      ? t('workbench.plugin_connector_source_hint')
                      : connector.description ||
                        t(
                          connector.authPolicy === 'on_install'
                            ? 'workbench.plugin_connector_required'
                            : 'workbench.plugin_connector_optional'
                        )}
                </small>
              </span>
              <button
                type="button"
                disabled={!installed}
                data-testid={`plugin-connection-manage-${group.key}`}
                className="h-11 rounded-lg bg-surface px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
                onClick={() => (grouped ? setSelectedGroup(group) : manage(connector.slug))}
              >
                {!installed
                  ? t('workbench.plugin_connect_after_install', '安装后可连接')
                  : grouped
                    ? t('workbench.plugin_manage_connection', '管理连接')
                    : state === 'connected'
                      ? t('workbench.plugin_disconnect_connection', '退出登录')
                      : state === 'disconnected'
                        ? t('workbench.plugin_connect_login', '登录')
                        : t('workbench.plugin_manage_connection', '管理连接')}
              </button>
            </div>
          )
        })}
      </div>
      {selectedGroup && (
        <ConnectorSourceDialog
          group={selectedGroup}
          authBySlug={authBySlug}
          onClose={() => setSelectedGroup(null)}
          onManage={manage}
        />
      )}
    </section>
  )
}
