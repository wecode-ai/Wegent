import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'

export async function createDesktopScenario({ resultDir, executorHome, captureScreenshot }) {
  const source = join(resultDir, 'skill-source', 'capability-e2e')
  await mkdir(join(source, 'scripts'), { recursive: true })
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: capability-e2e\ndescription: Verify standalone skill installation\n---\nUse scripts/check.txt\n'
  )
  await writeFile(join(source, 'scripts/check.txt'), 'complete package')
  const mcpScript = join(resultDir, 'capability-mcp.cjs')
  await writeFile(
    mcpScript,
    `const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'capability-e2e',version:'1.0.0'}}:m.method==='tools/list'?{tools:[{name:'check_capability',description:'Verify local MCP connectivity',inputSchema:{type:'object',properties:{}}}]}:m.method==='tools/call'?{content:[{type:'text',text:'connected'}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`
  )
  const installed = join(executorHome, 'codex/skills/capability-e2e')
  return {
    async verify(control) {
      const click = id => control.command('click', `[data-testid="${id}"]`)
      const fill = (id, value) => control.command('fill', `[data-testid="${id}"]`, { value })
      const wait = (id, text) =>
        control.command('waitFor', `[data-testid="${id}"]`, text ? { text } : {})
      await control.command('navigate', 'body', { value: '/plugins' })
      await wait('capability-tab-skills')
      await click('capability-tab-skills')
      await wait('skills-panel')
      await click('skills-import')
      await fill('skill-source', source)
      await click('skill-install-submit')
      await wait('skill-candidate-0')
      await click('skill-candidate-0')
      await click('skill-install-submit')
      await control.command('waitFor', '[data-testid="skill-install-dialog"]', { visible: false })
      await wait('skills-panel', 'capability-e2e')
      assert.equal(await readFile(join(installed, 'scripts/check.txt'), 'utf8'), 'complete package')
      await fill('skills-search', 'capability-e2e')
      await wait('skill-toggle-0')
      await click('skill-toggle-0')
      await control.command('waitFor', '[data-testid="skill-toggle-0"][aria-checked="false"]')
      await click('skill-toggle-0')
      await control.command('waitFor', '[data-testid="skill-toggle-0"][aria-checked="true"]')
      await captureScreenshot(
        control,
        'standalone-skills.png',
        '[data-testid="capability-workspace"]'
      )
      await click('skills-import')
      await fill('skill-source', source)
      await click('skill-install-submit')
      await wait('skill-candidate-0')
      await click('skill-candidate-0')
      await click('skill-install-submit')
      await control.command('waitFor', '[data-testid="skill-install-dialog"] [role="alert"]', {
        text: '同名',
      })
      await click('skill-install-cancel')
      await click('skill-remove-0')
      await click('skill-remove-confirm')
      await wait('skills-panel', '没有匹配')
      await assert.rejects(access(installed))
      await click('capability-tab-mcp')
      await wait('mcp-panel')
      await control.command('waitFor', '[data-testid="mcp-add"]:not(:disabled)')
      await click('mcp-add')
      await fill('mcp-name', 'capability-e2e')
      await control.command('select', '[data-testid="mcp-transport"]', { value: 'stdio' })
      await fill('mcp-command', process.execPath)
      await fill('mcp-args', JSON.stringify([mcpScript]))
      await click('mcp-save')
      await wait('mcp-panel', 'capability-e2e')
      await wait('mcp-panel', '已连接')
      await click('mcp-tools-0')
      await wait('mcp-panel', 'check_capability')
      await captureScreenshot(control, 'standalone-mcp.png', '[data-testid="capability-workspace"]')
      await click('mcp-toggle-0')
      await wait('mcp-panel', '已停用')
      await control.command('waitFor', '[data-testid="mcp-toggle-0"]:not(:disabled)')
      await click('mcp-toggle-0')
      await wait('mcp-panel', '已连接')
      await control.command('waitFor', '[data-testid="mcp-remove-0"]:not(:disabled)')
      await click('mcp-remove-0')
      await click('mcp-remove-confirm')
      await wait('mcp-panel', '尚未添加')
      const config = await readFile(join(executorHome, 'codex/config.toml'), 'utf8')
      assert.ok(!config.includes('[mcp_servers.capability-e2e]'))
    },
    diagnostics() {
      return { standaloneCapabilities: true }
    },
  }
}
