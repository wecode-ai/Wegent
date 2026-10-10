import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

import { CLOUD_DEVICE_ID, CLOUD_PUBLIC_MODEL_NAME, CLOUD_PUBLIC_MODEL_OPTIONS } from './shared.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function createSharedSkillRuntime({
  resultDir,
  workspacePath,
  writeBashToolCall,
  writeToolCall,
  writeText,
  runtime = 'claude_code',
}) {
  const isCodex = runtime === 'codex'
  const NAME = isCodex ? 'workbench-codex-skill' : 'workbench-shared-skill'
  const TEAM = isCodex ? 'Shared Codex Agent' : 'Shared Skill Agent'
  const promptPrefix = isCodex ? 'WEWORK_CODEX_SHARED_SKILL' : 'WEWORK_SHARED_SKILL'
  let turn = null
  let completed = false

  function handleModel(body, response) {
    const serialized = JSON.stringify(body)
    if (!turn || !serialized.includes(turn.prompt)) return false
    if (turn.index > 1) assert.ok(serialized.includes(`${promptPrefix}_TURN_1`))
    assert.ok(serialized.includes(NAME), 'Native Claude did not discover the shared skill')
    if (isCodex) {
      completed = true
      writeText(response, `${turn.callId}-done`, turn.completion)
      return true
    }
    const output = (body.input ?? []).find(
      item => item.type === 'function_call_output' && item.call_id === turn.callId
    )
    if (!output) {
      assert.ok(body.tools?.some(tool => tool.name === 'Bash'))
      writeBashToolCall(
        response,
        turn.callId,
        turn.callId,
        `cat "$CLAUDE_CONFIG_DIR/skills/${NAME}/SKILL.md"`
      )
    } else {
      assert.ok(
        JSON.stringify(output).includes(turn.content),
        'Claude read the wrong skill version'
      )
      const mcpOutput = (body.input ?? []).find(
        item => item.type === 'function_call_output' && item.call_id === `${turn.callId}-mcp`
      )
      if (!mcpOutput) {
        const tool = body.tools?.find(tool => tool.name?.endsWith('__probe_environment'))
        assert.ok(tool, 'Retained skill MCP tool is unavailable to native Claude')
        writeToolCall(response, `${turn.callId}-mcp`, `${turn.callId}-mcp`, tool.name, {})
      } else {
        assert.match(JSON.stringify(mcpOutput), /MCP_CONTEXT:\d+/)
        turn.mcpOutput = JSON.stringify(mcpOutput)
        completed = true
        writeText(response, `${turn.callId}-done`, turn.completion)
      }
    }
    return true
  }

  async function verify(cloud) {
    assert.equal(new URL(cloud.backendUrl).hostname, '127.0.0.1')
    const request = async (path, method = 'GET', body) => {
      const form = body instanceof FormData
      const response = await fetch(`${cloud.backendUrl}/api/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${cloud.authToken}`,
          ...(!form && body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? (form ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(10_000),
      })
      assert.ok(
        response.ok,
        `${method} ${path}: ${response.status} ${await response.clone().text()}`
      )
      return response
    }
    const upload = async (version, id) => {
      const zip = new JSZip()
      const mcps =
        !isCodex && version === 'V1'
          ? {
              'retained-skill-mcp': {
                type: 'stdio',
                command: process.execPath,
                args: [
                  fileURLToPath(new URL('./native-mcp-environment.mjs', import.meta.url)),
                  '--stdio-env-server',
                  'first',
                  join(resultDir, 'claude-mcp-probe.json'),
                  'probe_environment',
                ],
                env: { TOKEN: '${{subtask_id}}', ELECTRON_RUN_AS_NODE: '1' },
              },
            }
          : {}
      zip.file(
        `${NAME}/SKILL.md`,
        `---\nname: ${NAME}\ndescription: Shared skill ${version}\nmcpServers: ${JSON.stringify(mcps)}\n---\nWEWORK_SHARED_SKILL_${version}\n`
      )
      const bytes = await zip.generateAsync({ type: 'nodebuffer' })
      const form = new FormData()
      form.set('file', new Blob([bytes], { type: 'application/zip' }), `${NAME}.zip`)
      form.set('name', NAME)
      form.set('namespace', 'default')
      const skill = await (
        await request(
          id ? `v1/kinds/skills/${id}` : 'v1/kinds/skills/upload',
          id ? 'PUT' : 'POST',
          form
        )
      ).json()
      assert.equal(skill.status.fileHash, digest(bytes))
      const downloaded = await request(`v1/kinds/skills/${skill.metadata.labels.id}/download`)
      const archive = Buffer.from(await downloaded.arrayBuffer())
      assert.notEqual(
        digest(archive),
        skill.status.fileHash,
        'Fixture must exercise sanitized ZIP bytes'
      )
      return skill
    }

    const first = await upload('V1')
    const skillId = Number(first.metadata.labels.id)
    const bot = await (
      await request('bots', 'POST', {
        name: isCodex ? 'Shared Codex Bot' : 'Shared Skill Bot',
        shell_name: isCodex ? 'Codex' : 'ClaudeCode',
        agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
        skills: [NAME],
        skill_refs: { [NAME]: { skill_id: skillId, namespace: 'default', is_public: false } },
      })
    ).json()
    const team = await (
      await request('teams', 'POST', {
        name: TEAM,
        namespace: 'default',
        bots: [{ bot_id: bot.id }],
      })
    ).json()
    const modelSelection = {
      modelName: CLOUD_PUBLIC_MODEL_NAME,
      modelType: 'public',
      options: CLOUD_PUBLIC_MODEL_OPTIONS,
    }
    let address
    const runTurn = async (version, index) => {
      turn = {
        index,
        prompt: `${promptPrefix}_TURN_${index}`,
        content: `WEWORK_SHARED_SKILL_${version}`,
        callId: `shared-skill-${index}`,
        completion: `${promptPrefix}_DONE_${index}`,
      }
      completed = false
      const result = await (
        await request(
          address ? 'runtime-work/send' : 'runtime-work/create',
          'POST',
          address
            ? { address, message: turn.prompt, modelSelection }
            : {
                schemaVersion: 3,
                wegentTeamId: team.id,
                deviceId: CLOUD_DEVICE_ID,
                workspacePath,
                runtime,
                modelId: CLOUD_PUBLIC_MODEL_NAME,
                modelType: 'public',
                modelOptions: CLOUD_PUBLIC_MODEL_OPTIONS,
                message: turn.prompt,
                modelSelection,
              }
        )
      ).json()
      assert.equal(result.accepted, true, result.error)
      address ??= {
        deviceId: result.deviceId,
        taskId: result.taskId,
        workspacePath: result.workspacePath,
        runtimeHandle: result.runtimeHandle,
      }
      const started = Date.now()
      let settled = false
      while (Date.now() - started < 60_000) {
        const work = await (await request('runtime-work')).json()
        const workspace = [
          ...(work.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
          ...(work.chats ?? []),
        ].find(
          item => item.deviceId === address.deviceId && item.workspacePath === address.workspacePath
        )
        const task = workspace?.tasks.find(item => item.taskId === address.taskId)
        assert.ok(
          !['failed', 'cancelled'].includes(task?.status),
          `Skill task failed: ${task?.status}`
        )
        settled = Boolean(task && !task.running && task.status === 'done')
        if (completed && settled) break
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      assert.equal(completed, true, 'Real Claude did not finish the shared skill turn')
      assert.equal(settled, true, 'Shared skill task did not settle in its workspace')
      const transcript = await (await request('runtime-work/transcript', 'POST', address)).json()
      assert.ok(JSON.stringify(transcript).includes(turn.completion))
      if (!isCodex) {
        const probe = JSON.parse(await readFile(join(resultDir, 'claude-mcp-probe.json'), 'utf8'))
        assert.ok(turn.mcpOutput.includes(`MCP_CONTEXT:${probe.token}`))
      }
    }

    await runTurn('V1', 1)
    assert.equal(cloud.remoteExecutorEnv.WEGENT_WORKBENCH_HOME, undefined)
    const workbench = join(cloud.remoteExecutorEnv.HOME, '.wegent', 'workbench')
    await assert.rejects(lstat(join(cloud.remoteExecutorEnv.WEGENT_EXECUTOR_HOME, 'workbench')), {
      code: 'ENOENT',
    })
    const owners = await readdir(join(workbench, 'agents'))
    assert.equal(owners.length, 1)
    assert.equal(owners[0].startsWith('user-'), false)
    const home = join(workbench, 'agents', owners[0], 'default', TEAM)
    const mcpPath = join(home, 'mcp.json')
    let mcpFirst, mcpBefore, firstProbe, secondProbe
    const systemPath = join(home, 'skills', '.system')
    let systemBefore
    if (isCodex) {
      systemBefore = await stat(systemPath, { bigint: true })
      assert.ok(systemBefore.isDirectory())
      assert.ok((await readdir(systemPath)).includes('skill-creator'))
    } else {
      mcpFirst = await readFile(mcpPath, 'utf8')
      assert.ok(JSON.parse(mcpFirst).mcpServers[`${NAME}_retained-skill-mcp`])
      assert.ok(
        !mcpFirst.includes(cloud.authToken),
        'Task credentials leaked to persisted MCP config'
      )
      mcpBefore = await stat(mcpPath, { bigint: true })
      firstProbe = JSON.parse(await readFile(join(resultDir, 'claude-mcp-probe.json'), 'utf8'))
      assert.match(firstProbe.token, /^\d+$/)
    }
    const link = join(home, 'skills', NAME)
    const packagePath = skill =>
      join(workbench, 'shared', 'skills', skill.status.fileHash.replace('sha256:', ''))
    const assertLayout = async skill => {
      assert.equal((await lstat(join(home, 'skills'))).isSymbolicLink(), false)
      assert.equal((await lstat(link)).isSymbolicLink(), true)
      assert.equal(isAbsolute(await readlink(link)), false)
      assert.equal(await realpath(link), await realpath(packagePath(skill)))
      await assert.rejects(lstat(join(home, 'capability-snapshots')), { code: 'ENOENT' })
    }
    await assertLayout(first)
    const second = await upload('V2', skillId)
    await runTurn('V2', 2)
    if (isCodex) {
      assert.equal((await stat(systemPath, { bigint: true })).ino, systemBefore.ino)
    } else {
      secondProbe = JSON.parse(await readFile(join(resultDir, 'claude-mcp-probe.json'), 'utf8'))
      assert.notEqual(
        secondProbe.pid,
        firstProbe.pid,
        'Omitted skill MCP was not started on continuation'
      )
      assert.notEqual(secondProbe.token, firstProbe.token, 'MCP task context was not refreshed')
      assert.equal(await readFile(mcpPath, 'utf8'), mcpFirst)
    }
    await assertLayout(second)
    assert.ok(
      (await readFile(join(packagePath(first), 'SKILL.md'), 'utf8')).includes(
        'WEWORK_SHARED_SKILL_V1'
      )
    )
    const before = await stat(packagePath(second), { bigint: true })
    await runTurn('V2', 3)
    if (isCodex) {
      assert.equal((await stat(systemPath, { bigint: true })).ino, systemBefore.ino)
      assert.ok((await readdir(systemPath)).includes('skill-creator'))
    } else {
      const thirdProbe = JSON.parse(
        await readFile(join(resultDir, 'claude-mcp-probe.json'), 'utf8')
      )
      assert.notEqual(thirdProbe.token, secondProbe.token)
      const mcpAfter = await stat(mcpPath, { bigint: true })
      assert.equal(mcpAfter.ino, mcpBefore.ino)
      assert.equal(mcpAfter.mtimeNs, mcpBefore.mtimeNs)
      assert.ok(
        !(await readdir(join(home, 'runtime'))).some(name => name.startsWith('claude-mcp-'))
      )
    }
    const after = await stat(packagePath(second), { bigint: true })
    assert.equal(after.ino, before.ino)
    assert.equal(after.mtimeNs, before.mtimeNs)
    await writeFile(
      join(resultDir, isCodex ? 'codex-shared-skill-runtime.json' : 'shared-skill-runtime.json'),
      JSON.stringify(
        {
          home,
          sharedPackages: [packagePath(first), packagePath(second)],
          relativeLink: await readlink(link),
          taskId: address.taskId,
          turns: 3,
          metadataDiffersFromDownloadedZip: true,
          unchangedVersionReused: true,
          ...(isCodex
            ? { nativeSystemSkillsPreserved: true, systemSkillsPath: systemPath }
            : {
                stableMcpPath: mcpPath,
                omittedSkillMcpRetained: true,
                mcpContextRefreshed: true,
                unchangedMcpFileReused: true,
              }),
        },
        null,
        2
      )
    )
  }

  return { handleModel, verify }
}
