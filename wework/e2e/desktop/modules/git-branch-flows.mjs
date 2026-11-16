import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const button = '[data-testid="project-branch-button"]'
const menu = '[data-testid="project-branch-menu"]'
const list = '[data-testid="project-branch-list"]'
const search = '[data-testid="project-branch-search-input"]'
const option = '[data-testid="project-branch-option"]'

export async function verifyGitBranchFlows(control, workspacePath) {
  const git = async args => (await exec('git', args, { cwd: workspacePath })).stdout.trim()
  const originalBranch = await git(['symbolic-ref', '--short', 'HEAD'])
  const existingBranch = 'e2e/portable-existing'
  const createdBranch = 'e2e/portable-created'
  const excludedTag = 'e2e-tag-only'
  const excludedRemote = 'remote-only'
  await git(['branch', existingBranch])
  await git(['tag', excludedTag])
  await git(['update-ref', `refs/remotes/origin/${excludedRemote}`, 'HEAD'])

  const selectBranch = async (branch, expectedBranchCount) => {
    await control.command('clickWhenEnabled', button)
    await control.command('waitFor', list, { text: branch })
    assert.equal(
      Number(await control.command('getElementCount', option)),
      expectedBranchCount,
      'Only local branches may be selected, including while HEAD is detached'
    )
    await control.command('fill', search, { value: branch })
    await control.command('waitFor', option, { text: branch })
    await control.command('clickWhenEnabled', option)
    await control.command('waitFor', menu, { visible: false })
    await control.command('waitFor', button, { text: branch })
    assert.equal(await git(['symbolic-ref', '--short', 'HEAD']), branch)
  }

  await control.command('waitFor', button, { text: originalBranch })
  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', option, { text: existingBranch })
  const branches = await control.command('getText', list)
  assert.ok(branches.includes(originalBranch), 'The current local branch must be listed')
  assert.ok(!branches.includes(excludedTag), 'Tags must not appear as selectable branches')
  assert.ok(!branches.includes(excludedRemote), 'Remote refs must not appear as local branches')
  await control.command('press', search, { key: 'Escape' })
  await selectBranch(existingBranch, 2)

  await control.command('clickWhenEnabled', button)
  await control.command('waitFor', menu)
  await control.command('click', '[data-testid="project-open-new-branch-button"]')
  await control.command('fill', '[data-testid="project-new-branch-input"]', {
    value: createdBranch,
  })
  await control.command('clickWhenEnabled', '[data-testid="project-confirm-new-branch-button"]')
  await control.command('waitFor', button, { text: createdBranch })
  assert.equal(await git(['symbolic-ref', '--short', 'HEAD']), createdBranch)

  // The cached branch name must not bypass checkout after HEAD is detached.
  await git(['checkout', '--detach'])
  await selectBranch(createdBranch, 3)
  await selectBranch(originalBranch, 3)
  await git(['branch', '-d', existingBranch, createdBranch])
  await git(['tag', '-d', excludedTag])
  await git(['update-ref', '-d', `refs/remotes/origin/${excludedRemote}`])
}
