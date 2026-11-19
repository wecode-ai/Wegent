import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

/** The visible conclusion review owns its publication completion and parent view signal. */
export function createPrivateDiscussionView(identity: string) {
  let snapshot = { identity, open: false, generation: 0 }
  const observers = new Set<{ notify(): void; onChange?(open: boolean): void }>()
  let reported = false
  const report = () => {
    logRuntimeTaskCreateStage(
      'collaboration-exp-preview-commit',
      { showConclusion: snapshot.open },
      'debug'
    )
    observers.forEach(observer => observer.onChange?.(snapshot.open))
    reported = true
  }
  const setOpen = (open: boolean) => {
    if (!observers.size || snapshot.open === open) return
    snapshot = { ...snapshot, open, generation: snapshot.generation + 1 }
    observers.forEach(observer => observer.notify())
    report()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void, onChange?: (open: boolean) => void) {
      const observer = { notify, onChange }
      observers.add(observer)
      if (!reported) report()
      return () => {
        observers.delete(observer)
        queueMicrotask(() => {
          if (observers.size) return
          snapshot = { ...snapshot, generation: snapshot.generation + 1 }
          reported = false
          observer.onChange?.(false)
        })
      }
    },
    setOpen,
    async publishConclusion(
      publish: () => Promise<boolean>,
      getResult: () => { publishing: boolean; error: unknown }
    ) {
      if (!snapshot.open || !observers.size) return
      const generation = snapshot.generation
      const published = await publish()
      if (!published || !observers.size || snapshot.generation !== generation) return
      const result = getResult()
      if (!result.publishing && !result.error) setOpen(false)
    },
  }
}
