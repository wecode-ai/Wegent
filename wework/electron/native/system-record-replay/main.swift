import AppKit
import ApplicationServices
import Foundation

private let startedAt = Date()
private var eventTap: CFMachPort?
private var runLoopSource: CFRunLoopSource?

private func emit(_ value: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value),
          let line = String(data: data, encoding: .utf8)
    else { return }
    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
}

private func axString(_ element: AXUIElement?, _ attribute: CFString) -> String? {
    guard let element else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else {
        return nil
    }
    return value as? String
}

private func focusedElement(pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &value)
        == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
}

private func focusedWindowTitle(pid: pid_t) -> String? {
    let app = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value)
        == .success,
        let value,
        CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return axString((value as! AXUIElement), kAXTitleAttribute as CFString)
}

private func elementAt(_ point: CGPoint) -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
        system,
        Float(point.x),
        Float(point.y),
        &element
    ) == .success else { return nil }
    return element
}

private func context(for event: CGEvent, usePointer: Bool) -> [String: Any] {
    guard let app = NSWorkspace.shared.frontmostApplication else { return [:] }
    let element = usePointer ? elementAt(event.location) : focusedElement(pid: app.processIdentifier)
    let role = axString(element, kAXRoleAttribute as CFString)
    let subrole = axString(element, kAXSubroleAttribute as CFString)
    let title = axString(element, kAXTitleAttribute as CFString)
        ?? axString(element, kAXDescriptionAttribute as CFString)
    return [
        "appName": app.localizedName ?? "",
        "appBundleId": app.bundleIdentifier ?? "",
        "windowTitle": focusedWindowTitle(pid: app.processIdentifier) ?? "",
        "targetRole": role ?? "",
        "targetSubrole": subrole ?? "",
        "targetTitle": title ?? "",
    ]
}

private func isSensitive(_ context: [String: Any]) -> Bool {
    let role = "\(context["targetRole"] ?? "") \(context["targetSubrole"] ?? "")"
    let title = "\(context["targetTitle"] ?? "")"
    return role.localizedCaseInsensitiveContains("secure") ||
        title.range(
            of: "password|passcode|secret|token|密码|口令|验证码",
            options: [.regularExpression, .caseInsensitive]
        ) != nil
}

private func isHighRisk(_ context: [String: Any]) -> Bool {
    let title = "\(context["targetTitle"] ?? "")"
    return title.range(
        of: "delete|remove|destroy|purchase|buy|pay|checkout|install|删除|移除|支付|购买|下单|安装",
        options: [.regularExpression, .caseInsensitive]
    ) != nil
}

private func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    let pointerEvent = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
    var payload = context(for: event, usePointer: pointerEvent)
    payload["offsetMs"] = max(0, Int(Date().timeIntervalSince(startedAt) * 1000))
    let highRisk = isHighRisk(payload)
    payload["risk"] = highRisk ? "high" : "low"
    payload["replayable"] = !highRisk

    switch type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
        payload["type"] = "mouse"
        payload["x"] = event.location.x
        payload["y"] = event.location.y
        payload["button"] = type == .rightMouseDown ? "right" : (type == .otherMouseDown ? "other" : "left")
        payload["clickCount"] = event.getIntegerValueField(.mouseEventClickState)
    case .keyDown:
        payload["type"] = "key"
        if isSensitive(payload) {
            payload["replayable"] = false
            payload["reason"] = "Sensitive keyboard input was not stored"
        } else {
            payload["keyCode"] = event.getIntegerValueField(.keyboardEventKeycode)
            payload["modifiers"] = event.flags.rawValue
        }
    case .scrollWheel:
        payload["type"] = "scroll"
        payload["x"] = event.location.x
        payload["y"] = event.location.y
        payload["deltaX"] = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)
        payload["deltaY"] = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
    default:
        return Unmanaged.passUnretained(event)
    }
    emit(payload)
    return Unmanaged.passUnretained(event)
}

private func permissionStatus() -> [String: Any] {
    [
        "supported": true,
        "accessibilityGranted": AXIsProcessTrusted(),
        "inputMonitoringGranted": CGPreflightListenEventAccess(),
    ]
}

private func requestPermissions() {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    _ = CGRequestListenEventAccess()
    emit(permissionStatus())
}

private func record() {
    guard AXIsProcessTrusted(), CGPreflightListenEventAccess() else {
        emit(["error": "Accessibility and Input Monitoring permissions are required"])
        exit(2)
    }
    let recordedEventTypes: [CGEventType] = [
        .leftMouseDown,
        .rightMouseDown,
        .otherMouseDown,
        .keyDown,
        .scrollWheel,
    ]
    var mask: CGEventMask = 0
    for eventType in recordedEventTypes {
        mask |= CGEventMask(1) << eventType.rawValue
    }
    eventTap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: eventCallback,
        userInfo: nil
    )
    guard let eventTap else {
        emit(["error": "Unable to create the macOS event tap"])
        exit(3)
    }
    runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
    CGEvent.tapEnable(tap: eventTap, enable: true)

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    interrupt.setEventHandler { CFRunLoopStop(CFRunLoopGetCurrent()) }
    terminate.setEventHandler { CFRunLoopStop(CFRunLoopGetCurrent()) }
    interrupt.resume()
    terminate.resume()
    emit(["ready": true])
    CFRunLoopRun()
}

private func activate(_ bundleId: String?) {
    guard let bundleId, !bundleId.isEmpty else { return }
    guard let application = NSRunningApplication.runningApplications(
        withBundleIdentifier: bundleId
    ).first else { return }
    if #available(macOS 14.0, *) {
        application.activate()
    } else {
        application.activate(options: [.activateIgnoringOtherApps])
    }
    Thread.sleep(forTimeInterval: 0.08)
}

private func execute(_ step: [String: Any]) {
    activate(step["appBundleId"] as? String)
    let type = step["type"] as? String
    if type == "mouse" {
        let point = CGPoint(
            x: step["x"] as? Double ?? 0,
            y: step["y"] as? Double ?? 0
        )
        let buttonName = step["button"] as? String
        let button: CGMouseButton = buttonName == "right" ? .right : (buttonName == "other" ? .center : .left)
        let down: CGEventType = button == .right ? .rightMouseDown : (button == .center ? .otherMouseDown : .leftMouseDown)
        let up: CGEventType = button == .right ? .rightMouseUp : (button == .center ? .otherMouseUp : .leftMouseUp)
        CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
        CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
    } else if type == "key" {
        let keyCode = CGKeyCode(step["keyCode"] as? Int ?? 0)
        let flags = CGEventFlags(rawValue: step["modifiers"] as? UInt64 ?? 0)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    } else if type == "scroll" {
        CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(step["deltaY"] as? Int ?? 0),
            wheel2: Int32(step["deltaX"] as? Int ?? 0),
            wheel3: 0
        )?.post(tap: .cghidEventTap)
    }
    emit(["ok": true])
}

let command = CommandLine.arguments.dropFirst().first ?? "status"
switch command {
case "status":
    emit(permissionStatus())
case "request-permissions":
    requestPermissions()
case "record":
    record()
case "execute":
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(["error": "Invalid replay step"])
        exit(4)
    }
    execute(object)
default:
    emit(["error": "Unknown command"])
    exit(1)
}
