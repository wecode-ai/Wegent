import Foundation

@main
struct RuntimeBridgeOptionsTests {
  static func main() throws {
    // Match the real JSI dictionary representation, not JSONSerialization's NSNumber bridge.
    let options: [String: Any] = ["afterSequence": Double(1228), "timeoutMs": Double(15000)]
    let cursor = try RuntimeBridgeOptions.integer(options["afterSequence"], default: 0, minimum: 0)
    let timeout = try RuntimeBridgeOptions.integer(options["timeoutMs"], default: 75000, minimum: 1)
    let defaultTimeout = try RuntimeBridgeOptions.integer(nil, default: 75000, minimum: 1)
    precondition(cursor == 1228 && timeout == 15000 && defaultTimeout == 75000)
    for valid: Any in [Int(256), Double(256), NSNumber(value: 256)] {
      let parsed = try RuntimeBridgeOptions.integer(valid, default: 0, minimum: 0)
      precondition(parsed == 256)
    }
    for invalid: Any in [true, false, NSNull(), "256", -1.0, 0.5, Double.nan,
                         Double.infinity, 9_007_199_254_740_992.0] {
      do {
        _ = try RuntimeBridgeOptions.integer(invalid, default: 0, minimum: 0)
        preconditionFailure("Invalid bridge cursor was accepted")
      } catch RuntimeBridgeOptions.InvalidNumber.invalidInteger {}
    }
    do {
      _ = try RuntimeBridgeOptions.integer(Double(0), default: 75000, minimum: 1)
      preconditionFailure("Zero request timeout was accepted")
    } catch RuntimeBridgeOptions.InvalidNumber.invalidInteger {}
    do {
      _ = try RuntimeBridgeOptions.integer(Double(Int.max / 1_000_000 + 1), default: 75000,
                                           minimum: 1, maximum: Int.max / 1_000_000)
      preconditionFailure("Unrepresentable dispatch deadline was accepted")
    } catch RuntimeBridgeOptions.InvalidNumber.invalidInteger {}
    print("PASS native JS numeric options preserve cursors and timeouts and reject invalid input")
  }
}
