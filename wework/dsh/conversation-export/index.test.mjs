import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'

import { apply } from './index.js'

test('loads after packaging without workspace dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-isolated-'))
  const plugin = join(root, 'plugin')
  await mkdir(plugin)
  for (const filename of ['index.js', 'zipArchive.js', 'package.json']) {
    await cp(new URL(filename, import.meta.url), join(plugin, filename))
  }

  const packaged = await import(pathToFileURL(join(plugin, 'index.js')).href)

  assert.equal(packaged.name, 'wework-conversation-export')
  await rm(root, { recursive: true, force: true })
})

test('writes and overwrites an export through a polled backend task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-'))
  const destination = join(root, 'conversation.md')
  await writeFile(destination, 'Old export\n')
  let registration
  const cleanups = []
  const ctx = {
    effect(factory) {
      cleanups.push(factory())
    },
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  }
  apply(ctx)

  const { exportTaskId } = await registration.methods.start({ path: destination })
  await registration.methods.append({ exportTaskId, content: '# Conversation\n' })
  await registration.methods.append({ exportTaskId, content: 'Complete.\n' })
  const finishing = await registration.methods.finish({ exportTaskId })
  const result = await waitForTerminalStatus(registration.methods, exportTaskId)

  assert.equal(finishing.state, 'finalizing')
  assert.equal(await readFile(destination, 'utf8'), '# Conversation\nComplete.\n')
  assert.deepEqual(result, {
    assetsCompleted: 0,
    assetsTotal: 0,
    exportTaskId,
    phase: 'finalizing',
    state: 'completed',
    path: destination,
    size: Buffer.byteLength('# Conversation\nComplete.\n'),
  })
  for (const cleanup of cleanups) cleanup()
  await rm(root, { recursive: true, force: true })
})

test('packages the document and local assets into a zip export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-zip-'))
  const destination = join(root, 'conversation.zip')
  const image = join(root, 'image.png')
  await writeFile(image, Buffer.from([1, 2, 3, 4]))
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  const { exportTaskId } = await registration.methods.start({
    path: destination,
    archive: true,
    documentName: 'conversation.md',
    assetCount: 1,
  })
  await registration.methods.append({
    exportTaskId,
    content: '# Conversation\n\n![Image](<images/image.png>)\n',
  })
  await registration.methods.addAsset({
    exportTaskId,
    archivePath: 'images/image.png',
    path: image,
    workspacePath: null,
  })
  await registration.methods.finish({ exportTaskId })
  const result = await waitForTerminalStatus(registration.methods, exportTaskId)
  const archive = await JSZip.loadAsync(await readFile(destination))

  assert.equal(result.state, 'completed')
  assert.equal(
    await archive.file('conversation.md').async('string'),
    '# Conversation\n\n![Image](<images/image.png>)\n'
  )
  assert.deepEqual([...(await archive.file('images/image.png').async('uint8array'))], [1, 2, 3, 4])
  await rm(root, { recursive: true, force: true })
})

test('packages an uploaded asset without sending it in one request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-upload-'))
  const destination = join(root, 'conversation.zip')
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  const { exportTaskId } = await registration.methods.start({
    path: destination,
    archive: true,
    documentName: 'conversation.html',
    assetCount: 1,
  })
  await registration.methods.append({ exportTaskId, content: '<p>Attachment</p>' })
  await registration.methods.appendAsset({
    exportTaskId,
    archivePath: 'attachments/data.bin',
    contentBase64: Buffer.from([1, 2]).toString('base64'),
  })
  await registration.methods.appendAsset({
    exportTaskId,
    archivePath: 'attachments/data.bin',
    contentBase64: Buffer.from([3, 4]).toString('base64'),
  })
  await registration.methods.finish({ exportTaskId })
  await waitForTerminalStatus(registration.methods, exportTaskId)
  const archive = await JSZip.loadAsync(await readFile(destination))

  assert.deepEqual(
    [...(await archive.file('attachments/data.bin').async('uint8array'))],
    [1, 2, 3, 4]
  )
  await rm(root, { recursive: true, force: true })
})

test('rejects concurrent exports to the same destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-conflict-'))
  const destination = join(root, 'conversation.md')
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  const { exportTaskId } = await registration.methods.start({ path: destination })

  await assert.rejects(
    registration.methods.start({ path: destination }),
    /already writing to this destination/
  )
  await registration.methods.cancel({ exportTaskId })
  await rm(root, { recursive: true, force: true })
})

test('rejects destinations outside the supported export formats', async () => {
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  await assert.rejects(
    registration.methods.start({ path: '/tmp/conversation.txt' }),
    /must end with .md, .html, or .zip/
  )
})

test('reads local images in bounded base64 chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-image-'))
  const source = join(root, 'image.png')
  await writeFile(source, Buffer.from([1, 2, 3, 4]))
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  const chunk = await registration.methods.readImageChunk({ path: source, offset: 0 })

  assert.deepEqual(chunk, {
    chunkBase64: 'AQIDBA==',
    bytesRead: 4,
    eof: true,
    size: 4,
  })
  await rm(root, { recursive: true, force: true })
})

test('resolves Markdown image paths relative to the conversation workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wework-conversation-export-relative-image-'))
  const source = join(root, 'image.png')
  await writeFile(source, Buffer.from([1, 2, 3, 4]))
  let registration
  apply({
    effect() {},
    weworkPluginRuntime: {
      register(_owner, value) {
        registration = value
      },
    },
  })

  const chunk = await registration.methods.readImageChunk({
    path: 'image.png',
    offset: 0,
    workspacePath: root,
  })

  assert.equal(chunk.chunkBase64, 'AQIDBA==')
  await rm(root, { recursive: true, force: true })
})

async function waitForTerminalStatus(methods, exportTaskId) {
  for (;;) {
    const status = await methods.status({ exportTaskId })
    if (!['writing', 'finalizing'].includes(status.state)) return status
    await new Promise(resolve => setImmediate(resolve))
  }
}
