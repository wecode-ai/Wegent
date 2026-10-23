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
      localization: { translate: value => value.en },
      contributions: { register: (...args) => contributions.push(args.slice(1)) },
    },
  }
  vm.runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), {
    window: {
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
        }
  )
  plugin.apply(ctx)
  function publish(name, value) {
    entries.set(name, value)
    for (const listener of listeners.get(name) ?? []) listener()
  }
  return { ctx, entries, listeners, cleanups, contributions, publish }
}

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
