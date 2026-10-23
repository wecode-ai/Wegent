import { conversationTerminals } from '@/components/layout/backgroundTerminals'
import type { WorkbenchMessage } from '@/types/workbench'

export function collectBackgroundTerminalDiagnostics(
  messages: WorkbenchMessage[],
  taskId: string,
  marker: string,
  root: ParentNode = document
) {
  const terminals = conversationTerminals(messages, taskId)
    .filter(terminal => marker && terminal.command.includes(marker))
    .map(terminal => ({
      id: terminal.id,
      output: terminal.block.toolOutput,
      status: terminal.block.status,
      process: terminal.block.renderPayload,
    }))
  const rows = Array.from(
    terminals.length > 0
      ? root.querySelectorAll(
          '[data-testid="background-terminal-output-panel"] .xterm-accessibility-tree > [role="listitem"]'
        )
      : []
  ).map(row => ({
    position: row.getAttribute('aria-posinset'),
    size: row.getAttribute('aria-setsize'),
    text: row.textContent,
  }))
  return { marker, terminals, rows }
}
