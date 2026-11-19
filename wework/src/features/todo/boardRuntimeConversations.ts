import type { ExecutorRuntimeClient } from '@/api/executorAccess'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  getRuntimeConversationTurns,
  reconcileRuntimeConversationSnapshot,
  replaceRuntimeConversationSnapshot,
  runtimeConversationKey,
} from '@/features/workbench/runtimeConversationCache'
import {
  isRuntimePaneTranscriptConfirmedIdle,
  projectRuntimePaneTranscript,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import { boardRuntimeReadKey } from './boardRuntimeReadKey'

export interface BoardTranscriptRead {
  address: RuntimeTaskAddress
  signature: string
  includeFullContent: boolean
}
type TranscriptReader = ExecutorRuntimeClient['getRuntimeTranscript']
interface ReadOwner {
  reads: BoardTranscriptRead[]
  read: TranscriptReader | undefined
}

/** One card shares preload attempts while each summary observes its own live turns. */
export class BoardRuntimeConversations {
  private owners = new Set<ReadOwner>()
  private attempted = new Map<string, { read: TranscriptReader; signature: string }>()
  private requested = new Map<string, number>()
  private applied = new Map<string, number>()

  observe(reads: BoardTranscriptRead[], read: TranscriptReader | undefined): () => void {
    const owner = { reads, read }
    this.owners.add(owner)
    if (read) {
      const seen = new Set<string>()
      for (const request of reads) {
        const key = runtimeConversationKey(request.address)
        if (seen.has(key)) continue
        seen.add(key)
        this.load(request, read, key)
      }
    }
    return () => this.owners.delete(owner)
  }

  private hasReader(address: RuntimeTaskAddress, read: TranscriptReader): boolean {
    const scope = boardRuntimeReadKey(address)
    return [...this.owners].some(
      owner =>
        owner.read === read &&
        owner.reads.some(request => boardRuntimeReadKey(request.address) === scope)
    )
  }

  private load(request: BoardTranscriptRead, read: TranscriptReader, key: string): void {
    const previous = this.attempted.get(key)
    if (previous?.read === read && previous.signature === request.signature) return
    const attempt = { read, signature: request.signature }
    this.attempted.set(key, attempt)
    const sequence = (this.requested.get(key) ?? 0) + 1
    this.requested.set(key, sequence)
    const { address, includeFullContent } = request
    const turnsBeforeRead = getRuntimeConversationTurns(address)
    const isObserved = () => {
      if (this.hasReader(address, read)) return true
      // A detached pending read was never delivered; a future observer may request it again.
      if (this.attempted.get(key) === attempt) this.attempted.delete(key)
      return false
    }
    void read({ ...address, limit: 20, includeFullContent })
      .then(response => {
        if (!isObserved() || sequence < (this.applied.get(key) ?? 0)) return
        this.applied.set(key, sequence)
        const transcript = projectRuntimePaneTranscript(response)
        if (transcript.fullContent === true && isRuntimePaneTranscriptConfirmedIdle(transcript)) {
          // A board read must not retract progress published while it was pending.
          if (getRuntimeConversationTurns(address) !== turnsBeforeRead) return
          replaceRuntimeConversationSnapshot(address, transcript.turns)
        } else {
          reconcileRuntimeConversationSnapshot(address, transcript.turns)
        }
      })
      .catch(error => {
        if (!isObserved()) return
        console.warn('[Wework project board] failed to preload task conversation', {
          address,
          error,
        })
      })
  }
}
