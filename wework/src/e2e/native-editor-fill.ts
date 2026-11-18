import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import { getPlatform } from '@/lib/platform'
import { sendNativeKeyAndWait } from './native-key-acknowledgement'

function createFillTrace(commandId: string | undefined, windowLabel: string) {
  const fillId = commandId ?? crypto.randomUUID()
  const startedAt = performance.now()
  const trace = (stage: string, line?: number) => {
    console.info(
      `[desktop-e2e-key] ${JSON.stringify({
        action: 'fill',
        fillId,
        windowLabel,
        stage,
        line,
        at: new Date().toISOString(),
        elapsedMs: performance.now() - startedAt,
      })}`
    )
  }
  return {
    trace,
    async measure<T>(stage: string, operation: () => Promise<T>, line?: number): Promise<T> {
      trace(`${stage}-started`, line)
      try {
        const result = await operation()
        trace(`${stage}-completed`, line)
        return result
      } catch (error) {
        trace(`${stage}-failed`, line)
        throw error
      }
    },
  }
}

export async function fillNativeEditor(
  element: HTMLElement,
  value: string,
  waitForRender: () => Promise<void>,
  commandId?: string
) {
  const windowLabel = getDesktopWindowLabel()
  const { trace, measure } = createFillTrace(commandId, windowLabel)
  await measure('focus', () =>
    invokeDesktopHost(windowLabel === 'main' ? 'e2e.focusMainWindow' : 'e2e.focusWindow', {
      windowLabel,
    })
  )
  element.focus()
  const pressKey = (key: string, stage: string, line?: number) =>
    measure(
      stage,
      () =>
        sendNativeKeyAndWait(
          element,
          'press',
          () =>
            invokeDesktopHost('e2e.pressKey', { windowLabel, key, phase: 'press', focus: false }),
          1,
          event => trace(`${stage}-${event}`, line)
        ),
      line
    )
  // Native editors own their selection state as well as the rendered DOM.
  await pressKey(`${getPlatform() === 'mac' ? 'Meta' : 'Control'}+A`, 'select-all')
  if (!value) {
    await pressKey('Backspace', 'clear')
    return
  }
  const text = value.replace(/\r\n?/g, '\n')
  const lineBreaks = text.split('\n').length - 1
  const insert = () => invokeDesktopHost('e2e.insertText', { windowLabel, text })
  await measure('insert-text', () =>
    lineBreaks ? sendNativeKeyAndWait(element, 'press', insert, lineBreaks) : insert()
  )
  await measure('render-wait', waitForRender)
}
