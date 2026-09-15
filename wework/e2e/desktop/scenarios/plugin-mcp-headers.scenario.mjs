import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createZipFixture } from '../modules/zip-fixtures.mjs'

const name = 'mcp-header-settings'
const identity = `${name}@wework-personal`
const edit = '[data-testid="plugin-mcp-headers-edit-mcp:business"]'
const input = '[data-testid="plugin-mcp-headers-input-mcp:business"]'
const save = '[data-testid="plugin-mcp-headers-save-mcp:business"]'
const section = '[data-testid="plugin-mcp-header-settings"]'

export async function createDesktopScenario({ resultDir, executorHome, captureScreenshot }) {
  const fixture = join(resultDir, name)
  await mkdir(fixture, { recursive: true })
  const archivePath = join(fixture, 'plugin.zip')
  const source = JSON.stringify({
    business: { url: 'https://example.test/mcp', headers: { 'X-Author': 'default' } },
    local: { command: 'unused-stdio-server' },
  })
  await createZipFixture(archivePath, {
    '.codex-plugin/plugin.json': JSON.stringify({
      name,
      version: '1.0.0',
      description: 'MCP header settings regression',
      mcpServers: './.mcp.json',
      author: { name: 'Wework E2E' },
      interface: {
        displayName: 'MCP Header Settings',
        shortDescription: 'MCP header settings regression',
        longDescription: 'Verify remote MCP headers from local plugin package metadata.',
        developerName: 'Wework E2E',
        category: 'Developer Tools',
        capabilities: ['MCP'],
        defaultPrompt: 'Use the remote MCP server.',
      },
    }),
    '.mcp.json': source,
  })
  const route = `/plugins?plugin=${name}&marketplace=wework-personal`
  const headers = { Authorization: 'Bearer ${{task_token}}' }

  return {
    async verify(control) {
      const preview = JSON.parse(
        await control.command('previewPluginImport', 'body', {
          value: JSON.stringify({ archivePath, marketplacePath: fixture }),
        })
      )
      assert.equal(preview.valid, true, JSON.stringify(preview.issues))
      await control.command('importPluginPackage', 'body', { value: JSON.stringify({ preview }) })
      await control.command('navigate', 'body', { value: route })
      await control.command('waitFor', section)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="plugin-mcp-headers-edit-mcp:local"]'
          )
        ),
        0
      )
      await control.command('click', edit)
      await control.command('fill', input, { value: '{"Bad Header":"value"}' })
      await control.command('click', save)
      await control.command('waitFor', section, { text: '请输入 JSON 对象' })
      await control.command('fill', input, { value: JSON.stringify(headers) })
      await control.command('click', save)
      await control.command('waitFor', section, { text: '已覆盖默认值' })
      await captureScreenshot(control, 'plugin-mcp-headers-saved.png')

      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', '[data-testid="plugins-button"]')
      await control.command('click', '[data-testid="plugins-button"]')
      await control.command('waitFor', `[data-testid="plugins-installed-strip-item-${identity}"]`)
      await control.command('click', `[data-testid="plugins-installed-strip-item-${identity}"]`)
      await control.command('waitFor', section, { text: '已覆盖默认值' })
      await control.command('click', edit)
      assert.deepEqual(JSON.parse(await control.command('getValue', input)), headers)
      await control.command('fill', input, { value: '{}' })
      await control.command('click', save)
      await control.command('waitFor', edit)
      assert.equal((await control.command('getText', section)).includes('已覆盖默认值'), false)
      await captureScreenshot(control, 'plugin-mcp-headers-cleared.png')
      const packageRoot = join(
        executorHome,
        'capabilities/bundled-marketplaces/wework-personal/plugins',
        name
      )
      assert.equal(await readFile(join(packageRoot, '.mcp.json'), 'utf8'), source)
    },
  }
}
