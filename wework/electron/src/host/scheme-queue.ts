export class SchemeQueue {
  private nextId = 0
  private requests = new Map<number, string>()

  enqueue(url: string): boolean {
    if (!url.startsWith('wework://') || url.length > 2048) return false
    this.requests.set(++this.nextId, url)
    return true
  }

  read(): Array<{ id: number; url: string }> {
    return [...this.requests].map(([id, url]) => ({ id, url }))
  }

  acknowledge(id: number): void {
    this.requests.delete(id)
  }
}
