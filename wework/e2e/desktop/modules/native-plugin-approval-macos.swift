import ApplicationServices
import AppKit
import Foundation

func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value as? T
}

func matchingButton(_ element: AXUIElement, labels: Set<String>, depth: Int) -> AXUIElement? {
    guard depth > 0 else { return nil }
    let role: String? = attribute(element, kAXRoleAttribute)
    if role == kAXButtonRole,
       let title: String = attribute(element, kAXTitleAttribute),
       labels.contains(title), attribute(element, kAXEnabledAttribute) == true {
        return element
    }
    let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) ?? []
    return children.lazy.compactMap { matchingButton($0, labels: labels, depth: depth - 1) }.first
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let arguments = CommandLine.arguments.dropFirst()
guard let first = arguments.first, let pid = pid_t(first), pid > 0,
      let running = NSRunningApplication(processIdentifier: pid) else {
    fail("The isolated Electron process is missing")
}
guard AXIsProcessTrusted() else { fail("The test driver lacks macOS accessibility access") }
let labels = Set(arguments.dropFirst())
guard !labels.isEmpty else { fail("Expected approved native button labels") }
let application = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(application, 0.5)
running.activate()
let deadline = ProcessInfo.processInfo.systemUptime + 10
var windowCount = 0
var dialogCount = 0
while ProcessInfo.processInfo.systemUptime < deadline {
    let windows: [AXUIElement] = attribute(application, kAXWindowsAttribute) ?? []
    windowCount = windows.count
    dialogCount = 0
    for window in windows {
        let children: [AXUIElement] = attribute(window, kAXChildrenAttribute) ?? []
        let sheets = children.filter { (attribute($0, kAXRoleAttribute) as String?) == kAXSheetRole }
        let subrole: String? = attribute(window, kAXSubroleAttribute)
        let dialogs = subrole == kAXDialogSubrole ? [window] + sheets : sheets
        dialogCount += dialogs.count
        for dialog in dialogs {
            guard let button = matchingButton(dialog, labels: labels, depth: 6) else { continue }
            let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
            // A press can close the sheet before it replies. The app outcome verifies the action.
            if result == .success || result == .cannotComplete { exit(0) }
            fail("Native button press failed with AX error \(result.rawValue)")
        }
    }
    Thread.sleep(forTimeInterval: 0.1)
}
fail("No matching native confirmation for PID \(pid). Windows: \(windowCount), dialogs: \(dialogCount).")
