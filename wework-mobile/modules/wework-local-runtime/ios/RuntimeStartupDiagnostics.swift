import Foundation

/// Retains only a bounded line prefix and emits fixed codes, never diagnostic fields.
struct RuntimeStartupDiagnostics {
  private static let stages: [(String, String)] = [
    ("codex router model catalog prepared", "catalog_ready"),
    ("codex router upstream model catalog unavailable", "catalog_upstream_unavailable"),
    ("codex shared app-server process starting", "codex_starting"),
    ("codex shared app-server process initialized", "codex_ready"),
    ("codex shared app-server process initialization failed", "codex_start_failed"),
    ("runtime work notification router subscribe failed", "notification_subscribe_failed"),
    ("runtime work thread list fetched", "threads_read"),
    ("runtime work thread list failed", "threads_read_failed"),
    ("runtime work thread list malformed", "threads_invalid"),
    ("runtime work list finished", "list_ready"),
  ]
  private var prefix = Data()
  private let capacity = 128

  mutating func consume(_ chunk: Data, onStage: (String) -> Void) {
    var start = chunk.startIndex
    while start < chunk.endIndex {
      let newline = chunk[start...].firstIndex(of: 10)
      let end = newline ?? chunk.endIndex
      prefix.append(contentsOf: chunk[start..<end].prefix(capacity - prefix.count))
      guard let newline else { return }
      if let stage = stage() { onStage(stage) }
      prefix.removeAll(keepingCapacity: true)
      start = chunk.index(after: newline)
    }
  }

  private func stage() -> String? {
    // The executor formatter prefixes events with a 19-byte timestamp and a space.
    let line = String(decoding: prefix, as: UTF8.self)
    let event = line.dropFirst(20)
    guard line.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} ",
                     options: .regularExpression) != nil else { return nil }
    if event.hasPrefix("codex shared app-server stop ") {
      let fields = event.split(separator: " ")
      for stage in ["started", "reader_stopped", "exit_notified", "child_terminated"] {
        if fields.contains(Substring("stage=\(stage)")) { return "codex_stop_\(stage)" }
      }
      return nil
    }
    return Self.stages.first(where: { event == $0.0 || event.hasPrefix($0.0 + " ") })?.1
  }
}
