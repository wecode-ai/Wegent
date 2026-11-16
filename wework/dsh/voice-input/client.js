window.__ModuleLoader__.load({
  id: '@wegent/dsh-voice-input',
  factory: require => {
    const { createElement: h, useEffect, useMemo, useRef, useState } = require('react')
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
      return function VoiceInput({
        disabled,
        captureInsertion,
        sessionId,
        onActiveChange = noop,
        ...props
      }) {
        const sessionRef = useRef({ id: sessionId })
        if (sessionRef.current.id !== sessionId) sessionRef.current = { id: sessionId }
        const inputActions = useMemo(
          () => ({
            captureInsertion: () => {
              const insertion = captureInsertion?.()
              if (!insertion) return null
              const session = sessionRef.current
              return {
                insertText: text =>
                  sessionRef.current === session ? insertion.insertText(text) : false,
              }
            },
            insertText: (text, insertion) => insertion?.insertText(text) ?? false,
          }),
          [captureInsertion]
        )
        return h(
          'div',
          { 'data-testid': 'composer-voice-input', className: 'flex min-w-0 items-center' },
          h(OfficialVoiceInput, {
            ...props,
            sessionId,
            inputActions,
            locked: disabled || !captureInsertion,
            onActiveChange,
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
      const modelHelp = [
        {
          en: 'INT8 · Smaller download and lower memory use through 8-bit quantization. A good starting point for everyday dictation; recognition accuracy may be affected.',
          'zh-CN':
            'INT8 · 轻量版：用 8 位量化缩小模型，下载和内存占用更少。日常语音输入可先选它，识别准确率可能受量化影响。',
        },
        {
          en: 'FP32 · Full 32-bit precision, with a larger download and higher memory use. If INT8 makes frequent errors, try FP32 and compare with the same recording.',
          'zh-CN':
            'FP32 · 完整精度版：保留 32 位浮点精度，下载和内存占用更大。如果 INT8 经常识别出错，可试用 FP32，用同一段录音对比效果。',
        },
      ].map(copy => ctx.wework.localization.translate(copy, copy.en))
      return function VoiceSettings(props) {
        const [open, setOpen] = useState(false)
        useEffect(() => {
          if (!overlay) return
          const show = () => setOpen(true)
          window.addEventListener(OPEN_SETTINGS, show)
          return () => window.removeEventListener(OPEN_SETTINGS, show)
        }, [])
        const preparation = h(
          'div',
          { className: 'space-y-3' },
          h(OfficialPreparation, props),
          h(
            'div',
            {
              'data-testid': 'voice-input-model-help',
              className: 'space-y-1 text-sm text-muted-foreground',
            },
            ...modelHelp.map((text, index) => h('p', { key: index }, text))
          )
        )
        if (!overlay)
          return h(
            'section',
            { 'data-testid': 'voice-input-settings', className: 'space-y-4' },
            h('h2', { className: 'heading-small' }, title),
            preparation
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
            preparation
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
