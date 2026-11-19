import Foundation

@main
struct RuntimeStartupDiagnosticsTests {
  static func main() {
    let known = "2026-11-15 22:29:00 codex shared app-server process starting process_id=19\n"
    for split in 0...known.utf8.count {
      let data = Data(known.utf8)
      var parser = RuntimeStartupDiagnostics()
      var stages: [String] = []
      parser.consume(data.prefix(split)) { stages.append($0) }
      parser.consume(data.dropFirst(split)) { stages.append($0) }
      precondition(stages == ["codex_starting"])
    }

    var parser = RuntimeStartupDiagnostics()
    var stages: [String] = []
    let input = """
    2026-11-15 22:29:00 unknown event token=private-secret
    arbitrary codex shared app-server process starting
    2026-11-15 22:29:00 runtime work list finished_fake message=private-body
    2026-11-15 22:29:00 runtime work thread list failed error="private-secret"
    2026-11-15 22:29:00 runtime work list finished tasks=3

    """
    parser.consume(Data(input.utf8)) { stages.append($0) }
    precondition(stages == ["threads_read_failed", "list_ready"])
    stages.removeAll()
    parser.consume(Data(("2026-11-15 22:29:00 runtime work thread list failed error=" +
                         String(repeating: "私密", count: 200) + "\n").utf8)) { stages.append($0) }
    precondition(stages == ["threads_read_failed"])
    stages.removeAll()

    // A huge unknown line must remain bounded, and must not become a known event mid-line.
    parser.consume(Data(repeating: 120, count: 2_000_000)) { stages.append($0) }
    parser.consume(Data(known.utf8)) { stages.append($0) }
    precondition(stages.isEmpty)
    parser.consume(Data(known.utf8)) { stages.append($0) }
    precondition(stages == ["codex_starting"])
    stages.removeAll()
    for stage in ["started", "reader_stopped", "exit_notified", "child_terminated"] {
      let line = "2026-11-15 22:29:00 codex shared app-server stop process_id=19 stage=\(stage) elapsed_ms=31 secret=private\n"
      for byte in line.utf8 { parser.consume(Data([byte])) { stages.append($0) } }
    }
    precondition(stages == ["codex_stop_started", "codex_stop_reader_stopped",
                            "codex_stop_exit_notified", "codex_stop_child_terminated"])
    stages.removeAll()
    parser.consume(Data("2026-11-15 22:29:00 codex shared app-server stop stage=private-secret\n".utf8)) { stages.append($0) }
    precondition(stages.isEmpty)
    print("PASS bounded startup checkpoints, chunk boundaries, and private-field exclusion")
  }
}
