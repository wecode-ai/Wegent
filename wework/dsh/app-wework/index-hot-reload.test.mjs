import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { injectDevelopmentReload, weworkIndexInjection } from './index.js'

test('injects reload polling only into the original development application', () => {
  const html = '<html><head></head><body></body></html>'
  assert.equal(injectDevelopmentReload(html, {}, 'build-1'), html)

  const developmentHtml = injectDevelopmentReload(html, { WEWORK_APP_HOT_RELOAD: '1' }, 'build-1')
  assert.match(developmentHtml, /x-wework-app-build-id/)
  assert.match(developmentHtml, /"build-1"/)
  assert.match(developmentHtml, /window\.location\.reload/)
})

test('reads the current application assets and build id for every page injection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-app-hot-reload-'))
  const indexPath = join(directory, 'index.html')

  try {
    await writeFile(
      indexPath,
      '<html><head><script type="module" src="/assets/first.js"></script></head></html>'
    )
    const firstInjection = weworkIndexInjection({ WEWORK_APP_HOT_RELOAD: '1' }, indexPath)

    await writeFile(
      indexPath,
      '<html><head><script type="module" src="/assets/second-build.js"></script></head></html>'
    )
    const secondInjection = weworkIndexInjection({ WEWORK_APP_HOT_RELOAD: '1' }, indexPath)

    assert.match(firstInjection[0].html, /first\.js/)
    assert.match(secondInjection[0].html, /second-build\.js/)
    assert.notEqual(firstInjection[2].html, secondInjection[2].html)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
