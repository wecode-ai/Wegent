import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AppUpdateLogger } from './app-update-logger.js'

test('persists updater diagnostics and redacts credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-app-update-log-'))
  const path = join(directory, 'app-update.log')
  const logger = new AppUpdateLogger(path)

  logger.info('Full: 365 MB, To download: 20 MB')
  logger.error(new Error('Cannot download differentially: token=secret-token'))
  await logger.flush()

  const contents = await readFile(path, 'utf8')
  expect(contents).toContain('[info] Full: 365 MB, To download: 20 MB')
  expect(contents).toContain('[error] Error: Cannot download differentially')
  expect(contents).not.toContain('secret-token')
})
