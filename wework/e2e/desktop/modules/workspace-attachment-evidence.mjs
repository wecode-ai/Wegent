import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { findRuntimeWorkTask } from './runtime-task-evidence.mjs'

export function findOwnedRuntimeProject(runtimeWork, deviceId, workspacePath) {
  const matches = (runtimeWork.projects ?? []).flatMap(projectWork =>
    (projectWork.deviceWorkspaces ?? [])
      .filter(
        workspace =>
          workspace.deviceId === deviceId &&
          workspace.workspacePath.replace(/\/+$/, '') === workspacePath.replace(/\/+$/, '')
      )
      .map(workspace => ({ projectWork, workspace }))
  )
  assert.equal(
    matches.length,
    1,
    `Expected one owning cloud project for ${deviceId}:${workspacePath}`
  )
  assert.ok(matches[0].projectWork.project.key, 'The owning cloud project has no source key')
  return matches[0]
}

export function findOwnedRuntimeTask(runtimeWork, deviceId, taskId) {
  const workspaces = [
    ...(runtimeWork.projects ?? []).flatMap(project => project.deviceWorkspaces ?? []),
    ...(runtimeWork.chats ?? []),
  ]
  const owningWorkspaces = workspaces.filter(workspace => workspace.deviceId === deviceId)
  const task = findRuntimeWorkTask({ workspaces: owningWorkspaces }, taskId)
  if (task) {
    return {
      task,
      workspace: owningWorkspaces.find(workspace => workspace.tasks.includes(task)),
    }
  }
  const otherOwner = workspaces.find(workspace =>
    workspace.tasks?.some(task => task.taskId === taskId)
  )
  assert.ok(!otherOwner, `Task ${taskId} belongs to the wrong device: ${otherOwner?.deviceId}`)
  return undefined
}

export function assertCloudAttachmentProjectSelection(
  selection,
  { projectUiId, deviceId, workspacePath }
) {
  const project = selection?.currentProject
  assert.equal(String(project?.id), String(projectUiId), 'The cloud project UI identity changed')
  assert.equal(project.config?.execution?.deviceId, deviceId, 'The cloud execution device changed')
  assert.equal(
    project.config?.workspace?.localPath?.replace(/\/+$/, ''),
    workspacePath.replace(/\/+$/, ''),
    'The cloud project workspace changed'
  )
  assert.equal(selection.currentRuntimeTask, null, 'The cloud composer retained an existing task')
}

export async function assertRuntimeTaskAttachments({ root, taskIds, filename, expectedBytes }) {
  assert.equal(new Set(taskIds).size, taskIds.length, 'Conversations must have different task IDs')
  const paths = []
  for (const taskId of taskIds) {
    assert.match(taskId, /^[\w-]+$/, 'Runtime task ID must be a safe directory segment')
    const directory = join(root, taskId, 'attachments')
    const files = await findAttachmentFiles(directory, filename)
    assert.equal(files.length, 1, `Task ${taskId} has a missing attachment or duplicate files`)
    assert.deepEqual(
      await readFile(files[0]),
      expectedBytes,
      `Task ${taskId} has different image bytes`
    )
    paths.push(files[0])
  }
  return paths
}

async function findAttachmentFiles(directory, filename) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  return (
    await Promise.all(
      entries.map(entry => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return findAttachmentFiles(path, filename)
        return entry.isFile() && entry.name === filename ? [path] : []
      })
    )
  ).flat()
}
