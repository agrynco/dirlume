import AppKit
import CoreGraphics

switch CommandLine.arguments.dropFirst().first {
case "preflight":
    exit(CGPreflightPostEventAccess() ? 0 : 78)
case "escape":
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false) else { exit(1) }
    down.post(tap: .cgSessionEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    up.post(tap: .cgSessionEventTap)
case "click":
    let point = CGPoint(x: 85, y: 105)
    guard let source = CGEventSource(stateID: .combinedSessionState),
          let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { exit(1) }
    // Place the real cursor over the swatch and deliver the click ahead of AppKit's sampler tap.
    _ = CGWarpMouseCursorPosition(point)
    move.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.08)
    up.post(tap: .cghidEventTap)
default:
    guard let screen = NSScreen.screens.first else { exit(1) }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let area = NSRect(x: 25, y: screen.frame.maxY - 155, width: 155, height: 105)
    let window = NSPanel(contentRect: area, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    window.backgroundColor = NSColor(srgbRed: 36.0 / 255, green: 89.0 / 255, blue: 120.0 / 255, alpha: 1)
    window.level = .floating
    window.hidesOnDeactivate = false
    window.orderFrontRegardless()
    FileHandle.standardOutput.write(Data("ready\n".utf8))
    app.run()
}
