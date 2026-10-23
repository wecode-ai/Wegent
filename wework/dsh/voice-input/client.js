window.__ModuleLoader__.load({
  id: '@wegent/dsh-voice-input',
  factory: require => {
    const { createElement: h, useEffect, useMemo, useState } = require('react')
    const { Button, Modal } = require('@deepseek-ai/dsh-client-ui-primitives')
    const BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'
    const OPEN_SETTINGS = 'wework:voice-input:settings'
    const noop = () => {}

    // Keep the official component, injected services, observables and locale together.
    // Only adapt the owning UI surface; DSH still owns recording and recognition.
    function mirror(ctx, source, target, id, component) {
      let previous
      let dispose = noop
      const refresh = () => {
        const entry = ctx.slots
          .entriesOfSlot(source)
          .find(item =>
            source === 'plugins.bundle.config'
              ? item.options.key === BUNDLE
              : item.locale === 'voice-input'
          )
        if (entry === previous) return
        dispose()
        previous = entry
        dispose = entry
          ? ctx.slots.register(
              {
                name: target,
                id,
                locale: entry.locale,
                inject: entry.inject,
              },
              component(entry.component)
            )
          : noop
      }
      ctx.effect(() => {
        const unsubscribe = ctx.slots.subscribe(source, refresh)
        refresh()
        return () => {
          unsubscribe()
          dispose()
        }
      }, `wework-voice-input: ${target}/${id}`)
    }

    function composerComponent(OfficialVoiceInput) {
      return function VoiceInput({ disabled, captureInsertion, ...props }) {
        const inputActions = useMemo(
          () => ({
            captureInsertion: () => captureInsertion?.(),
            insertText: (text, insertion) => insertion?.insertText(text) ?? false,
          }),
          [captureInsertion]
        )
        return h(
          'div',
          { 'data-testid': 'composer-voice-input', className: 'flex min-w-0 items-center' },
          h(OfficialVoiceInput, {
            ...props,
            inputActions,
            locked: disabled || !captureInsertion,
            onActiveChange: noop,
            openSettings: () => window.dispatchEvent(new Event(OPEN_SETTINGS)),
          })
        )
      }
    }

    function setupComponent(ctx, OfficialPreparation, overlay) {
      const title = ctx.wework.localization.translate(
        { en: 'Voice input', 'zh-CN': '语音输入' },
        'Voice input'
      )
      const close = ctx.wework.localization.translate({ en: 'Close', 'zh-CN': '关闭' }, 'Close')
      return function VoiceSettings(props) {
        const [open, setOpen] = useState(false)
        useEffect(() => {
          if (!overlay) return
          const show = () => setOpen(true)
          window.addEventListener(OPEN_SETTINGS, show)
          return () => window.removeEventListener(OPEN_SETTINGS, show)
        }, [])
        if (!overlay)
          return h(
            'section',
            { 'data-testid': 'voice-input-settings', className: 'space-y-4' },
            h('h2', { className: 'heading-small' }, title),
            h(OfficialPreparation, props)
          )
        if (!open) return null
        return h(
          Modal,
          {
            open,
            title,
            closeLabel: close,
            onClose: () => setOpen(false),
            footer: h(
              Button,
              { 'data-testid': 'voice-input-setup-close', onClick: () => setOpen(false) },
              close
            ),
          },
          h(
            'div',
            {
              'data-testid': 'voice-input-setup',
            },
            h(OfficialPreparation, props)
          )
        )
      }
    }

    return {
      inject: ['slots', 'wework'],
      apply(ctx) {
        mirror(
          ctx,
          'conversation.input.activity',
          'wework.composer.action',
          'voice-input',
          composerComponent
        )
        mirror(ctx, 'plugins.bundle.config', 'wework.settings.section', 'voice-input', Official =>
          setupComponent(ctx, Official, false)
        )
        mirror(
          ctx,
          'plugins.bundle.config',
          'wework.shell.overlay',
          'voice-input-setup',
          Official => setupComponent(ctx, Official, true)
        )
        ctx.wework.contributions.register(ctx, 'wework.settings.section', {
          id: 'voice-input',
          page: 'general',
          order: 100,
        })
      },
    }
  },
})
