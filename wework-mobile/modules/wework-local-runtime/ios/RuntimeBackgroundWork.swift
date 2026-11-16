import Foundation
import UIKit

final class RuntimeBackgroundWork {
  private final class Lease {
    var identifier: UIBackgroundTaskIdentifier = .invalid
    let generation: Int
    init(generation: Int) { self.generation = generation }
  }
  private var leases: [String: Lease] = [:]
  private let revisions = RuntimeWorkLeaseRevisions()
  var changed: (String, Int) -> Void = { _, _ in }
  var expired: (String, Int) -> Void = { _, _ in }

  func begin(taskId: String, title: String, generation: Int, revision: Int) {
    dispatchPrecondition(condition: .onQueue(.main))
    let token = RuntimeWorkLeaseToken(generation: generation, revision: revision)
    if let lease = leases[taskId] {
      if lease.generation == generation {
        revisions.adopt(taskId: taskId, token: token)
        return
      }
      leases.removeValue(forKey: taskId)
      if let previous = revisions.current(taskId: taskId) { revisions.remove(taskId: taskId, matching: previous) }
      UIApplication.shared.endBackgroundTask(lease.identifier)
    }
    let lease = Lease(generation: generation)
    let identifier = UIApplication.shared.beginBackgroundTask(withName: title) { [weak self] in
      guard let self, self.leases[taskId] === lease else { return }
      self.leases.removeValue(forKey: taskId)
      if let current = self.revisions.current(taskId: taskId) {
        self.revisions.remove(taskId: taskId, matching: current)
      }
      UIApplication.shared.endBackgroundTask(lease.identifier)
      self.changed("expired", generation)
      // Losing background time never revokes normal foreground execution.
      if UIApplication.shared.applicationState == .background {
        self.expired(taskId, generation)
      }
    }
    guard identifier != .invalid else { changed("unavailable", generation); return }
    lease.identifier = identifier
    leases[taskId] = lease
    revisions.adopt(taskId: taskId, token: token)
    changed("active", generation)
  }

  func end(taskId: String, generation: Int, revision: Int) {
    dispatchPrecondition(condition: .onQueue(.main))
    let token = RuntimeWorkLeaseToken(generation: generation, revision: revision)
    guard let lease = leases[taskId], lease.generation == generation,
          revisions.remove(taskId: taskId, matching: token) else { return }
    leases.removeValue(forKey: taskId)
    UIApplication.shared.endBackgroundTask(lease.identifier)
    changed(leases.isEmpty ? "completed" : "active", generation)
  }

  func endAll(generation: Int) {
    for id in Array(leases.keys) {
      if let token = revisions.current(taskId: id) {
        end(taskId: id, generation: generation, revision: token.revision)
      }
    }
  }
}
