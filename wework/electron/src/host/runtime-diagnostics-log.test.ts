import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { RuntimeDiagnosticsLog } from './runtime-diagnostics-log.js'

test('persists task diagnostics from separate renderer surfaces without recording other console output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-runtime-log-'))
  try {
    const path = join(directory, 'runtime-launch.log')
    const log = new RuntimeDiagnosticsLog(path)
    await log.record(1, 'unrelated console output')
    await log.record(
      1,
      'TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:1234/wework/app/assets/main.js?token=private-token'
    )
    await log.record(
      1,
      'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with text/html.',
      'http://127.0.0.1:1234/wework/app/assets/initial-renderer.js?token=source-private-token'
    )
    await log.record(
      2,
      '[Wework] Runtime task create diagnostic {"stage":"pane-waiting-state","taskId":"runtime-1","waiting":false}'
    )
    await log.record(
      3,
      '[Wework] Runtime task create diagnostic {"stage":"lifecycle-transition","taskId":"runtime-1"}'
    )
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('web_contents_id=2')
    expect(contents).toContain('web_contents_id=3')
    expect(contents).toContain('"waiting":false')
    expect(contents).not.toContain('unrelated console output')
    expect(contents).toContain('Failed to fetch dynamically imported module')
    expect(contents).toContain('/wework/app/assets/main.js')
    expect(contents).toContain('/wework/app/assets/initial-renderer.js')
    expect(contents).not.toContain('private-token')
    expect(contents).not.toContain('127.0.0.1')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
