import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import {
  createSourceFile,
  isCallExpression,
  isVariableStatement,
  ScriptTarget,
  transpileModule,
} from 'typescript'
import { expect, test, vi } from 'vitest'

function presentationHandler(context: Record<string, unknown>): (source: string) => Promise<void> {
  // Execute the production callback without launching the Electron main process.
  const source = createSourceFile(
    'main.ts',
    readFileSync(new URL('../main.ts', import.meta.url), 'utf8'),
    ScriptTarget.Latest,
    true
  )
  const initializer = source.statements
    .filter(isVariableStatement)
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => declaration.name.getText(source) === 'presentStartupWindow')?.initializer
  if (!initializer || !isCallExpression(initializer)) {
    throw new Error('The production startup presentation callback is missing')
  }
  const callback = initializer.arguments[0]
  const { outputText } = transpileModule(`(${callback.getText(source)})`, {
    compilerOptions: { target: ScriptTarget.ES2023 },
  })
  return runInNewContext(outputText, context)
}

test.each(['ready', 'quitting', 'destroyed', 'failed'] as const)(
  'rechecks the %s lifecycle after closing the splash on failed handoff',
  async state => {
    let releaseClose!: () => void
    let closeStarted!: () => void
    const closing = new Promise<void>(resolve => {
      closeStarted = resolve
    })
    const closed = new Promise<void>(resolve => {
      releaseClose = resolve
    })
    const window = {
      isDestroyed: vi.fn(() => false),
      setOpacity: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { focus: vi.fn() },
    }
    const start = vi.fn()
    const context = {
      mainWindow: window,
      quitting: false,
      lastStartupFailure: null as { message: string } | null,
      logStartupStep: vi.fn(),
      holdStartupSplashForDesktopE2e: async () => {},
      startupSplash: {
        handoff: vi.fn().mockRejectedValue(new Error('Animation failed')),
        close: vi.fn(async () => {
          closeStarted()
          await closed
        }),
      },
      startupSplashWindow: {},
      startupProgress: { complete: vi.fn() },
      mainWindowState: { start },
      keepE2EWindowInBackground: false,
      console: { warn: vi.fn() },
      process: { env: {} },
    }
    const pending = presentationHandler(context)('document-loaded')
    await closing
    if (state === 'quitting') context.quitting = true
    if (state === 'destroyed') window.isDestroyed.mockReturnValue(true)
    if (state === 'failed') context.lastStartupFailure = { message: 'Startup failed' }
    releaseClose()
    await pending
    const expected = state === 'ready' ? 1 : 0
    expect(start).toHaveBeenCalledTimes(expected)
    expect(window.focus).toHaveBeenCalledTimes(expected)
    expect(window.webContents.focus).toHaveBeenCalledTimes(expected)
  }
)
