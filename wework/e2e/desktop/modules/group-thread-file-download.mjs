import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { waitForValue } from './workspace-agent-setup.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`

/** Keep the UI, authenticated Blob transfer and Electron disk download real. */
export async function verifyGroupFileDownload({
  control,
  directory,
  resultDir,
  fileId,
  groupId,
  threadId,
  content,
  timeoutMs,
  capture,
}) {
  assert.deepEqual(await readdir(directory), [], 'The download directory must be isolated')
  const logPath = join(resultDir, 'app.log')
  const logOffset = (await readFile(logPath)).length
  await control.command('click', scoped('thread-back-to-group'), { visible: true })
  await control.command('waitFor', scoped('group-room'), { visible: true, timeoutMs })
  await control.command('click', scoped('group-tab-files'), { visible: true })
  await control.command(
    'clickWhenEnabled',
    `${scoped('cloud-file-browser-entry-root:shared')} button`,
    { visible: true, timeoutMs }
  )
  const download = scoped(`cloud-file-download-${fileId}`)
  await control.command('waitFor', download, { visible: true, timeoutMs })
  await control.command('clickWhenEnabled', download, { visible: true, timeoutMs })
  const expectedName = 'same-name.txt'
  await waitForValue(
    () => readdir(directory),
    names => names.includes(expectedName),
    'The real Group file UI did not save its named download',
    timeoutMs
  )
  await waitForValue(
    async () => (await readFile(logPath)).subarray(logOffset).toString(),
    log => log.includes('[Wework E2E] browser-download {"completed":true}'),
    'The native browser did not complete the Group download',
    timeoutMs
  )
  assert.deepEqual(await readdir(directory), [expectedName])
  assert.deepEqual(await readFile(join(directory, expectedName)), Buffer.from(content))
  await capture(control, 'cloud-group-file-download-verified.png')
  await control.command('openWeworkScheme', 'body', {
    value: `wework://groups/backend/${encodeURIComponent(groupId)}/threads/${encodeURIComponent(threadId)}`,
  })
  await control.command('waitFor', scoped('thread-room'), { visible: true, timeoutMs })
  const route = new URL(JSON.parse(await control.command('snapshot', CONTENT)).location)
  assert.equal(route.searchParams.get('groupId'), groupId)
  assert.equal(route.searchParams.get('threadId'), threadId)
  assert.equal(route.searchParams.get('groupStore'), 'cloud')
}
