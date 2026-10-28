import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

test('registers export commands, menus, and the dialog overlay', async () => {
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  let handoff
  const events = []
  class CustomEvent {
    constructor(type, options) {
      this.type = type
      this.detail = options.detail
    }
  }
  const window = {
    __ModuleLoader__: {
      load(value) {
        handoff = value
      },
    },
    dispatchEvent(event) {
      events.push(event)
    },
  }
  vm.runInNewContext(source, { CustomEvent, window })
  const plugin = handoff.factory()
  const commands = []
  const menus = []
  const contributions = []
  let locale = 'en'
  const ctx = {
    slots: {
      inject(_slot, factory) {
        factory()
      },
    },
    wework: {
      commands: {
        register(_owner, definition, handler) {
          commands.push({ definition, handler })
        },
      },
      contributions: {
        register(_owner, slot, descriptor) {
          contributions.push({ descriptor, slot })
          return () => {}
        },
      },
      localization: {
        translate(messages, fallback) {
          if (typeof messages === 'string') return messages
          return messages[locale] ?? fallback
        },
      },
      menus: {
        register(_owner, location, item) {
          menus.push({ item, location })
        },
      },
    },
  }

  plugin.apply(ctx)
  assert.equal(commands[0].definition.id, 'conversation-export.open')
  assert.deepEqual(
    menus.map(entry => entry.location),
    ['conversation.toolbar', 'conversation.context']
  )
  assert.equal(commands[0].definition.title, 'Export conversation')
  assert.equal(typeof menus[0].item.title, 'function')
  locale = 'zh-CN'
  assert.equal(menus[0].item.title(), '导出会话')
  assert.equal(menus[1].item.title(), '导出会话')
  assert.equal(contributions[0].descriptor.module, 'plugins/wework-ui-conversation-export.js')

  commands[0].handler({ deviceId: 'device-1', taskId: 'task-1' })
  assert.equal(events[0].type, 'wework:conversation-export:open')
  assert.equal(events[0].detail.taskId, 'task-1')
})
