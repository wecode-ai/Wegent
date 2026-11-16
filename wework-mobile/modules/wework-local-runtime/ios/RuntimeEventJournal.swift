import Foundation

final class RuntimeEventJournal {
  private var entries: [[String: Any]] = []
  private var url: URL?
  private var bytes = 0
  private(set) var sequence = 0

  func reset() {
    entries = []
    url = nil
    bytes = 0
  }

  func open(_ directory: URL) throws {
    url = directory.appendingPathComponent("events.jsonl")
    entries = []
    bytes = 0
    // Transcript persistence is owned by the executor. This bounded journal
    // bridges JS suspension within a native generation, not transcript recovery.
    try Data().write(to: url!, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  func append(_ event: [String: Any], generation: Int) throws -> [String: Any] {
    sequence += 1
    let entry: [String: Any] = ["sequence": sequence, "generation": generation, "event": event]
    var data = try JSONSerialization.data(withJSONObject: entry)
    data.append(10)
    if let url {
      let file = try FileHandle(forWritingTo: url)
      defer { try? file.close() }
      try file.seekToEnd()
      try file.write(contentsOf: data)
    }
    entries.append(entry)
    bytes += data.count
    if entries.count > 2048 || bytes > 8 * 1024 * 1024 {
      entries = Array(entries.suffix(512))
      var compacted = Data()
      for item in entries {
        compacted.append(try JSONSerialization.data(withJSONObject: item))
        compacted.append(10)
      }
      if let url {
        try compacted.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      }
      bytes = compacted.count
    }
    return entry
  }

  func read(after: Int) -> [String: Any] {
    let remaining = entries.filter { ($0["sequence"] as? Int ?? 0) > after }
    return ["events": Array(remaining.prefix(256)), "latestSequence": sequence,
            "hasMore": remaining.count > 256,
            "truncated": after > 0 && after < (entries.first?["sequence"] as? Int ?? 0) - 1]
  }
}
