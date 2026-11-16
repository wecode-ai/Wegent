import Foundation

@main
struct RuntimeWorkLeaseRevisionsTests {
  static func main() {
    staleRPCResponseCannotEndRenewedWork()
    delayedMainQueueEndCannotEndRenewedWork()
    preparationPersistsAcrossConcurrentSubmissions()
    generationCleanupCannotRemoveOtherGeneration()
    print("PASS native work lease RPC ordering, main-queue ordering, concurrent preparation, and generation isolation")
  }

  private static func staleRPCResponseCannotEndRenewedWork() {
    let supervisor = RuntimeWorkLeaseRevisions()
    let background = RuntimeWorkLeaseRevisions()
    let taskId = "same-conversation"

    // Reconciliation starts while the first turn still owns the lease.
    let first = supervisor.begin(taskId: taskId, generation: 1)
    background.adopt(taskId: taskId, token: first)
    supervisor.finishPreparation(taskId: taskId, token: first)
    let pendingResponse = supervisor.current(taskId: taskId)!

    // The next turn begins before the old task-state RPC returns idle.
    let second = supervisor.begin(taskId: taskId, generation: 1)
    background.adopt(taskId: taskId, token: second)
    supervisor.finishPreparation(taskId: taskId, token: second)
    precondition(first != second, "Each turn needs a distinct lease token")
    if supervisor.matches(taskId: taskId, token: pendingResponse) {
      supervisor.remove(taskId: taskId, matching: pendingResponse)
      background.remove(taskId: taskId, matching: pendingResponse)
    }
    precondition(supervisor.current(taskId: taskId) == second,
      "An old idle response must preserve the new supervisor lease")
    precondition(background.current(taskId: taskId) == second,
      "An old idle response must preserve the new background lease")
    precondition(!supervisor.remove(taskId: taskId, matching: first),
      "A stale token must not release a renewed lease")
  }

  private static func delayedMainQueueEndCannotEndRenewedWork() {
    let supervisor = RuntimeWorkLeaseRevisions()
    let background = RuntimeWorkLeaseRevisions()
    let taskId = "same-conversation"
    let first = supervisor.begin(taskId: taskId, generation: 1)
    background.adopt(taskId: taskId, token: first)
    supervisor.finishPreparation(taskId: taskId, token: first)

    // The RPC completes and queues an end operation on the main queue.
    precondition(supervisor.remove(taskId: taskId, matching: first))
    let pendingMainQueueEnd = first

    // Main handles the next turn's renewal before the delayed end operation.
    let second = supervisor.begin(taskId: taskId, generation: 1)
    background.adopt(taskId: taskId, token: second)
    supervisor.finishPreparation(taskId: taskId, token: second)
    precondition(!background.remove(taskId: taskId, matching: pendingMainQueueEnd),
      "Main must independently reject stale ends after renewal")
    precondition(background.current(taskId: taskId) == second)

    // The matching terminal result still releases both owners exactly once.
    precondition(supervisor.remove(taskId: taskId, matching: second))
    precondition(background.remove(taskId: taskId, matching: second))
    precondition(!background.remove(taskId: taskId, matching: second))
    precondition(supervisor.current(taskId: taskId) == nil)
    precondition(background.current(taskId: taskId) == nil)
  }

  private static func preparationPersistsAcrossConcurrentSubmissions() {
    let revisions = RuntimeWorkLeaseRevisions()
    let taskId = "same-conversation"
    let first = revisions.begin(taskId: taskId, generation: 1)
    let second = revisions.begin(taskId: taskId, generation: 1)
    precondition(revisions.isPrepared(taskId: taskId, token: first),
      "A new submission must not invalidate an earlier accepted preparation")
    precondition(revisions.isPrepared(taskId: taskId, token: second))
    precondition(revisions.hasPrepared(taskId: taskId))

    revisions.finishPreparation(taskId: taskId, token: second)
    precondition(revisions.hasPrepared(taskId: taskId),
      "The earlier submission must still prevent lease reconciliation")
    precondition(revisions.isPrepared(taskId: taskId, token: first))
    precondition(!revisions.isPrepared(taskId: taskId, token: second))
    revisions.finishPreparation(taskId: taskId, token: second)
    precondition(revisions.hasPrepared(taskId: taskId),
      "Repeated completion must not consume a different preparation")

    revisions.finishPreparation(taskId: taskId, token: first)
    precondition(!revisions.hasPrepared(taskId: taskId))
    precondition(revisions.current(taskId: taskId) == second,
      "Finishing preparation must preserve the active lease")
  }

  private static func generationCleanupCannotRemoveOtherGeneration() {
    let revisions = RuntimeWorkLeaseRevisions()
    let old = revisions.begin(taskId: "same-conversation", generation: 1)
    _ = revisions.begin(taskId: "old-generation-only", generation: 1)
    let current = revisions.begin(taskId: "same-conversation", generation: 2)

    revisions.clear(generation: 1)
    precondition(revisions.current(taskId: "old-generation-only") == nil)
    precondition(!revisions.hasPrepared(taskId: "old-generation-only"))
    precondition(revisions.current(taskId: "same-conversation") == current)
    precondition(!revisions.isPrepared(taskId: "same-conversation", token: old))
    precondition(revisions.isPrepared(taskId: "same-conversation", token: current))
    revisions.finishPreparation(taskId: "same-conversation", token: old)
    precondition(revisions.hasPrepared(taskId: "same-conversation"))
    revisions.finishPreparation(taskId: "same-conversation", token: current)
    precondition(!revisions.hasPrepared(taskId: "same-conversation"))
    precondition(!revisions.remove(taskId: "same-conversation", matching: old))
    precondition(revisions.remove(taskId: "same-conversation", matching: current))
  }
}
