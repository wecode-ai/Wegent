import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function waitForInterruptedRollback(root) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    let marker
    try {
      marker = await readFile(join(root, 'rollback-interrupted'), 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (marker) {
      const pid = Number(await readFile(join(root, 'active-pid'), 'utf8'))
      assert.ok(pid > 0)
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') return
        throw error
      }
    }
    await new Promise(accept => setTimeout(accept, 50))
  }
  assert.fail('The real target did not terminate after recording manual rollback')
}
