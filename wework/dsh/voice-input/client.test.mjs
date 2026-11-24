import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function fixture() {
  let registration
  const entries = new Map()
  const listeners = new Map()
  const cleanups = []
  const contributions = []
  const refs = []
  let hookIndex = 0
  let locale = 'en'
  const windowListeners = new Map()
  const subscriptions = new Set()
  const ctx = {
    effect(factory) {
      cleanups.push(factory())
    },
    slots: {
      entriesOfSlot: name => entries.get(name) ?? [],
      subscribe(name, listener) {
        const set = listeners.get(name) ?? new Set()
        listeners.set(name, set)
        set.add(listener)
        return () => set.delete(listener)
      },
      register(options, component) {
        const entry = { options, component }
        entries.set(options.name, [...(entries.get(options.name) ?? []), entry])
        return () =>
          entries.set(
            options.name,
            entries.get(options.name).filter(item => item !== entry)
          )
      },
    },
    wework: {
      localization: { translate: value => value[locale] ?? value.en },
      contributions: { register: (...args) => contributions.push(args.slice(1)) },
    },
  }
  vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), {
    window: {
      addEventListener(type, listener) {
        const current = windowListeners.get(type) ?? new Set()
        current.add(listener)
        windowListeners.set(type, current)
      },
      removeEventListener(type, listener) {
        windowListeners.get(type)?.delete(listener)
      },
      __ModuleLoader__: {
        load: value => {
          registration = value
        },
      },
    },
  })
  const plugin = registration.factory(name =>
    name === 'react-dom'
      ? {}
      : {
          createElement: (component, props, ...children) => ({ component, props, children }),
          useMemo: fn => fn(),
          useSyncExternalStore(subscribe, getSnapshot) {
            if (!subscriptions.has(subscribe)) {
              subscriptions.add(subscribe)
              cleanups.push(subscribe(() => {}))
            }
            return getSnapshot()
          },
          useRef: value => (refs[hookIndex++] ??= { current: value }),
        }
  )
  plugin.apply(ctx)
  function publish(name, value) {
    entries.set(name, value)
    for (const listener of listeners.get(name) ?? []) listener()
  }
  function renderComposer(props) {
    hookIndex = 0
    return entries.get('wework.composer.action')[0].component(props).children[0].props
  }
  return {
    ctx,
    entries,
    listeners,
    cleanups,
    contributions,
    publish,
    renderComposer,
    showSetup: () => {
      entries.get('wework.shell.overlay')[0].component({})
      for (const listener of windowListeners.get('wework:voice-input:settings') ?? []) listener()
    },
    setLocale: value => {
      locale = value
    },
  }
}

test('invalidates captured insertions across session changes, including returning to the same session', async () => {
  const f = await fixture()
  f.publish('conversation.input.activity', [{ component() {}, locale: 'voice-input', options: {} }])
  const inserted = []
  const captureInsertion = () => ({ insertText: text => (inserted.push(text), true) })
  const initial = f.renderComposer({ sessionId: 'a', captureInsertion })
  const sameSession = initial.inputActions.captureInsertion()
  const stale = initial.inputActions.captureInsertion()
  f.renderComposer({ sessionId: 'a', captureInsertion })
  assert.equal(initial.inputActions.insertText('same session', sameSession), true)
  f.renderComposer({ sessionId: 'b', captureInsertion })
  assert.equal(initial.inputActions.insertText('wrong session', stale), false)
  const returned = f.renderComposer({ sessionId: 'a', captureInsertion })
  assert.equal(initial.inputActions.insertText('stale after return', stale), false)
  assert.equal(
    returned.inputActions.insertText('new capture', returned.inputActions.captureInsertion()),
    true
  )
  assert.deepEqual(inserted, ['same session', 'new capture'])
})

test('reuses official voice components, locale and injected readiness without copying behavior', async () => {
  const f = await fixture()
  const Official = () => {}
  const inject = () => ({ hooks: { speechReadiness: {} } })
  f.publish('conversation.input.activity', [
    { component: Official, locale: 'voice-input', inject, options: {} },
  ])
  const [entry] = f.entries.get('wework.composer.action')
  assert.equal(entry.options.locale, 'voice-input')
  assert.equal(entry.options.inject, inject)
  const root = entry.component({
    sessionId: 'task-7',
    disabled: true,
    useSpeechReadiness: inject,
    captureInsertion: () => ({ insertText: text => text === 'transcript' }),
  })
  const native = root.children[0]
  assert.equal(native.component, Official)
  assert.equal(native.props.useSpeechReadiness, inject)
  assert.equal(native.props.locked, true)
  assert.equal(native.props.sessionId, 'task-7')
  const insertion = native.props.inputActions.captureInsertion()
  assert.equal(native.props.inputActions.insertText('transcript', insertion), true)
  assert.equal(native.props.inputActions.insertText('missing', null), false)
})

test('withdraws and replaces mirrored entries when the official plugin is disabled or reloaded', async () => {
  const f = await fixture()
  const source = 'conversation.input.activity'
  const official = { component() {}, locale: 'voice-input', options: {} }
  f.publish(source, [official])
  f.publish(source, [official])
  assert.equal(f.entries.get('wework.composer.action').length, 1)
  f.publish(source, [])
  assert.equal(f.entries.get('wework.composer.action').length, 0)
  f.publish(source, [{ ...official, component() {} }])
  assert.equal(f.entries.get('wework.composer.action').length, 1)
  for (const cleanup of f.cleanups) cleanup()
  assert.equal(f.entries.get('wework.composer.action').length, 0)
  assert.ok([...f.listeners.values()].every(set => set.size === 0))
})

test('mounts only the official voice bundle preparation in General settings and the setup dialog', async () => {
  const f = await fixture()
  f.publish('plugins.bundle.config', [{ component() {}, options: { key: 'unrelated' } }])
  assert.equal(f.entries.has('wework.settings.section'), false)
  const inject = () => ({ prepare() {}, cancelPreparation() {} })
  f.publish('plugins.bundle.config', [
    {
      component() {},
      locale: 'voice-input',
      inject,
      options: { key: '@deepseek-ai/dsh-experimental-voice-input-bundle' },
    },
  ])
  assert.equal(f.entries.get('wework.settings.section')[0].options.inject, inject)
  assert.equal(f.entries.get('wework.shell.overlay')[0].options.inject, inject)
  assert.equal(f.contributions[0][1].page, 'general')
})

test('forwards voice activity changes to the owning composer', async () => {
  const f = await fixture()
  f.publish('conversation.input.activity', [{ component() {}, locale: 'voice-input', options: {} }])
  const activity = []
  const onActiveChange = active => activity.push(active)
  const voice = f.renderComposer({ sessionId: 'a', onActiveChange })
  assert.equal(voice.onActiveChange, onActiveChange)
  voice.onActiveChange(true)
  voice.onActiveChange(false)
  voice.onActiveChange(true)
  assert.deepEqual(activity, [true, false, true])
})

test('updates settings copy for the same mounted component when the host language changes', async () => {
  const f = await fixture()
  f.setLocale('zh-CN')
  f.publish('plugins.bundle.config', [
    {
      component() {},
      locale: 'voice-input',
      options: { key: '@deepseek-ai/dsh-experimental-voice-input-bundle' },
    },
  ])
  const Settings = f.entries.get('wework.settings.section')[0].component
  const Overlay = f.entries.get('wework.shell.overlay')[0].component
  f.showSetup()
  assert.equal(Settings({}).children[0].children[0], '语音输入')
  assert.equal(Overlay({}).props.closeLabel, '关闭')
  f.setLocale('en')
  const english = Settings({})
  assert.equal(english.children[0].children[0], 'Voice input')
  assert.equal(Overlay({}).props.title, 'Voice input')
  assert.equal(Overlay({}).props.closeLabel, 'Close')
  assert.ok(JSON.stringify(english).includes('Smaller download and lower memory use'))
  f.setLocale('zh-CN')
  const chinese = Settings({})
  assert.equal(chinese.children[0].children[0], '语音输入')
  assert.equal(Overlay({}).props.title, '语音输入')
  assert.equal(Overlay({}).props.closeLabel, '关闭')
  assert.ok(JSON.stringify(chinese).includes('轻量版'))
})

test('keeps official preparation and local dismissal inside the owning modal layout', async () => {
  const f = await fixture()
  const Official = () => {}
  const props = { prepare() {}, useSpeechReadiness() {} }
  f.publish('plugins.bundle.config', [
    {
      component: Official,
      locale: 'voice-input',
      options: { key: '@deepseek-ai/dsh-experimental-voice-input-bundle' },
    },
  ])
  const Settings = f.entries.get('wework.settings.section')[0].component
  const Overlay = f.entries.get('wework.shell.overlay')[0].component
  const inline = Settings(props).children[1]
  assert.equal(inline.props['data-testid'], 'voice-input-preparation')
  assert.ok(inline.props.className.includes('wework-voice-preparation'))
  assert.equal(inline.children[0].component, Official)
  assert.equal(inline.children[0].props.prepare, props.prepare)
  assert.equal(inline.children[0].props.useSpeechReadiness, props.useSpeechReadiness)
  f.showSetup()
  const modal = Overlay(props)
  assert.equal(modal.props.className, 'wework-voice-setup-modal')
  assert.equal(modal.props.contentClassName, 'wework-voice-setup-content')
  const preparation = modal.children[0].children[0]
  assert.equal(preparation.props['data-testid'], 'voice-input-preparation')
  assert.equal(preparation.children[0].component, Official)
  assert.equal(preparation.children[0].props.prepare, props.prepare)
  assert.equal(preparation.children[0].props.useSpeechReadiness, props.useSpeechReadiness)
  modal.props.onClose()
  assert.equal(Overlay(props), null)
  f.showSetup()
  Overlay(props).props.footer.props.onClick()
  assert.equal(Overlay(props), null)
})
