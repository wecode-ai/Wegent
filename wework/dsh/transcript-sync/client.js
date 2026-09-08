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
          } catch (error) {
            publish({ error: error instanceof Error ? error.message : String(error) })
          }
        },
        async setEnabled(enabled) {
          if (snapshot.pending || snapshot.enabled === enabled) return
          publish({ error: null, pending: true })
          try {
            await backend.request('setEnabled', { enabled })
            service.configuration.update(CONFIGURATION_ID, { enabled })
            publish({ enabled, pending: false })
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
      useEffect(() => store.subscribe(setSnapshot), [store])
      const label = service.localization.translate({
        en: 'Synchronize conversations and settings across devices',
        'zh-CN': '跨设备同步会话和配置',
      })
      const description = service.localization.translate({
        en: 'When disabled, Wework keeps working locally and does not upload or download cloud data.',
        'zh-CN': '关闭后 Wework 仍可在本机正常工作，但不会上传或下载云端数据。',
      })
      const status = snapshot.enabled
        ? service.localization.translate({ en: 'Synchronization enabled', 'zh-CN': '同步已开启' })
        : service.localization.translate({ en: 'Synchronization disabled', 'zh-CN': '同步已关闭' })

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
              snapshot.pending
                ? service.localization.translate({ en: 'Saving…', 'zh-CN': '正在保存…' })
                : status
            ),
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
      )
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
