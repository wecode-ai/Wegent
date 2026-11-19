import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { until } from './plugin-regression-fixture.mjs'
import { CLOUD_DEVICE_ID, DEFAULT_STEP_TIMEOUT_MS, IMAGE_ARTIFACT_BASE64 } from './shared.mjs'

export async function verifyMarkdownRelativeFileLinks({ control, workspacePath }) {
  const directory = join(workspacePath, 'markdown-link-fixture')
  const documentName = 'relative-image-report.md'
  const documentPath = join(directory, 'reports', documentName).replaceAll('\\', '/')
  const imageName = '相对路径 截图.png'
  const imagePath = join(directory, 'reports', imageName).replaceAll('\\', '/')
  const parentImagePath = join(directory, 'parent.png').replaceAll('\\', '/')
  await mkdir(join(directory, 'reports'), { recursive: true })
  const image = Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64')
  await writeFile(imagePath, image)
  await writeFile(parentImagePath, image)
  await writeFile(
    documentPath,
    [
      '# Relative image links',
      `[Same directory](<./${imageName}>)`,
      '[Parent directory](../parent.png)',
      '[Missing image](./missing.png)',
    ].join('\n\n')
  )

  const panel = `[data-testid="workspace-file-panel"][data-workspace-device-id="${CLOUD_DEVICE_ID}"]`
  const preview = `${panel} [data-testid="workspace-markdown-preview"]`
  const links = `${preview} [data-testid="assistant-markdown-link"]`
  let documentOpened = false
  const openDocument = async () => {
    if (documentOpened) {
      await control.command('clickElementWithText', '[data-testid^="right-workspace-file-tab-"]', {
        text: documentName,
      })
      await control.command('waitFor', preview, { text: 'Relative image links' })
      return
    }
    const toggle = `${panel} [data-testid="workspace-file-toggle-tree-button"]`
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true') {
      await control.command('clickWhenEnabled', toggle)
    }
    await control.command('fill', `${panel} [data-testid="workspace-file-search-input"]`, {
      value: '',
    })
    await control.command(
      'clickWhenEnabled',
      `${panel} [data-testid="workspace-file-refresh-button"]`
    )
    for (const name of ['markdown-link-fixture', 'reports', documentName]) {
      const entry = `button[data-type="item"][aria-label="${name}"]`
      await control.command('waitFor', entry, { timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
      const expanded = await control.command('getAttribute', entry, { value: 'aria-expanded' })
      if (name === documentName || expanded !== 'true') {
        await control.command('clickWhenEnabled', entry)
      }
    }
    await control.command('waitFor', preview, { text: 'Relative image links' })
    documentOpened = true
  }
  const assertImage = async expectedPath => {
    await control.command('waitFor', `${panel} [data-testid="workspace-file-path"]`, {
      text: expectedPath,
    })
    assert.equal(
      await control.command('getText', `${panel} [data-testid="workspace-file-path"]`),
      expectedPath,
      'The relative link did not resolve against the Markdown document directory'
    )
    await control.command(
      'waitFor',
      `${panel} [data-testid="workspace-file-preview-loading-indicator"]`,
      {
        visible: false,
      }
    )
    const imageSelector = `${panel} [data-testid="workspace-binary-file-preview"] .image-stage img`
    await control.command('waitFor', imageSelector)
    await until(
      async () => JSON.parse(await control.command('getImageLoadState', imageSelector)),
      images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0,
      `The linked image did not decode: ${expectedPath}`
    )
  }

  try {
    await openDocument()
    await control.command('clickElementWithText', links, { text: 'Same directory' })
    await assertImage(imagePath)
    await openDocument()
    await control.command('clickElementWithText', links, { text: 'Parent directory' })
    await assertImage(parentImagePath)
    await openDocument()
    await control.command('clickElementWithText', links, { text: 'Missing image' })
    await control.command('waitFor', `${panel} [data-testid="workspace-file-preview-error"]`)
    await openDocument()
    await control.command('clickElementWithText', links, { text: 'Same directory' })
    await assertImage(imagePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
