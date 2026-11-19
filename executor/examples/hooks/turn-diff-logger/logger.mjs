import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { repository, remoteUrl, snapshot, pin, unpin, withLock } from './git.mjs'
import { digest, optionalJson, writeJson } from './storage.mjs'
import { startWorker } from './worker.mjs'

function validate(input) {
  if (
    input?.schema_version !== 1 ||
    !Number.isSafeInteger(input.emitted_at_ms) ||
    input.emitted_at_ms < 0 ||
    !['TurnStarted', 'TurnCompleted', 'ExecutionCompleted'].includes(input?.hook_event_name) ||
    !['event_id', 'execution_id', 'cwd', 'status'].every(
      key => typeof input[key] === 'string' && input[key]
    ) ||
    !isAbsolute(input.cwd) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0
  ) {
    throw new Error(
      'Expected lifecycle metadata with execution_id, event_id, sequence and absolute cwd'
    )
  }
}

async function canonicalDestination(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = resolve(path, '..')
    if (parent === path) throw error
    return join(await canonicalDestination(parent), relative(parent, path))
  }
}

async function prepareQueue(workspace, config) {
  const requested = config?.logDirectory
  if (typeof requested !== 'string' || !requested.trim())
    throw new Error('config.json requires logDirectory')
  const expanded =
    requested.startsWith('~/') || requested.startsWith('~' + sep)
      ? join(homedir(), requested.slice(2))
      : requested
  if (!isAbsolute(expanded)) throw new Error('logDirectory must be absolute or begin with ~/')
  const destination = await canonicalDestination(resolve(expanded))
  const inside = relative(workspace, destination)
  if (!inside || (!inside.startsWith('..' + sep) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('logDirectory must be outside the Git workspace')
  }
  const root = join(destination, 'queues', digest(workspace))
  for (const path of [
    root,
    join(root, 'executions'),
    join(root, 'pending'),
    join(root, 'empty-hooks'),
    join(destination, 'records'),
  ]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  await writeJson(join(root, 'workspace.json'), {
    workspace,
    records: join(destination, 'records'),
  })
  return root
}

async function enqueue(root, directory, state, input) {
  if (state.closed) throw new Error('Execution baseline is closed')
  if (input.sequence <= state.sequence) {
    if (state.event_id === input.event_id) return state
    throw new Error('Out-of-order lifecycle event')
  }
  const hooks = join(root, 'empty-hooks')
  const after = await snapshot(state.workspace, directory, hooks)
  const git_url = await remoteUrl(state.workspace, hooks)
  // Hash the event identity once to keep Windows ref lock paths short.
  const prefix =
    'refs/wegent/turn-diff/event-' + digest(JSON.stringify([state.reference, input.event_id]))
  // Refs outside heads protect immutable trees without changing the user's index.
  const references = [prefix + '-before', prefix + '-after']
  const job = {
    input,
    workspace: state.workspace,
    before: state.tree,
    after,
    git_url,
    references,
    captured_at: new Date().toISOString(),
  }
  // Publish the complete job before advancing the baseline. A crash can merge
  // or repeat a later increment but cannot turn a queued job into a partial patch.
  const pending = join(root, 'pending', digest(input.event_id) + '.json')
  try {
    await pin(state.workspace, references[0], state.tree, hooks)
    await pin(state.workspace, references[1], after, hooks)
    await writeJson(pending, job)
  } catch (error) {
    // A directory-sync error can follow a successful rename. Published jobs
    // still own their refs even when publication did not return successfully.
    if (!(await optionalJson(pending)))
      for (const reference of references) await unpin(state.workspace, reference, hooks)
    throw error
  }
  await pin(state.workspace, state.reference, after, hooks)
  const next = {
    ...state,
    tree: after,
    sequence: input.sequence,
    event_id: input.event_id,
  }
  await writeJson(join(directory, 'state.json'), next)
  return next
}

export async function handleEvent(input, config, { launchWorker = startWorker } = {}) {
  validate(input)
  if (input.is_test) return { tested: true }
  const found = await repository(input.cwd)
  if (!found) return { recorded: false, reason: 'not_a_git_workspace' }
  const workspace = await realpath(found)
  const root = await prepareQueue(workspace, config)
  const execution = digest(input.execution_id)
  const directory = join(root, 'executions', execution)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const hooks = join(root, 'empty-hooks')
  const reference = 'refs/wegent/turn-diff/' + digest(root) + '/' + execution
  await withLock(workspace, reference + '-capture-lock', hooks, async () => {
    let state = await optionalJson(join(directory, 'state.json'))
    if (input.hook_event_name === 'TurnStarted') {
      if (state) {
        if (state.start_event_id !== input.event_id) throw new Error('Conflicting baseline')
        return
      }
      const tree = await snapshot(workspace, directory, hooks)
      await pin(workspace, reference, tree, hooks)
      await writeJson(join(directory, 'state.json'), {
        workspace,
        reference,
        tree,
        sequence: input.sequence,
        event_id: input.event_id,
        start_event_id: input.event_id,
        closed: false,
      })
    } else {
      if (!state) throw new Error('TurnStarted baseline is missing')
      if (input.hook_event_name === 'ExecutionCompleted') {
        if (state.closed) {
          await unpin(workspace, reference, hooks)
          return
        }
        if (input.sequence > state.sequence + 1)
          state = await enqueue(root, directory, state, input)
        await writeJson(join(directory, 'state.json'), {
          ...state,
          closed: true,
        })
        await unpin(workspace, reference, hooks)
      } else {
        await enqueue(root, directory, state, input)
      }
    }
  })
  await launchWorker(root)
  return { accepted: true, event_id: input.event_id, queue_path: root }
}
