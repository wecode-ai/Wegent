import type { ServerResponse } from 'http'

export interface PhaseChangingMessage {
  text: string
  completedText?: string
  startedPhase: 'final_answer' | 'commentary'
  completedPhase: 'final_answer' | 'commentary'
  doneDelayMs?: number
}

/** Stream an item whose completion changes phase, then hand it to the response finisher. */
export function writePhaseChangingMessage(
  res: ServerResponse,
  message: PhaseChangingMessage,
  complete: (item: Record<string, unknown>) => void
): void {
  const id = `msg_phase_${Date.now()}`
  const emit = (data: Record<string, unknown>) =>
    res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
  const item = {
    id,
    type: 'message',
    role: 'assistant',
    status: 'in_progress',
    phase: message.startedPhase,
    content: [],
  }
  emit({ type: 'response.output_item.added', output_index: 0, item })
  emit({
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: id,
    delta: message.text,
  })
  setTimeout(() => {
    const completed = {
      ...item,
      status: 'completed',
      phase: message.completedPhase,
      content: [
        { type: 'output_text', text: message.completedText ?? message.text, annotations: [] },
      ],
    }
    emit({ type: 'response.output_item.done', output_index: 0, item: completed })
    complete(completed)
  }, message.doneDelayMs ?? 0)
}
