export function encodeSseEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export function sse(events) {
  return events.map(encodeSseEvent).join('')
}

export async function writeSseEvents(response, events) {
  for (const event of events) {
    response.write(encodeSseEvent(event))
    response.flush?.()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
