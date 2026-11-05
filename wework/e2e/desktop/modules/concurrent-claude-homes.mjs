import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME, CLOUD_PUBLIC_MODEL_OPTIONS } from './shared.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

const NAME = 'concurrent-home-skill'
const TEAM = 'Concurrent Claude Agent'
const FORMATS = ['docx', 'xlsx', 'pptx', 'pdf']

async function findAgentHome(cloud, botId) {
  const workbench =
    cloud.remoteExecutorEnv.WEGENT_WORKBENCH_HOME ??
    join(cloud.remoteExecutorEnv.HOME, '.wegent/workbench')
  const homes = []
  for (const owner of await readdir(join(workbench, 'agents'))) {
    const candidate = join(workbench, 'agents', owner, 'default', TEAM, 'bots', String(botId))
    try {
      await readdir(candidate)
      homes.push(candidate)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  assert.equal(homes.length, 1, 'Both tasks must share one Agent Home')
  return homes[0]
}

// Hold the first real Claude inside its model request while a second execution
// activates a different version of the same Skill in the shared Agent Home.
export function createConcurrentClaudeHomes({
  resultDir,
  workspacePath,
  writeBashToolCall,
  writeText,
}) {
  const turns = []
  const pending = new Map()

  function handleModel(body, response) {
    const serialized = JSON.stringify(body)
    const turn = turns.find(candidate => serialized.includes(candidate.prompt))
    if (!turn) return false
    assert.equal(
      serialized.includes('CHAT_ONLY_BROWSER_FIXTURE'),
      true,
      'Real Claude did not discover the configured Chat-bound Skill'
    )
    const output = (body.input ?? []).find(
      item => item.type === 'function_call_output' && item.call_id === turn.callId
    )
    if (output) {
      assert.ok(
        JSON.stringify(output).includes('CHAT_ONLY_BROWSER_FIXTURE'),
        'Real Claude did not consume the configured Chat-bound Skill'
      )
      assert.ok(
        JSON.stringify(output).includes(`CONCURRENT_SKILL_${turn.version}`),
        "A running task read another execution's Skill version"
      )
      for (const format of FORMATS) {
        assert.ok(
          JSON.stringify(output).includes(`CONCURRENT_DOCUMENT_${format}_${turn.version}`),
          `The ${format} Skill or its resources changed during execution`
        )
      }
      assert.equal(JSON.stringify(output).includes('/root/.claude'), false)
      turn.completed = true
      writeText(response, `${turn.callId}-done`, turn.completion)
    } else {
      assert.ok(serialized.includes(NAME), 'Real Claude did not discover the selected Skill')
      assert.equal(pending.has(turn.index), false, 'Unexpected duplicate initial model request')
      pending.set(turn.index, { response, turn })
    }
    return true
  }

  async function waitFor(condition, message) {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (await condition()) return
      await delay(50)
    }
    throw new Error(message)
  }

  async function verify(cloud) {
    assert.equal(new URL(cloud.backendUrl).hostname, '127.0.0.1')
    const request = async (path, method = 'GET', body) => {
      const form = body instanceof FormData
      const response = await fetch(`${cloud.backendUrl}/api/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cloud.authToken}`,
          ...(!form && body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(10_000),
      })
      assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
      return response.status === 204 ? null : response.json()
    }
    const upload = async (version, id) => {
      const path = join(resultDir, `${NAME}-${version}.zip`)
      const mcps =
        version === 'V1'
          ? {
              'only-first-task': {
                type: 'stdio',
                command: process.execPath,
                args: [
                  fileURLToPath(new URL('./native-mcp-environment.mjs', import.meta.url)),
                  '--stdio-env-server',
                  'first',
                  join(resultDir, 'concurrent-home-mcp.json'),
                  'probe_environment',
                ],
                env: { TOKEN: '${{subtask_id}}', ELECTRON_RUN_AS_NODE: '1' },
              },
            }
          : {}
      await createZipFixture(path, {
        [`${NAME}/SKILL.md`]: `---\nname: ${NAME}\ndescription: Concurrent Home Skill ${version}\nmcpServers: ${JSON.stringify(mcps)}\n---\nCONCURRENT_SKILL_${version}\n`,
      })
      const form = new FormData()
      form.set('file', new Blob([await readFile(path)], { type: 'application/zip' }), `${NAME}.zip`)
      form.set('name', NAME)
      form.set('namespace', 'default')
      return request(
        id ? `v1/kinds/skills/${id}` : 'v1/kinds/skills/upload',
        id ? 'PUT' : 'POST',
        form
      )
    }
    const formats = FORMATS
    const formatIds = {}
    const uploadFormats = async version => {
      for (const format of formats) {
        const path = join(resultDir, `${format}-${version}.zip`)
        await createZipFixture(path, {
          [`${format}/SKILL.md`]: `---\nname: ${format}\ndescription: Native format fixture\nbindShells: [ClaudeCode, Codex]\n---\nCONCURRENT_DOCUMENT_${format}_${version}\n`,
          [`${format}/scripts/resource.txt`]: `CONCURRENT_DOCUMENT_${format}_${version}\n`,
        })
        const form = new FormData()
        form.set(
          'file',
          new Blob([await readFile(path)], { type: 'application/zip' }),
          `${format}.zip`
        )
        form.set('name', format)
        form.set('namespace', 'default')
        const id = formatIds[format]
        const skill = await request(
          id ? `v1/kinds/skills/${id}` : 'v1/kinds/skills/upload',
          id ? 'PUT' : 'POST',
          form
        )
        formatIds[format] = Number(skill.metadata.labels.id)
      }
    }
    await uploadFormats('V1')
    const browserArchive = join(resultDir, 'chat-only-browser.zip')
    await createZipFixture(browserArchive, {
      'browser/SKILL.md':
        '---\nname: browser\ndescription: CHAT_ONLY_BROWSER_FIXTURE\nbindShells:\n  - Chat\n---\nCHAT_ONLY_BROWSER_FIXTURE\n',
    })
    const browserForm = new FormData()
    browserForm.set(
      'file',
      new Blob([await readFile(browserArchive)], { type: 'application/zip' }),
      'browser.zip'
    )
    browserForm.set('name', 'browser')
    browserForm.set('namespace', 'default')
    const browser = await request('v1/kinds/skills/upload', 'POST', browserForm)
    const browserId = Number(browser.metadata.labels.id)
    const first = await upload('V1')
    const skillId = Number(first.metadata.labels.id)
    const bot = await request('bots', 'POST', {
      name: 'Concurrent Claude Bot',
      shell_name: 'ClaudeCode',
      agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
      skills: [NAME, ...formats, 'browser'],
      skill_refs: {
        [NAME]: { skill_id: skillId, namespace: 'default', is_public: false },
        ...Object.fromEntries(
          formats.map(format => [
            format,
            { skill_id: formatIds[format], namespace: 'default', is_public: false },
          ])
        ),
        browser: { skill_id: browserId, namespace: 'default', is_public: false },
      },
    })
    const team = await request('teams', 'POST', {
      name: TEAM,
      namespace: 'default',
      collaboration_model: 'pipeline',
      bots: [{ bot_id: bot.id }],
    })
    let home, firstMcp
    for (const [index, version] of [
      [1, 'V1'],
      [2, 'V2'],
    ]) {
      if (index === 2) {
        await upload(version, skillId)
        await uploadFormats(version)
      }
      const turn = {
        index,
        version,
        prompt: `CONCURRENT_HOME_TURN_${index}`,
        callId: `concurrent-home-${index}`,
        completion: `CONCURRENT_HOME_DONE_${index}`,
      }
      turns.push(turn)
      const workspace = join(workspacePath, `concurrent-home-${index}`)
      await mkdir(workspace, { recursive: true })
      const result = await request('runtime-work/create', 'POST', {
        schemaVersion: 3,
        wegentTeamId: team.id,
        deviceId: CLOUD_DEVICE_ID,
        workspacePath: workspace,
        runtime: 'claude_code',
        modelId: CLOUD_PUBLIC_MODEL_NAME,
        modelType: 'public',
        modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
        message: turn.prompt,
        modelSelection: {
          modelName: CLOUD_PUBLIC_MODEL_NAME,
          modelType: 'public',
          options: CLOUD_PUBLIC_MODEL_OPTIONS,
        },
      })
      assert.equal(result.accepted, true, result.error)
      turn.address = {
        deviceId: result.deviceId,
        taskId: result.taskId,
        workspacePath: result.workspacePath,
        runtimeHandle: result.runtimeHandle,
      }
      await waitFor(
        () => pending.has(index),
        `Claude task ${index} did not start while the preceding task was held`
      )
      if (index === 1) {
        home = await findAgentHome(cloud, bot.id)
        const snapshots = await readdir(join(home, 'runtime/executions'))
        assert.equal(snapshots.length, 1)
        const path = join(home, 'runtime/executions', snapshots[0], 'mcp.json')
        firstMcp = {
          path,
          contents: await readFile(path, 'utf8'),
          metadata: await stat(path, { bigint: true }),
        }
      }
    }
    assert.equal(pending.size, 2, 'Both native processes must overlap')
    assert.equal(await findAgentHome(cloud, bot.id), home)
    const firstMcpAfter = await stat(firstMcp.path, { bigint: true })
    assert.equal(firstMcpAfter.ino, firstMcp.metadata.ino, 'The running MCP file was replaced')
    assert.equal(
      firstMcpAfter.mtimeNs,
      firstMcp.metadata.mtimeNs,
      'The running MCP file was edited'
    )
    assert.equal(await readFile(firstMcp.path, 'utf8'), firstMcp.contents)
    await assert.rejects(readFile(join(home, 'mcp.json')), { code: 'ENOENT' })
    const snapshots = await readdir(join(home, 'runtime/executions'))
    assert.equal(snapshots.length, 2)
    const packages = []
    const formatPackages = Object.fromEntries(formats.map(format => [format, []]))
    for (const name of snapshots) {
      const snapshot = join(home, 'runtime/executions', name)
      assert.equal(
        await realpath(join(snapshot, 'projects')),
        await realpath(join(home, 'projects'))
      )
      for (const file of ['mcp.json', 'settings.json', 'execution.json'])
        assert.ok((await readFile(join(snapshot, file))).length > 0)
      const { runtime_task_id: taskId } = JSON.parse(
        await readFile(join(snapshot, 'execution.json'))
      )
      const turn = turns.find(turn => String(turn.address.taskId) === taskId)
      assert.ok(turn, 'Every snapshot must belong to one of the two running tasks')
      const { mcpServers } = JSON.parse(await readFile(join(snapshot, 'mcp.json')))
      assert.equal(
        Object.keys(mcpServers).some(name => name.endsWith('_only-first-task')),
        turn.index === 1,
        'A task must not inherit another task’s Skill MCP server'
      )
      assert.equal(
        (await readdir(join(snapshot, 'skills'))).includes('browser'),
        true,
        'The configured Chat-bound Skill is missing from the native execution snapshot'
      )
      packages.push(await realpath(join(snapshot, 'skills', NAME)))
      for (const format of formats) {
        const packagePath = await realpath(join(snapshot, 'skills', format))
        formatPackages[format].push(packagePath)
        const instructions = await readFile(join(packagePath, 'SKILL.md'), 'utf8')
        const resource = await readFile(join(packagePath, 'scripts/resource.txt'), 'utf8')
        assert.ok(
          instructions.includes(resource.trim()),
          'Format instructions and resources must share a version'
        )
      }
    }
    assert.notEqual(
      packages[0],
      packages[1],
      'Different Skill versions must retain different immutable packages'
    )
    for (const format of formats) {
      assert.notEqual(formatPackages[format][0], formatPackages[format][1])
    }
    for (const { response, turn } of pending.values()) {
      writeBashToolCall(
        response,
        `${turn.callId}-read`,
        turn.callId,
        `cat "$CLAUDE_CONFIG_DIR/skills/${NAME}/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/browser/SKILL.md" && cat "$CLAUDE_CONFIG_DIR/skills/docx/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/docx/scripts/resource.txt" && cat "$CLAUDE_CONFIG_DIR/skills/xlsx/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/xlsx/scripts/resource.txt" && cat "$CLAUDE_CONFIG_DIR/skills/pptx/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/pptx/scripts/resource.txt" && cat "$CLAUDE_CONFIG_DIR/skills/pdf/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/pdf/scripts/resource.txt"`
      )
    }
    pending.clear()
    await waitFor(
      () => turns.every(turn => turn.completed),
      'Concurrent Claude tasks did not complete with their own Skill snapshots'
    )
    for (const turn of turns) {
      await waitFor(async () => {
        const transcript = await request('runtime-work/transcript', 'POST', turn.address)
        return JSON.stringify(transcript).includes(turn.completion)
      }, 'Native task completion was not persisted')
    }
    await writeFile(
      join(resultDir, 'concurrent-claude-homes.json'),
      JSON.stringify({ passed: true, home, snapshots, packages, overlappingExecutions: 2 }, null, 2)
    )
  }

  function cleanup() {
    for (const { response } of pending.values()) {
      if (!response.writableEnded && !response.destroyed) {
        response.writeHead(500)
        response.end('Concurrent Home verification stopped')
      }
    }
    pending.clear()
  }

  return { handleModel, verify, cleanup }
}
