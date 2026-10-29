import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME, CLOUD_PUBLIC_MODEL_OPTIONS } from './shared.mjs'
import { createZipFixture } from './zip-fixtures.mjs'

const NAME = 'concurrent-home-skill'
const TEAM = 'Concurrent Claude Agent'

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
    const output = (body.input ?? []).find(
      item => item.type === 'function_call_output' && item.call_id === turn.callId
    )
    if (output) {
      assert.ok(
        JSON.stringify(output).includes(`CONCURRENT_SKILL_${turn.version}`),
        "A running task read another execution's Skill version"
      )
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
      return response.json()
    }
    const upload = async (version, id) => {
      const path = join(resultDir, `${NAME}-${version}.zip`)
      await createZipFixture(path, {
        [`${NAME}/SKILL.md`]: `---\nname: ${NAME}\ndescription: Concurrent Home Skill ${version}\n---\nCONCURRENT_SKILL_${version}\n`,
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
    const first = await upload('V1')
    const skillId = Number(first.metadata.labels.id)
    const bot = await request('bots', 'POST', {
      name: 'Concurrent Claude Bot',
      shell_name: 'ClaudeCode',
      agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
      skills: [NAME],
      skill_refs: { [NAME]: { skill_id: skillId, namespace: 'default', is_public: false } },
    })
    const team = await request('teams', 'POST', {
      name: TEAM,
      namespace: 'default',
      collaboration_model: 'pipeline',
      bots: [{ bot_id: bot.id }],
    })
    for (const [index, version] of [
      [1, 'V1'],
      [2, 'V2'],
    ]) {
      if (index === 2) await upload(version, skillId)
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
    }
    assert.equal(pending.size, 2, 'Both native processes must overlap')
    const workbench =
      cloud.remoteExecutorEnv.WEGENT_WORKBENCH_HOME ??
      join(cloud.remoteExecutorEnv.HOME, '.wegent/workbench')
    const homes = []
    for (const owner of await readdir(join(workbench, 'agents'))) {
      const candidate = join(workbench, 'agents', owner, 'default', TEAM, 'bots', String(bot.id))
      try {
        await readdir(candidate)
        homes.push(candidate)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    assert.equal(homes.length, 1, 'Both tasks must share one Agent Home')
    const home = homes[0]
    const snapshots = await readdir(join(home, 'runtime/executions'))
    assert.equal(snapshots.length, 2)
    const packages = []
    for (const name of snapshots) {
      const snapshot = join(home, 'runtime/executions', name)
      assert.equal(
        await realpath(join(snapshot, 'projects')),
        await realpath(join(home, 'projects'))
      )
      for (const file of ['mcp.json', 'settings.json', 'execution.json'])
        assert.ok((await readFile(join(snapshot, file))).length > 0)
      packages.push(await realpath(join(snapshot, 'skills', NAME)))
    }
    assert.notEqual(
      packages[0],
      packages[1],
      'Different Skill versions must retain different immutable packages'
    )
    for (const { response, turn } of pending.values()) {
      writeBashToolCall(
        response,
        `${turn.callId}-read`,
        turn.callId,
        `cat "$CLAUDE_CONFIG_DIR/skills/${NAME}/SKILL.md"`
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
