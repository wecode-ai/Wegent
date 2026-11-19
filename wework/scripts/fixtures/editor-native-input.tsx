import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDescriptionEditor } from '../../src/features/todo/TaskDescriptionEditor'
import { sendNativeKeyAndWait } from '../../src/e2e/native-key-acknowledgement'

declare global {
  interface Window {
    insertNativeText: (text: string) => Promise<unknown>
    resetEditor: () => void
    editorReady: () => Promise<void>
    editorTick: () => Promise<void>
    editorSnapshot: () => { value: string; text: string | null; blocks: number }
    insertEditorBatch: (text: string) => Promise<void>
  }
}

let markdown = 'seed'
const editor = () => document.querySelector<HTMLElement>('[data-testid="native-description"]')!
window.editorTick = () => new Promise(resolve => setTimeout(resolve, 16))
window.editorReady = async () => {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (typeof window.resetEditor === 'function' && editor()?.textContent === 'seed') return
    await window.editorTick()
  }
  throw new Error('Native editor did not initialize')
}
window.editorSnapshot = () => ({
  value: markdown,
  text: editor().textContent,
  blocks: editor().querySelectorAll('[data-content-type]').length,
})
window.insertEditorBatch = async text => {
  const count = text.replace(/\r\n?/g, '\n').split('\n').length - 1
  const insert = () => window.insertNativeText(text)
  if (count) await sendNativeKeyAndWait(editor(), 'press', insert, count)
  else await insert()
  await window.editorTick()
}

export function Fixture() {
  const [value, setValue] = useState('seed')
  return (
    <div
      ref={element => {
        if (!element) return
        window.resetEditor = () => {
          markdown = 'seed'
          setValue('seed')
        }
      }}
    >
      <TaskDescriptionEditor
        testId="native-description"
        value={value}
        onChange={next => {
          markdown = next
          setValue(next)
        }}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
