import Foundation

@main
struct RuntimeEventJournalTests {
  static func main() throws {
    let journal = RuntimeEventJournal()
    let first = try journal.append(["event": "response.output_text.delta",
      "payload": ["delta": "private-account-a"]], generation: 1)
    precondition((journal.read(after: 0)["events"] as? [[String: Any]])?.count == 1)

    // Account B can be selected before its rootfs installation completes or
    // fails. No retained A event may be returned during either outcome.
    journal.reset()
    precondition((journal.read(after: 0)["events"] as? [[String: Any]])?.isEmpty == true)
    let second = try journal.append(["event": "executor.ready"], generation: 2)
    precondition((second["sequence"] as! Int) > (first["sequence"] as! Int))
    let events = journal.read(after: 0)["events"] as! [[String: Any]]
    precondition(events.count == 1 && events[0]["generation"] as? Int == 2)
    let encoded = try JSONSerialization.data(withJSONObject: events)
    precondition(!String(decoding: encoded, as: UTF8.self).contains("private-account-a"))
    print("PASS native journal account switch and failed-start isolation")

    let paged = RuntimeEventJournal()
    for _ in 0..<1355 { _ = try paged.append(["event": "response.output_text.delta"], generation: 39) }
    var cursor = 0
    var replayed: [Int] = []
    var pages = 0
    while true {
      let options: [String: Any] = ["afterSequence": Double(cursor)]
      let after = try RuntimeBridgeOptions.integer(options["afterSequence"], default: 0, minimum: 0)
      let page = paged.read(after: after)
      let events = page["events"] as! [[String: Any]]
      let sequences = events.map { $0["sequence"] as! Int }
      replayed.append(contentsOf: sequences)
      pages += 1
      if page["hasMore"] as? Bool != true { break }
      precondition(sequences.last! > cursor, "Replay must advance beyond the first 256 events")
      cursor = sequences.last!
    }
    precondition(pages == 6 && replayed == Array(1...1355))
    let after = try RuntimeBridgeOptions.integer(Double(1228), default: 0, minimum: 0)
    let resumed = paged.read(after: after)
    precondition((resumed["events"] as! [[String: Any]]).count == 127)
    precondition(resumed["hasMore"] as? Bool == false)
    print("PASS native replay across six JS-number pages and foreground resume after event 1228")

    let bounded = RuntimeEventJournal(maximumEntries: 3, maximumBytes: 1024)
    for _ in 0..<4 { _ = try bounded.append(["event": "done"], generation: 1) }
    let retained = bounded.read(after: 0)
    precondition((retained["events"] as! [[String: Any]]).map { $0["sequence"] as! Int } == [2, 3, 4])
    precondition(retained["truncated"] as? Bool == true)
    let oversized = try bounded.append(["event": "output", "data": String(repeating: "x", count: 2048)], generation: 1)
    precondition(oversized["sequence"] as? Int == 5, "Oversized events still reach live listeners")
    precondition((bounded.read(after: 4)["events"] as! [[String: Any]]).isEmpty)
    precondition(bounded.read(after: 4)["truncated"] as? Bool == true)
    _ = try bounded.append(["event": "done"], generation: 1)
    precondition((bounded.read(after: 5)["events"] as! [[String: Any]]).count == 1)
    precondition(bounded.read(after: 5)["truncated"] as? Bool == false)
    print("PASS replay count/byte bounds, oversized live delivery and explicit replay gaps")
  }
}
