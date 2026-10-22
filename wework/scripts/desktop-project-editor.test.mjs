import assert from 'node:assert/strict'
import { test } from 'vitest'
import { openRuntimeProjectEditor } from '../e2e/desktop/modules/cloud-checkpoint-flows.mjs'

test.each(['edit', 'rename'])(
  'waits for the %s action before opening project settings',
  async action => {
    let menuAction = null
    let opened = false
    const calls = []
    const control = {
      async command(command, selector, options) {
        calls.push(command)
        if (command === 'click' && selector.includes('project-menu-7')) {
          setTimeout(() => {
            menuAction = `${action}-project-7`
          }, 50)
        } else if (command === 'snapshot') {
          return JSON.stringify({ testIds: menuAction ? [menuAction] : [] })
        } else if (command === 'clickWhenEnabled') {
          await new Promise(resolve => setTimeout(resolve, 50))
          assert.ok(selector.includes(`data-testid="${menuAction}"`))
          opened = true
        } else if (command === 'click') {
          assert.ok(menuAction && selector.includes(`data-testid="${menuAction}"`))
          opened = true
        } else if (command === 'waitFor') {
          if (selector === '[data-testid="local-project-edit-dialog"]') {
            assert.ok(opened)
          } else {
            assert.equal(selector, '[data-testid="project-menu-7"][aria-expanded="true"]')
            assert.ok(options.stableMs > 0)
          }
        }
        return ''
      },
    }

    await openRuntimeProjectEditor(control, 7)

    assert.ok(opened)
    assert.deepEqual(calls, ['hover', 'click', 'waitFor', 'clickWhenEnabled', 'waitFor'])
  }
)
