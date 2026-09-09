import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return null
}

test('registers a default-enabled cloud sync setting and applies changes to the runtime', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let handoff
  const window = {
    __ModuleLoader__: {
      load(value) {
        handoff = value
      },
    },
  }
  vm.runInNewContext(source, { URLSearchParams, window })
  assert.ok(handoff)

  let state
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() }
    },
    useEffect() {},
    useState(initial) {
      state = initial
      return [state, next => (state = next)]
    },
  }
  const plugin = handoff.factory(id => {
    assert.equal(id, 'react')
    return React
  })
  const backendRequests = []
  const registrations = []
  let configurationDefinition
  let configured = {}
  const ctx = {
    slots: {
      inject(slot, factory) {
        assert.equal(slot, 'wework.settings.section')
        for (const disposer of factory()) assert.equal(typeof disposer, 'function')
      },
      register(options, component) {
        registrations.push({ component, options })
        return () => {}
      },
    },
    wework: {
      backend: {
        scope(id) {
          assert.equal(id, 'wework-transcript-sync')
          return {
            async request(method, params) {
              backendRequests.push({ method, params })
              return { enabled: params.enabled }
            },
          }
        },
      },
      configuration: {
        get() {
          return { ...configurationDefinition.defaults, ...configured }
        },
        register(_owner, definition) {
          configurationDefinition = definition
          return () => {}
        },
        update(_id, patch) {
          configured = { ...configured, ...patch }
          return configured
        },
      },
      contributions: {
        register(_owner, slot, descriptor) {
          registrations.push({ descriptor, options: { id: descriptor.id, name: slot } })
          return () => {}
        },
      },
      localization: {
        translate(messages) {
          return messages['zh-CN']
        },
      },
    },
  }

  plugin.apply(ctx)
  await Promise.resolve()

  assert.equal(configurationDefinition.defaults.enabled, true)
  assert.equal(backendRequests[0].method, 'setEnabled')
  assert.equal(backendRequests[0].params.enabled, true)
  const pageRegistration = registrations.find(entry => typeof entry.component === 'function')
  assert.ok(pageRegistration)
  assert.equal(registrations.find(entry => entry.descriptor)?.descriptor.page, 'connections')
  const wrapper = pageRegistration.component({})
  const page = wrapper.type(wrapper.props)
  const checkbox = findElement(
    page,
    node => node.props?.['data-testid'] === 'transcript-sync-enabled-checkbox'
  )
  assert.ok(checkbox)
  assert.equal(checkbox.props.checked, true)

  checkbox.props.onChange({ target: { checked: false } })
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(configured.enabled, false)
  assert.equal(backendRequests.at(-1).method, 'setEnabled')
  assert.equal(backendRequests.at(-1).params.enabled, false)
})
