import { parse } from 'node:path'
import {
  CLOUD_DEVICE_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  IMAGE_ARTIFACT_BASE64,
  assert,
  dirname,
  fetchJson,
  join,
  mkdir,
  rm,
  writeFile,
} from './shared.mjs'

export async function verifyCloudFileAccessOutsideWorkspace({ cloudEnvironment, workspacePath }) {
  const directory = join(dirname(workspacePath), 'unregistered-file-access')
  const text = 'File outside the registered task workspace\n'
  const image = Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'README.md'), text)
  await writeFile(join(directory, 'sunset.png'), image)
  const execute = (commandKey, path, args = []) =>
    fetchJson(
      `${cloudEnvironment.backendUrl}/api/devices/${encodeURIComponent(CLOUD_DEVICE_ID)}/commands`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cloudEnvironment.authToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(DEFAULT_STEP_TIMEOUT_MS),
        body: JSON.stringify({ command_key: commandKey, path, args }),
      }
    )

  try {
    const root = await execute('workspace_tree', parse(workspacePath).root)
    assert.equal(root.success, true, 'The cloud device root could not be listed')
    assert.ok(Array.isArray(root.stdout.entries))
    const entries = await execute('workspace_tree', directory)
    assert.equal(entries.success, true, 'An unregistered cloud directory could not be listed')
    assert.deepEqual(entries.stdout.entries.map(entry => entry.name).sort(), [
      'README.md',
      'sunset.png',
    ])
    const document = await execute('workspace_read_text_file', directory, ['README.md'])
    assert.equal(document.success, true, 'Text outside the cloud workspace could not be read')
    assert.equal(document.stdout.content, text)
    const chunk = await execute('workspace_read_file_chunk', directory, ['sunset.png', '0'])
    assert.equal(chunk.success, true, 'An image outside the cloud workspace could not be read')
    assert.deepEqual(Buffer.from(chunk.stdout.content_base64, 'base64'), image)
    assert.equal(chunk.stdout.eof, true)
    const missing = await execute('workspace_read_text_file', directory, ['missing.txt'])
    assert.equal(missing.success, false, 'A missing file was reported as readable')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
