import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const EMBEDDED_TERMINAL_SELECTOR = '[data-testid="embedded-local-terminal"]'
const BOTTOM_TERMINAL_TAB_SELECTOR = '[data-testid="bottom-workspace-terminal-tab"]'
const CENTRAL_HARNESS_SELECTOR = '[data-testid="central-harness-terminal"]'
const OPEN_CODE_ARGS_FILE = '.wework-opencode-e2e-args'
const CLAUDE_CODE_ARGS_FILE = '.wework-claude-code-e2e-args'
const CLAUDE_CODE_ENV_FILE = '.wework-claude-code-e2e-env'

async function createHarnessFixture({ executablePath, name, version, argsFile, envFile = null }) {
  await mkdir(dirname(executablePath), { recursive: true })
  await writeFile(
    executablePath,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '${version}\\n'
  exit 0
fi
args_file="$HOME/${argsFile}"
: > "$args_file"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$args_file"
done
${envFile ? `printf '%s\\n' "$WEWORK_HARNESS_E2E" > "$HOME/${envFile}"` : ''}
printf '\\033[2J\\033[H${name} E2E harness\\r\\n'
exec sleep 600
`
  )
  await chmod(executablePath, 0o755)
}

async function createHarnessFixtures(homePath) {
  const openCodeExecutable = join(homePath, '.wework-e2e-bin', 'opencode')
  const claudeCodeExecutable = join(homePath, '.wework-e2e-bin', 'claude')
  await Promise.all([
    createHarnessFixture({
      executablePath: openCodeExecutable,
      name: 'OpenCode',
      version: 'opencode-e2e 1.0.0',
      argsFile: OPEN_CODE_ARGS_FILE,
    }),
    createHarnessFixture({
      executablePath: claudeCodeExecutable,
      name: 'Claude Code',
      version: 'claude-code-e2e 2.0.0',
      argsFile: CLAUDE_CODE_ARGS_FILE,
      envFile: CLAUDE_CODE_ENV_FILE,
    }),
  ])
  return { openCodeExecutable, claudeCodeExecutable }
}

async function waitForFile(path, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastValue = null
  while (Date.now() < deadline) {
    try {
      lastValue = await readFile(path, 'utf8')
      if (lastValue === expected) return
    } catch {
      // The harness writes the evidence file immediately after launch.
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(lastValue, expected, `Unexpected harness evidence in ${path}`)
}

async function createLocalProject(control, workspacePath, timeoutMs) {
  await control.command('waitFor', '[data-testid="project-work-button"]', { timeoutMs })
  await control.command('click', '[data-testid="project-work-button"]')
  await control.command('click', '[data-testid="add-local-project-option"]')
  await control.command('waitFor', '[data-testid="device-folder-path-input"]', { timeoutMs })
  await control.command('fill', '[data-testid="device-folder-path-input"]', {
    value: workspacePath,
  })
  await control.command('press', '[data-testid="device-folder-path-input"]', { key: 'Enter' })
  await control.command('clickWhenEnabled', '[data-testid="confirm-device-folder-picker-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="local-project-create-dialog"]', { timeoutMs })
  await control.command('fill', '[data-testid="local-project-create-name-input"]', {
    value: 'local-terminal-e2e',
  })
  await control.command('clickWhenEnabled', '[data-testid="confirm-local-project-create-button"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="project-work-button"]', {
    text: 'local-terminal-e2e',
    timeoutMs,
  })
}

async function configureHarnesses(control, executables, timeoutMs) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('click', '[data-testid="settings-menu-button"]')
  await control.command('click', '[data-testid="settings-nav-harnesses"]')
  await control.command('waitFor', '[data-testid="harness-settings-page"]', { timeoutMs })
  await control.command('fill', '[data-testid="harness-executable-opencode"]', {
    value: executables.openCodeExecutable,
  })
  await control.command('fill', '[data-testid="harness-executable-claude_code"]', {
    value: executables.claudeCodeExecutable,
  })
  await control.command('select', '[data-testid="harness-permission-mode-claude_code"]', {
    value: 'plan',
  })
  await control.command('fill', '[data-testid="harness-args-claude_code"]', {
    value: '--verbose',
  })
  await control.command('fill', '[data-testid="harness-env-claude_code"]', {
    value: 'WEWORK_HARNESS_E2E=claude-settings',
  })
  await control.command('clickWhenEnabled', '[data-testid="save-harness-settings"]', {
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-opencode"]', {
    text: 'opencode-e2e 1.0.0',
    timeoutMs,
  })
  await control.command('waitFor', '[data-testid="harness-settings-claude_code"]', {
    text: 'claude-code-e2e 2.0.0',
    timeoutMs,
  })
  await control.command('click', '[data-testid="settings-back-button"]')
  await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', { timeoutMs })
}

async function startHarness(control, harnessId, prompt, timeoutMs) {
  await control.command('click', '[data-testid="workbench-harness-selector"]')
  await control.command(
    'clickWhenEnabled',
    `[data-testid="workbench-harness-option-${harnessId}"]`,
    { timeoutMs }
  )
  await control.command('fill', '[data-testid="chat-message-input"]', { value: prompt })
  await control.command('clickWhenEnabled', '[data-testid="send-message-button"]', { timeoutMs })
  await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, { timeoutMs })
}

export async function createDesktopScenario({
  captureScreenshot,
  homePath,
  uiTimeoutMs,
  workspacePath,
}) {
  const executables = await createHarnessFixtures(homePath)
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)

  return {
    async handleHttp() {
      return false
    },

    async verify(control) {
      await createLocalProject(control, workspacePath, uiTimeoutMs)

      await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
      await control.command('waitFor', EMBEDDED_TERMINAL_SELECTOR, { timeoutMs: uiTimeoutMs })
      await control.command('waitFor', BOTTOM_TERMINAL_TAB_SELECTOR, { timeoutMs: uiTimeoutMs })
      await capture(control, 'local-terminal-00-session-started.png')

      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        snapshot.testIds.includes('embedded-local-terminal'),
        'The embedded local terminal element was not rendered'
      )

      await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
      await control.command(
        'waitFor',
        '[data-testid="bottom-workspace-panel"][aria-hidden="true"]',
        {
          stableMs: 300,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('click', '[data-testid="toggle-bottom-workspace-panel-button"]')
      await control.command(
        'waitFor',
        '[data-testid="bottom-workspace-panel"][aria-hidden="false"]',
        {
          stableMs: 300,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command('waitFor', EMBEDDED_TERMINAL_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      await capture(control, 'local-terminal-01-session-restored.png')

      await control.command('click', '[data-testid="close-bottom-workspace-panel-button"]')
      await configureHarnesses(control, executables, uiTimeoutMs)
      await startHarness(control, 'opencode', 'Inspect the current project', uiTimeoutMs)
      await control.command(
        'waitFor',
        '[data-testid^="local-harness-session-row-local-terminal-"]',
        { timeoutMs: uiTimeoutMs }
      )
      await capture(control, 'local-terminal-02-central-opencode.png')

      const harnessSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      assert.ok(
        harnessSnapshot.testIds.includes('central-harness-terminal'),
        'OpenCode did not replace the central message area'
      )
      assert.ok(
        !harnessSnapshot.testIds.includes('desktop-empty-composer-frame'),
        'The empty message area remained visible behind OpenCode'
      )
      await waitForFile(
        join(homePath, OPEN_CODE_ARGS_FILE),
        '--prompt\nInspect the current project\n',
        uiTimeoutMs
      )

      await control.command('click', '[data-testid="new-chat-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid^="local-harness-session-row-local-terminal-"]')
      await control.command('waitFor', CENTRAL_HARNESS_SELECTOR, {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="central-harness-close-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
      await startHarness(control, 'claude_code', 'Review the current project', uiTimeoutMs)
      await capture(control, 'local-terminal-03-central-claude-code.png')
      await waitForFile(
        join(homePath, CLAUDE_CODE_ARGS_FILE),
        '--permission-mode\nplan\n--verbose\nReview the current project\n',
        uiTimeoutMs
      )
      await waitForFile(join(homePath, CLAUDE_CODE_ENV_FILE), 'claude-settings\n', uiTimeoutMs)
      await control.command('click', '[data-testid="central-harness-close-button"]')
      await control.command('waitFor', '[data-testid="desktop-empty-composer-frame"]', {
        timeoutMs: uiTimeoutMs,
      })
    },

    diagnostics() {
      return {
        openCodeArgsFile: join(homePath, OPEN_CODE_ARGS_FILE),
        claudeCodeArgsFile: join(homePath, CLAUDE_CODE_ARGS_FILE),
        claudeCodeEnvFile: join(homePath, CLAUDE_CODE_ENV_FILE),
      }
    },
  }
}
