import AppKit
import CoreGraphics

switch CommandLine.arguments.dropFirst().first {
case "preflight":
    exit(CGPreflightPostEventAccess() ? 0 : 78)
case "escape":
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
    CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
case "click":
    let point = CGPoint(x: 85, y: 105)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
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
