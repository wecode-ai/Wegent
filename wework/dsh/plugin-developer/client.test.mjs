import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('registers translated plugin development actions through the Wework service', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let moduleRegistration
  vm.runInNewContext(source, {
    Error,
    JSON,
    Object,
    String,
    console,
    fetch: async () => ({ json: async () => ({ ok: true }), ok: true }),
    window: {
      __ModuleLoader__: {
        load(value) {
          moduleRegistration = value
        },
      },
    },
  })
  assert.ok(moduleRegistration)

  const useState = value => [value, () => {}]
  const plugin = moduleRegistration.factory(specifier => {
    assert.equal(specifier, 'react')
    return {
      Fragment: Symbol('Fragment'),
      createElement(type, props, ...children) {
        return { type, props: { ...props, children } }
      },
      useCallback(callback) {
        return callback
      },
      useEffect() {},
      useState,
    }
  })
  const contributions = []
  const context = {
    slots: {
      inject(_slot, register) {
        register()
      },
    },
    wework: {
      ui: {
        register(_ctx, slot, descriptor, component) {
          contributions.push({ component, descriptor, slot })
        },
      },
    },
  }

  plugin.apply(context)

  assert.equal(contributions.length, 2)
  const createAction = contributions.find(item => item.slot === 'wework.plugins.action')
  assert.ok(createAction)
  assert.equal(createAction.descriptor.labelKey, 'workbench.plugin_development_create')
  const rendered = createAction.component({
    onCreate: async () => {},
    t: (_key, fallback) => fallback,
  })
  assert.match(JSON.stringify(rendered), /wework-plugin-developer-create-button/)
  assert.match(JSON.stringify(rendered), /Create plugin/)
})
