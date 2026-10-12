import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { expect, test } from 'vitest'

test('keeps delayed notification clicks alive across GC and releases completed notifications', () => {
  const source = readFileSync(new URL('./notification-lifecycle.ts', import.meta.url), 'utf8')
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
  })
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  const result = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict'
        import { EventEmitter } from 'node:events'
        import { setImmediate } from 'node:timers/promises'
        const { showRetainedNotification } = await import(${JSON.stringify(moduleUrl)})
        const clicks = []
        const errors = []
        console.error = (...args) => errors.push(args)
        function createNotification(id, terminalEvent) {
          const notification = new EventEmitter()
          notification.show = () => {
            if (terminalEvent === 'throw') throw new Error('show failed')
          }
          try {
            showRetainedNotification(notification, () => clicks.push(id))
          } catch (error) {
            assert.equal(terminalEvent, 'throw')
            assert.equal(error.message, 'show failed')
          }
          if (terminalEvent && terminalEvent !== 'throw') notification.emit(terminalEvent)
          return new WeakRef(notification)
        }
        async function collectGarbage() {
          for (let i = 0; i < 6; i++) {
            await setImmediate()
            global.gc()
          }
        }
        const first = createNotification('first')
        const second = createNotification('second')
        await collectGarbage()
        assert.ok(first.deref(), 'The first notification lost its native click delegate after GC')
        assert.ok(second.deref(), 'The second notification lost its native click delegate after GC')
        first.deref().emit('click')
        second.deref().emit('click')
        assert.deepEqual(clicks, ['first', 'second'])
        const closed = createNotification('closed', 'close')
        const failed = createNotification('failed', 'failed')
        const thrown = createNotification('thrown', 'throw')
        assert.equal(errors.length, 1, 'Native delivery failures must be reported')
        await collectGarbage()
        for (const ref of [first, second, closed, failed, thrown]) {
          assert.equal(ref.deref(), undefined, 'A completed notification was retained')
        }
      `,
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )

  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
})
