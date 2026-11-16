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
  }
}
