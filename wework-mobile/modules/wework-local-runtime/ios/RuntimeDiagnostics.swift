import Foundation

/// App-wide diagnostic preference, independent of account and guest lifecycle.
public final class RuntimeDiagnostics {
  public static let shared = RuntimeDiagnostics()
  private let lock = NSLock()
  private let defaults: UserDefaults
  private let key = "wework.mobile.diagnostics-enabled.v1"
  private var enabled: Bool

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    enabled = defaults.bool(forKey: key)
  }

  public var isEnabled: Bool { lock.withLock { enabled } }

  func setEnabled(_ value: Bool) {
    lock.withLock {
      defaults.set(value, forKey: key)
      enabled = value
    }
  }
}
