import assert from 'node:assert/strict'
import { test } from 'vitest'
import { verifyIssueDetailPropertyUi } from '../e2e/desktop/modules/collaboration-issue-detail-ui.mjs'

const scope = selector => `[data-testid="active-issue"] ${selector}`

test('checks secondary properties inside their open portal and keeps the assignee accessible', async () => {
  let open = false
  let checkedVisibility = false
  let checkedStatus = false
  await verifyIssueDetailPropertyUi(
    {
      async command(action, selector, options) {
        if (action === 'getText') return '负责人 未指派 指派给我 添加日期'
        if (action === 'click') open = true
        if (action === 'press') {
          assert.equal(options.key, 'Escape')
          open = false
        }
        if (action === 'getAttribute') {
          assert.equal(options.value, 'aria-label')
          if (selector.includes('cloud-todo-detail-assignee')) return '负责人'
          assert.ok(open)
          assert.equal(
            selector,
            '[data-testid="cloud-todo-more-properties-popover"] [data-testid="cloud-issue-security-level"]'
          )
          checkedVisibility = true
          return '任务可见范围'
        }
        if (action === 'waitFor' && selector === '[role="tooltip"]') {
          assert.equal(options.text, '表示 Issue 当前所处的处理阶段')
          checkedStatus = true
        }
      },
    },
    scope,
    10_000
  )
  assert.ok(checkedVisibility)
  assert.ok(checkedStatus)
  assert.equal(open, false)
})

test.each(['负责人 负责人', '负责人 报告人', '负责人 创建人', '负责人 可见范围'])(
  'rejects duplicate or secondary properties in the primary row: %s',
  async text => {
    await assert.rejects(
      verifyIssueDetailPropertyUi(
        {
          async command(action) {
            if (action === 'getText') return text
          },
        },
        scope,
        10_000
      )
    )
  }
)
