import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { accountCommandResult } from './account-auth-command.mjs'
import {
  assertManagedPythonHome,
  managedPythonPath,
  MANAGED_PYTHON_VERSION,
} from './managed-python.mjs'
import {
  installFixture,
  materializedPlugin,
  openComposerPluginPicker,
  testId,
  until,
} from './plugin-regression-fixture.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  responseCompleted,
  responseCreated,
  toolOutputText,
} from './response-protocol.mjs'
import { ACTIVE_COMPOSER_SELECTOR, ACTIVE_WORKBENCH_SELECTOR, selectE2EModel } from './shared.mjs'
import { shellCommandPollResponse, shellCommandResponse } from './shell-command-response.mjs'

const PLUGIN = 'python-stdio-probe'
const PLUGIN_DISPLAY_NAME = `Wework ${PLUGIN}`
// Exercise a bundled script beyond the legacy prewarm scan's depth limit.
const SCRIPT_PATH = 'src/integrations/stdio/tools/runtime/checks/python/tests/probe/report.py'
const SERVER = 'python_stdio_probe'
const TOOL = 'report_python'
const CALL = 'managed-python-mcp-call'
const PROJECT_CALL = 'managed-python-mcp-project-isolation'
const PROMPT = 'WEWORK_MANAGED_PYTHON_MCP_PROBE'
const COMPLETE = 'WEWORK_MANAGED_PYTHON_MCP_COMPLETE'

const script = `import base64, json, os, sys
tool = "report_python"
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request["method"]
    if method == "initialize":
        result = {"protocolVersion": request["params"]["protocolVersion"],
                  "serverInfo": {"name": "python_stdio_probe", "version": "1.0"},
                  "capabilities": {"tools": {}}}
    elif method == "tools/list":
        result = {"tools": [{"name": tool, "description": "Report plugin Python",
                             "inputSchema": {"type": "object"},
                             "annotations": {"readOnlyHint": True}}]}
    elif method == "tools/call" and request["params"]["name"] == tool:
        details = {"version": sys.version.split()[0], "prefix": sys.base_prefix,
                   "pythonhome": os.environ.get("PYTHONHOME"), "args": sys.argv[1:],
                   "bridge_token": "WEWORK_PYTHON_RUNTIME_TOKEN" in os.environ}
        marker = "PYTHON_MCP:" + base64.b64encode(json.dumps(details).encode()).decode()
        result = {"content": [{"type": "text", "text": marker}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
`

export function createPluginPythonMcp({
  executorHome,
  electronUserDataDirectory,
  localPython,
  resultDir,
  uiTimeoutMs,
  workspacePath,
}) {
  let active = false
  let observed
  const venv = join(resultDir, 'mcp-project-venv')
  const projectPython =
    process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  const projectProbe = [
    `const assert=require('node:assert/strict'), cp=require('node:child_process'), fs=require('node:fs'), p=require('node:path');`,
    `assert.ok(!process.env.PATH.split(p.delimiter).includes(${JSON.stringify(dirname(managedPythonPath(electronUserDataDirectory)))}));`,
    `const prefix=cp.execFileSync(${JSON.stringify(projectPython)},['-c','import sys; print(sys.prefix)'],{encoding:'utf8'}).trim();`,
    `assert.equal(fs.realpathSync(prefix),fs.realpathSync(${JSON.stringify(venv)}));`,
    `console.log('PROJECT_PYTHON_PRESERVED');`,
  ].join('')
  const projectCommand = `node -e "eval(Buffer.from('${Buffer.from(projectProbe).toString('base64')}','base64').toString('utf8'))"`

  return {
    async handleHttp(request, response, url) {
      if (
        !active ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body).includes(PROMPT)) return false
      const id = `python-mcp-${Date.now()}`
      const output = toolOutputText(body, CALL)
      const projectResult = accountCommandResult(body.input, PROJECT_CALL)
      let events
      if (codexRequestKind(body) === 'prewarm') {
        events = [assistantMessage('Ready')]
      } else if (projectResult?.sessionId) {
        events = shellCommandPollResponse(body, projectResult.pollId, projectResult.sessionId)
      } else if (projectResult) {
        assert.ok(projectResult.output.includes('PROJECT_PYTHON_PRESERVED'), projectResult.output)
        events = [assistantMessage(COMPLETE)]
      } else if (output != null) {
        const marker = output.match(/PYTHON_MCP:([A-Za-z0-9+/=]+)/)?.[1]
        assert.ok(marker, 'Native Codex did not execute the installed plugin MCP tool')
        observed = JSON.parse(Buffer.from(marker, 'base64').toString('utf8'))
        events = shellCommandResponse(body, PROJECT_CALL, projectCommand, workspacePath)
      } else {
        events = mcpToolRequestEvents(body, {
          toolName: TOOL,
          directToolName: `mcp__${SERVER}__${TOOL}`,
          argumentsValue: {},
          searchCallId: 'managed-python-mcp-search',
          toolCallId: CALL,
          pluginDisplayName: PLUGIN_DISPLAY_NAME,
        }).events
      }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },

    async install(control, cloud) {
      await promisify(execFile)(
        'uv',
        ['venv', '--offline', '--no-python-downloads', '--python', localPython, venv],
        { timeout: uiTimeoutMs }
      )
      const packageRoot = join(resultDir, PLUGIN)
      await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
      await writeFile(
        join(packageRoot, '.codex-plugin', 'plugin.json'),
        JSON.stringify({
          name: PLUGIN,
          version: '1.0.0',
          mcpServers: './.mcp.json',
          interface: { displayName: PLUGIN_DISPLAY_NAME },
        })
      )
      const entry = join(packageRoot, SCRIPT_PATH)
      await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, script)
      const definition = JSON.stringify({
        [SERVER]: {
          command: 'python3',
          cwd: './',
          args: [SCRIPT_PATH, 'two words'],
          default_tools_approval_mode: 'auto',
        },
      })
      await writeFile(join(packageRoot, '.mcp.json'), definition)

      const release = await cloud.publishPluginRelease({
        slug: PLUGIN,
        version: '1.0.0',
        packageRoot,
      })
      const device = await cloud.waitForConnectedAppDevice()
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', testId('plugins-button'))
      const fixture = await installFixture(
        cloud,
        control,
        PLUGIN,
        device.execution_target_id,
        uiTimeoutMs,
        release
      )
      const installed = await until(
        () => materializedPlugin(executorHome, fixture.installedId),
        plugin => Boolean(plugin?.runtime?.codex_link),
        'The managed Python MCP plugin did not materialize',
        uiTimeoutMs
      )
      assert.equal(await readFile(join(installed.store_path, '.mcp.json'), 'utf8'), definition)
    },

    async verify(control, beforeCompletion = async () => {}) {
      observed = undefined
      await control.command('navigate', 'body', { value: '/' })
      await control.command('clickWhenEnabled', testId('new-chat-button'))
      await selectE2EModel(control)
      active = true
      try {
        await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
        await openComposerPluginPicker(control)
        await control.command('fill', testId('composer-plugin-picker-search'), { value: PLUGIN })
        await control.command(
          'clickWhenEnabled',
          testId(`composer-plugin-picker-item-plugin:${PLUGIN}`),
          {
            timeoutMs: uiTimeoutMs,
          }
        )
        await control.command('waitFor', testId(`composer-plugin-chip-${PLUGIN}`), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command(
          'clickWhenEnabled',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
          {
            timeoutMs: uiTimeoutMs,
          }
        )
        await beforeCompletion()
        await control.command(
          'waitFor',
          `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
          {
            text: COMPLETE,
            timeoutMs: uiTimeoutMs,
          }
        )
        assert.ok(observed, 'The plugin MCP did not report its interpreter')
        assert.equal(observed.version, MANAGED_PYTHON_VERSION)
        assertManagedPythonHome(observed, electronUserDataDirectory)
        assert.deepEqual(observed.args, ['two words'])
        assert.equal(observed.bridge_token, false)
      } finally {
        active = false
      }
    },
  }
}
