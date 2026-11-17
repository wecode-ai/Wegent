import CoreFoundation
import Foundation

/// Expo's untyped dictionaries carry JavaScript numbers as Swift Double.
/// Reject malformed values instead of silently resetting cursors or timeouts.
enum RuntimeBridgeOptions {
  enum InvalidNumber: Error { case invalidInteger }

  static func integer(_ value: Any?, default defaultValue: Int, minimum: Int,
                      maximum: Int = 9_007_199_254_740_991) throws -> Int {
    guard let value else { return defaultValue }
    guard let number = value as? NSNumber,
          CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite,
          number.doubleValue <= Double(maximum),
          let integer = Int(exactly: number.doubleValue), integer >= minimum else {
      throw InvalidNumber.invalidInteger
    }
    return integer
  }
}
