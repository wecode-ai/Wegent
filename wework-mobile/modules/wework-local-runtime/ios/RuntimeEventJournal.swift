import Foundation

final class RuntimeEventJournal {
  private struct Entry {
    let frame: [String: Any]
    let bytes: Int
  }
  private var entries: [Entry] = []
  private var bytes = 0
  private let maximumEntries: Int
  private let maximumBytes: Int
  private(set) var sequence = 0

  init(maximumEntries: Int = 2048, maximumBytes: Int = 8 * 1024 * 1024) {
    precondition(maximumEntries > 0 && maximumBytes > 0)
    self.maximumEntries = maximumEntries
    self.maximumBytes = maximumBytes
  }

  func reset() {
    entries = []
    bytes = 0
  }

  func append(_ event: [String: Any], generation: Int) throws -> [String: Any] {
    let entry: [String: Any] = ["sequence": sequence + 1, "generation": generation, "event": event]
    let size = try JSONSerialization.data(withJSONObject: entry).count
    sequence += 1
    entries.append(Entry(frame: entry, bytes: size))
    bytes += size
    while entries.count > maximumEntries || bytes > maximumBytes {
      bytes -= entries.removeFirst().bytes
    }
    // Oversized events are still delivered live. Replay reports the gap, and the
    // normal recovery notification reloads the executor-owned transcript.
    return entry
  }

  func read(after: Int) -> [String: Any] {
    let remaining = entries.map(\.frame).filter { ($0["sequence"] as? Int ?? 0) > after }
    let first = entries.first?.frame["sequence"] as? Int ?? sequence + 1
    return ["events": Array(remaining.prefix(256)), "latestSequence": sequence,
            "hasMore": remaining.count > 256,
            "truncated": after < first - 1]
  }
}
