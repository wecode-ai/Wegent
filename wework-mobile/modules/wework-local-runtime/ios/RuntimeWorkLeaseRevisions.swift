struct RuntimeWorkLeaseToken: Hashable {
  let generation: Int
  let revision: Int
}

// Confined to the owning queue. The supervisor and main-thread background owner
// each retain the latest token, so stale work cannot release a renewed lease.
final class RuntimeWorkLeaseRevisions {
  private var nextRevision = 0
  private var tokens: [String: RuntimeWorkLeaseToken] = [:]
  private var prepared: [String: Set<RuntimeWorkLeaseToken>] = [:]

  func begin(taskId: String, generation: Int) -> RuntimeWorkLeaseToken {
    nextRevision += 1
    let token = RuntimeWorkLeaseToken(generation: generation, revision: nextRevision)
    adopt(taskId: taskId, token: token)
    prepared[taskId, default: []].insert(token)
    return token
  }

  func isPrepared(taskId: String, token: RuntimeWorkLeaseToken) -> Bool {
    prepared[taskId]?.contains(token) == true
  }
  func hasPrepared(taskId: String) -> Bool { prepared[taskId]?.isEmpty == false }
  func finishPreparation(taskId: String, token: RuntimeWorkLeaseToken) {
    prepared[taskId]?.remove(token)
    if prepared[taskId]?.isEmpty == true { prepared.removeValue(forKey: taskId) }
  }

  func adopt(taskId: String, token: RuntimeWorkLeaseToken) { tokens[taskId] = token }
  func current(taskId: String) -> RuntimeWorkLeaseToken? { tokens[taskId] }
  func matches(taskId: String, token: RuntimeWorkLeaseToken) -> Bool { tokens[taskId] == token }

  @discardableResult
  func remove(taskId: String, matching token: RuntimeWorkLeaseToken) -> Bool {
    guard matches(taskId: taskId, token: token) else { return false }
    tokens.removeValue(forKey: taskId)
    return true
  }

  func clear(generation: Int) {
    tokens = tokens.filter { $0.value.generation != generation }
    prepared = prepared.mapValues { $0.filter { $0.generation != generation } }
      .filter { !$0.value.isEmpty }
  }
}
