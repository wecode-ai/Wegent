window.__ModuleLoader__.load({
  id: '@wegent/dsh-transcript-sync',
  factory: require => {
    const React = require('react')
    const { createElement, useEffect, useState } = React
    const CONFIGURATION_ID = 'wework-transcript-sync.settings'
    const BACKEND_ID = 'wework-transcript-sync'

    function createSettingsStore(service) {
      const backend = service.backend.scope(BACKEND_ID)
      let snapshot = {
        enabled: service.configuration.get(CONFIGURATION_ID)?.enabled !== false,
        error: null,
        pending: false,
        status: null,
        statusPending: false,
      }
      const listeners = new Set()
      const publish = patch => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of listeners) listener(snapshot)
      }
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        async reconcile() {
          try {
            await backend.request('setEnabled', { enabled: snapshot.enabled })
            await this.refreshStatus()
          } catch (error) {
            publish({ error: error instanceof Error ? error.message : String(error) })
          }
        },
        async refreshStatus() {
          if (snapshot.statusPending) return
          publish({ statusPending: true })
          try {
            const status = await backend.request('getStatus', {})
            publish({ status, statusPending: false })
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              statusPending: false,
            })
          }
        },
        async retry() {
          if (snapshot.statusPending) return
          publish({ error: null, statusPending: true })
          try {
            const status = await backend.request('flush', {})
            publish({ status, statusPending: false })
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              statusPending: false,
            })
            await this.refreshStatus()
          }
        },
        async setEnabled(enabled) {
          if (snapshot.pending || snapshot.enabled === enabled) return
          publish({ error: null, pending: true })
          try {
            await backend.request('setEnabled', { enabled })
            service.configuration.update(CONFIGURATION_ID, { enabled })
            publish({ enabled, pending: false })
            await this.refreshStatus()
          } catch (error) {
            publish({
              error: error instanceof Error ? error.message : String(error),
              pending: false,
            })
          }
        },
      }
    }

    function SyncSettingsSection({ service, store }) {
      const [snapshot, setSnapshot] = useState(store.getSnapshot())
      useEffect(() => {
        const unsubscribe = store.subscribe(setSnapshot)
        void store.refreshStatus()
        const timer = setInterval(() => void store.refreshStatus(), 5000)
        return () => {
          clearInterval(timer)
          unsubscribe()
        }
      }, [store])
      const label = service.localization.translate({
        en: 'Synchronize conversations and settings across devices',
        'zh-CN': '跨设备同步会话和配置',
      })
      const description = service.localization.translate({
        en: 'When disabled, Wework keeps working locally and does not upload or download cloud data.',
        'zh-CN': '关闭后 Wework 仍可在本机正常工作，但不会上传或下载云端数据。',
      })
      const syncStatus = synchronizationStatus(snapshot, service)

      return createElement(
        'section',
        {
          'data-testid': 'transcript-sync-settings-section',
          style: {
            background: 'rgb(var(--color-background))',
            border: '1px solid rgb(var(--color-border))',
            borderRadius: '8px',
            color: 'rgb(var(--color-text-primary))',
            padding: '20px',
          },
        },
        createElement(
          'label',
          {
            style: {
              alignItems: 'flex-start',
              cursor: snapshot.pending ? 'default' : 'pointer',
              display: 'flex',
              gap: '12px',
            },
          },
          createElement('input', {
            checked: snapshot.enabled,
            'data-testid': 'transcript-sync-enabled-checkbox',
            disabled: snapshot.pending,
            onChange: event => void store.setEnabled(event.target.checked),
            style: { marginTop: '2px' },
            type: 'checkbox',
          }),
          createElement(
            'span',
            { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            createElement('span', { style: { fontWeight: 600 } }, label),
            createElement(
              'span',
              { style: { color: 'rgb(var(--color-text-muted))' } },
              description
            ),
            createElement(
              'span',
              {
                'aria-live': 'polite',
                'data-testid': 'transcript-sync-enabled-status',
                style: { color: 'rgb(var(--color-text-muted))' },
              },
              snapshot.pending || snapshot.statusPending
                ? service.localization.translate({ en: 'Updating…', 'zh-CN': '正在更新…' })
                : syncStatus.label
            )
          )
        ),
        createElement(
          'div',
          {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              marginLeft: '28px',
              marginTop: '8px',
            },
          },
          snapshot.status
            ? createElement(
                'span',
                {
                  'data-testid': 'transcript-sync-runtime-status',
                  style: {
                    color: syncStatus.color,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  },
                },
                createElement(
                  'span',
                  null,
                  service.localization.translate({
                    en: `${snapshot.status.pendingTurns} turns waiting to upload`,
                    'zh-CN': `待上传 ${snapshot.status.pendingTurns} 轮`,
                  })
                ),
                createElement(
                  'span',
                  null,
                  service.localization.translate({
                    en: `${snapshot.status.transcripts} cloud conversations discovered`,
                    'zh-CN': `已发现 ${snapshot.status.transcripts} 个云端会话`,
                  })
                ),
                createElement(
                  'span',
                  null,
                  service.localization.translate({
                    en: `Last successful sync: ${formatTimestamp(snapshot.status.lastSuccessAt, 'Never')}`,
                    'zh-CN': `最近成功：${formatTimestamp(snapshot.status.lastSuccessAt, '暂无')}`,
                  })
                )
              )
            : null,
          snapshot.status?.lastError
            ? createElement(
                'span',
                {
                  'data-testid': 'transcript-sync-runtime-error',
                  role: 'alert',
                  style: { color: 'rgb(var(--color-error))' },
                },
                snapshot.status.lastError
              )
            : null,
          snapshot.enabled
            ? createElement(
                'button',
                {
                  'data-testid': 'transcript-sync-retry-button',
                  disabled: snapshot.statusPending,
                  onClick: () => void store.retry(),
                  style: {
                    alignSelf: 'flex-start',
                    background: 'transparent',
                    border: '1px solid rgb(var(--color-border))',
                    borderRadius: '6px',
                    color: 'rgb(var(--color-text-primary))',
                    cursor: snapshot.statusPending ? 'default' : 'pointer',
                    padding: '6px 10px',
                  },
                  type: 'button',
                },
                service.localization.translate({ en: 'Retry now', 'zh-CN': '立即重试' })
              )
            : null,
          snapshot.error
            ? createElement(
                'span',
                {
                  'data-testid': 'transcript-sync-settings-error',
                  role: 'alert',
                  style: { color: 'rgb(var(--color-error))' },
                },
                snapshot.error
              )
            : null
        )
      )
    }

    function synchronizationStatus(snapshot, service) {
      if (!snapshot.enabled) {
        return {
          color: 'rgb(var(--color-text-muted))',
          label: service.localization.translate({
            en: 'Synchronization disabled',
            'zh-CN': '同步已关闭',
          }),
        }
      }
      if (snapshot.status?.syncing) {
        return {
          color: 'rgb(var(--color-text-muted))',
          label: service.localization.translate({ en: 'Synchronizing…', 'zh-CN': '正在同步…' }),
        }
      }
      if (snapshot.status?.lastError) {
        return {
          color: 'rgb(var(--color-error))',
          label: service.localization.translate({
            en: 'Synchronization failed',
            'zh-CN': '同步失败',
          }),
        }
      }
      if (snapshot.status?.pendingTurns > 0) {
        return {
          color: 'rgb(var(--color-text-muted))',
          label: service.localization.translate({
            en: 'Waiting to synchronize',
            'zh-CN': '等待同步',
          }),
        }
      }
      return {
        color: 'rgb(var(--color-text-muted))',
        label: service.localization.translate({
          en: 'Synchronization is up to date',
          'zh-CN': '同步正常',
        }),
      }
    }

    function formatTimestamp(value, fallback) {
      if (typeof value !== 'string' || !value) return fallback
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return fallback
      return date.toLocaleString()
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        ctx.wework.configuration.register(ctx, {
          defaults: { enabled: true },
          description: 'Controls Wework transcript and portable preference cloud synchronization.',
          id: CONFIGURATION_ID,
          properties: {
            enabled: { type: 'boolean' },
          },
          title: 'Wework cloud synchronization',
          validate(value) {
            if (typeof value.enabled !== 'boolean') {
              throw new Error('Cloud synchronization enabled must be a boolean')
            }
          },
        })
        const store = createSettingsStore(ctx.wework)
        void store.reconcile()
        const descriptor = {
          id: 'wework-transcript-sync',
          label: ctx.wework.localization.translate({ en: 'Cloud sync', 'zh-CN': '云同步' }),
          order: 90,
          page: 'connections',
        }
        ctx.slots.inject('wework.settings.section', function* () {
          yield ctx.wework.contributions.register(ctx, 'wework.settings.section', descriptor)
          yield ctx.slots.register(
            {
              name: 'wework.settings.section',
              id: descriptor.id,
              label: descriptor.label,
              order: descriptor.order,
            },
            props => createElement(SyncSettingsSection, { ...props, service: ctx.wework, store })
          )
        })
      },
    }
  },
})
