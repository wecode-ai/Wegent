// @vitest-environment node

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyGroupInlineMaintenance } from '../e2e/desktop/modules/collaboration-settings-ux.mjs'

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${content} ${selector}`
const original = 'Existing group rules'

function groupControl({ membersOpen = true, rulesOpen = true, scrollingWorks = true } = {}) {
  const expanded = { members: membersOpen, rules: rulesOpen, sharing: false }
  const positions = {
    'collaboration-group-detail-tab-members': 350,
    'collaboration-group-detail-tab-rules': 720,
    'collaboration-group-detail-instructions': 800,
    'collaboration-group-detail-tab-sharing': 1300,
    'collaboration-group-detail-back': 160,
  }
  const calls = []
  let scrollTop = 0
  let value = original
  let dirty = false
  let activeElement = ''
  let createOpen = false
  let unsavedOpen = false
  const visible = id => {
    if (positions[id] === undefined) return true
    const top = positions[id] - scrollTop
    return top + 52 > 0 && top < 720
  }

  return {
    calls,
    get value() {
      return value
    },
    async command(action, selector, options = {}) {
      const id = selector.match(/data-testid="([^"]+)"/)?.[1]
      calls.push({ action, id, options })
      if (action === 'scrollIntoViewAsUser') {
        assert.ok(id in positions, `Unexpected scroll target: ${id}`)
        if (scrollingWorks) scrollTop = Math.max(0, positions[id] - 360)
        return ''
      }
      if (action === 'getAttribute') {
        if (options.value === 'aria-expanded') return String(expanded[id.split('-').at(-1)])
        assert.equal(options.value, 'data-testid')
        return 'collaboration-group-detail-group-7'
      }
      if (action === 'getValue') return value
      if (action === 'getActiveElementTestId') return activeElement
      if (action === 'fill') {
        assert.ok(visible(id), `Cannot edit a field outside the viewport: ${id}`)
        value = options.value
        dirty = value !== original
        return ''
      }
      if (action === 'click' || action === 'clickWhenEnabled') {
        assert.ok(visible(id), `Cannot click a control outside the viewport: ${id}`)
        if (id === 'collaboration-project-settings-groups') scrollTop = 0
        if (id?.startsWith('collaboration-group-detail-tab-')) {
          const section = id.split('-').at(-1)
          expanded[section] = !expanded[section]
        }
        if (id === 'collaboration-group-detail-back') unsavedOpen = dirty
        if (id === 'collaboration-group-unsaved-cancel') unsavedOpen = false
        if (id === 'collaboration-group-detail-discard') {
          value = original
          dirty = false
        }
        return ''
      }
      if (action === 'nativePress') {
        if (options.key === 'Enter') {
          assert.equal(id, 'collaboration-group-open-create')
          createOpen = true
        } else if (options.key === 'Tab') {
          activeElement = 'collaboration-group-create-close'
        } else if (options.key === 'Escape') {
          createOpen = false
          activeElement = 'collaboration-group-open-create'
        } else assert.fail(`Unexpected key: ${options.key}`)
        return ''
      }
      if (action === 'waitFor') {
        if (options.visible !== false) assert.ok(visible(id), `Control remains offscreen: ${id}`)
        if (id === 'collaboration-group-save-status') {
          assert.equal(options.text, dirty ? '有未保存的更改' : '配置已保存')
        }
        if (id === 'group-template-saved-version-hint') assert.equal(expanded.sharing, true)
        if (id === 'collaboration-group-unsaved-dialog') assert.equal(unsavedOpen, true)
        if (id === 'collaboration-group-form') assert.equal(createOpen, options.visible)
        return ''
      }
      assert.fail(`Unexpected action: ${action}`)
    },
  }
}

test.each([true, false])(
  'reaches inline group sections in a 720px viewport and preserves draft checks, open=%s',
  async open => {
    const control = groupControl({ membersOpen: open, rulesOpen: open })
    await verifyGroupInlineMaintenance(control, scoped)
    assert.equal(control.value, original)
    assert.equal(control.calls.at(-1).id, 'collaboration-group-manage-group-7')
    assert.ok(
      control.calls.some(
        call => call.action === 'waitFor' && call.id === 'collaboration-group-detail-tab-rules'
      )
    )
  }
)

test('preserves the visible assertion if scrolling cannot reveal the rules', async () => {
  await assert.rejects(
    verifyGroupInlineMaintenance(groupControl({ scrollingWorks: false }), scoped),
    /Control remains offscreen: collaboration-group-detail-tab-rules/
  )
})
