import Foundation

@main
struct RuntimeDiagnosticsTests {
  static func main() {
    let suite = "wework-diagnostics-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let policy = RuntimeDiagnostics(defaults: defaults)
    precondition(!policy.isEnabled)
    policy.setEnabled(true)
    precondition(policy.isEnabled)
    precondition(RuntimeDiagnostics(defaults: defaults).isEnabled)
    policy.setEnabled(false)
    precondition(!RuntimeDiagnostics(defaults: defaults).isEnabled)
    print("PASS native diagnostics default off and persistent enable/disable")
  }
}
