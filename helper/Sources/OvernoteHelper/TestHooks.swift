import AppKit
import OvernoteCore

/// `test.*` socket methods, present only with `--test-hooks`, so the end to end window check
/// (scripts/e2e-window.sh) can read window state and drive bridge methods against the real
/// binary without synthesizing input events on the user's machine.
@MainActor
final class TestHooks {
    private weak var controller: PanelController?
    weak var dispatcher: RPCDispatcher?
    private var decoy: NSWindow?

    init(controller: PanelController) {
        self.controller = controller
    }

    /// The extension handler for `RPCDispatcher`. Returns nil for methods it does not own.
    nonisolated func handler() -> RPCDispatcher.ExtensionHandler {
        { [weak self] method, params in
            guard method.hasPrefix("test.") else { return nil }
            guard let self else { throw RPCError.internal("Test hooks are gone") }
            return try await self.handle(method, params)
        }
    }

    private func handle(_ method: String, _ rawParams: JSONValue?) async throws -> JSONValue {
        guard let controller else { throw RPCError.internal("No panel") }
        let p = try Params(rawParams)
        let panel = controller.panel
        switch method {
        case "test.windowState":
            let behavior = panel.collectionBehavior
            let frame = panel.frame
            return [
                "visible": .bool(panel.isVisible),
                "showPending": .bool(controller.isShowPending),
                "key": .bool(panel.isKeyWindow),
                "appActive": .bool(NSApp.isActive),
                "level": .int(Int64(panel.level.rawValue)),
                "modalPanelLevel": .int(Int64(NSWindow.Level.modalPanel.rawValue)),
                "canJoinAllSpaces": .bool(behavior.contains(.canJoinAllSpaces)),
                "fullScreenAuxiliary": .bool(behavior.contains(.fullScreenAuxiliary)),
                "nonactivating": .bool(panel.styleMask.contains(.nonactivatingPanel)),
                "resizable": .bool(panel.styleMask.contains(.resizable)),
                "axSubrole": .string(panel.accessibilitySubrole()?.rawValue ?? ""),
                "axLegacySubrole": .string(Self.legacyAccessibilityValue(of: panel, .subrole) as? String ?? ""),
                "axSizeSettable": .bool(Self.legacyAccessibilitySettable(panel, .size)),
                "axPositionSettable": .bool(Self.legacyAccessibilitySettable(panel, .position)),
                "resizeZones": .bool(Self.find(ResizeOverlayView.self, in: panel.contentView) != nil),
                "hidesOnDeactivate": .bool(panel.hidesOnDeactivate),
                "acceptsFirstMouse": .bool(panel.contentView.flatMap(Self.webView(in:))?.acceptsFirstMouse(for: nil) ?? true),
                "firstResponderIsWebView": .bool(panel.firstResponder is NotesWebView),
                "cornerRadius": .double(Double(NotesPanel.cornerRadius)),
                "frame": [
                    "x": .double(frame.minX), "y": .double(frame.minY),
                    "width": .double(frame.width), "height": .double(frame.height), "top": .double(frame.maxY),
                ],
                "overhang": .double(Double(controller.overhang)),
                "noteFrame": Self.rectJSON(controller.noteFrame),
                "materialFrame": Self.rectJSON(
                    Self.find(NSVisualEffectView.self, in: panel.contentView)?.frame ?? .zero),
                "resizeZonesHidden": .bool(Self.find(ResizeOverlayView.self, in: panel.contentView)?.isHidden ?? false),
                "screenKey": .string(panel.screen?.positionKey ?? ""),
                "pointerScreenKey": .string(Self.screenUnderPointer?.positionKey ?? ""),
                "visibleFrameHeight": .double(Double(panel.screen?.visibleFrame.height ?? 0)),
                "visibleFrame": Self.rectJSON(panel.screen?.visibleFrame ?? .zero),
                "minSize": ["width": .double(panel.minSize.width), "height": .double(panel.minSize.height)],
                "material": .int(Int64(Self.find(NSVisualEffectView.self, in: panel.contentView)?.material.rawValue ?? -1)),
                "hudWindowMaterial": .int(Int64(NSVisualEffectView.Material.hudWindow.rawValue)),
                "materialActive": .bool(Self.find(NSVisualEffectView.self, in: panel.contentView)?.state == .active),
                "webViewDrawsBackground": .bool(
                    (Self.find(NotesWebView.self, in: panel.contentView)?.value(forKey: "drawsBackground") as? Bool) ?? true),
                "dragRects": .array(
                    (Self.find(NotesWebView.self, in: panel.contentView)?.dragRects ?? []).map(Self.rectJSON)),
            ]
        case "test.asBridge":
            guard let dispatcher else { throw RPCError.internal("No dispatcher") }
            return try await dispatcher.handle(method: try p.string("method"), params: p.values["params"], source: .bridge)
        case "test.bridgeCalls":
            return [
                "methods": .array(controller.bridgeMethods.map(JSONValue.string)),
                "resizes": .array(controller.resizeReports.map(JSONValue.double)),
                "shownHeights": .array(controller.shownHeights.map(JSONValue.double)),
            ]
        case "test.menuItems":
            let menus = NSApp.mainMenu?.items.compactMap(\.submenu) ?? []
            return .array(menus.flatMap { menu in
                menu.items.filter { !$0.isSeparatorItem }.map { item -> JSONValue in
                    var keys = ""
                    if item.keyEquivalentModifierMask.contains(.shift) { keys += "⇧" }
                    if item.keyEquivalentModifierMask.contains(.option) { keys += "⌥" }
                    if item.keyEquivalentModifierMask.contains(.command) { keys += "⌘" }
                    return ["menu": .string(menu.title), "title": .string(item.title),
                            "keys": .string(keys + item.keyEquivalent.uppercased()),
                            "action": .string(item.action.map(NSStringFromSelector) ?? ""),
                            "hasTarget": .bool(item.target != nil)]
                }
            })
        case "test.keyDown":
            // A key event dispatched inside this process only (NSApp.sendEvent), the way AppKit
            // delivers a real key press to our key panel. Never global input.
            let key = try p.string("key")
            guard let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: (try p.optionalBool("command") ?? false) ? [.command] : [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber, context: nil,
                characters: key, charactersIgnoringModifiers: key, isARepeat: false, keyCode: try Self.keyCode(key))
            else { throw RPCError.internal("Could not make a key event") }
            NSApp.sendEvent(event)
            return [:]
        case "test.hitTest":
            // Which view a click at { x, y } (points from the content's top left) would reach.
            guard let content = panel.contentView else { throw RPCError.internal("No content view") }
            let point = Self.windowPoint(try p.double("x"), try p.double("y"), in: panel)
            let view = content.hitTest(content.convert(point, from: nil))
            let zone = (view as? ResizeOverlayView)?.edge(atWindowPoint: point)
            return ["view": .string(view.map { String(describing: type(of: $0)) } ?? ""),
                    "zone": zone.map { .string($0.name) } ?? .null]
        case "test.mouseDown":
            // A synthetic click (down then up) sent to our own panel through NSApp.sendEvent,
            // never through the window server. Drags are counted instead of performed.
            var drags = 0
            panel.dragInterceptor = { _ in drags += 1 }
            defer { panel.dragInterceptor = nil }
            let point = Self.windowPoint(try p.double("x"), try p.double("y"), in: panel)
            NSApp.sendEvent(try Self.mouseEvent(.leftMouseDown, at: point, windowNumber: panel.windowNumber))
            NSApp.sendEvent(try Self.mouseEvent(.leftMouseUp, at: point, windowNumber: panel.windowNumber))
            return ["drags": .int(Int64(drags)), "key": .bool(panel.isKeyWindow)]
        case "test.mouseDrag":
            // Presses at { x, y }, drags by { dx, dy } (points, y down) and releases. The drag and
            // release are queued in this app's own event queue as window-less events (screen
            // coordinates), so the resize tracking loop reads them like real ones.
            let point = Self.windowPoint(try p.double("x"), try p.double("y"), in: panel)
            let screenStart = panel.convertPoint(toScreen: point)
            let end = NSPoint(x: screenStart.x + CGFloat(try p.double("dx")), y: screenStart.y - CGFloat(try p.double("dy")))
            let midway = NSPoint(x: (screenStart.x + end.x) / 2, y: (screenStart.y + end.y) / 2)
            NSApp.postEvent(try Self.mouseEvent(.leftMouseDragged, at: midway, windowNumber: 0), atStart: false)
            NSApp.postEvent(try Self.mouseEvent(.leftMouseDragged, at: end, windowNumber: 0), atStart: false)
            NSApp.postEvent(try Self.mouseEvent(.leftMouseUp, at: end, windowNumber: 0), atStart: false)
            var drags = 0
            panel.dragInterceptor = { _ in drags += 1 }
            defer { panel.dragInterceptor = nil }
            NSApp.sendEvent(try Self.mouseEvent(.leftMouseDown, at: point, windowNumber: panel.windowNumber))
            return ["drags": .int(Int64(drags))]
        case "test.js":
            // Evaluates a page expression and returns it through JSON.
            guard let webView = Self.find(NotesWebView.self, in: panel.contentView) else { throw RPCError.internal("No web view") }
            let script = "JSON.stringify((\(try p.string("expression"))) ?? null)"
            let text = try await webView.evaluateJavaScript(script) as? String ?? "null"
            return try JSONValue.parse(text)
        case "test.events":
            return .array(controller.emittedEvents.map { ["event": .string($0.0), "payload": $0.1] })
        case "test.simulateUserResize":
            // Runs the same path as the end of a user's live resize.
            let start = panel.frame
            var end = start
            end.size.height = CGFloat(try p.double("height"))
            end.origin.y = start.maxY - end.height
            if let width = try p.optionalInt("width") { end.size.width = CGFloat(width) }
            panel.setFrame(end, display: true, animate: false)
            controller.userDidResize(from: start, to: panel.frame)
            return [:]
        case "test.accessibilityResize":
            // Places the panel the way a window manager does through Accessibility: AXPosition
            // (the top left corner), then AXSize through AppKit's Accessibility setter, which
            // keeps the top left corner and the frame on screen, then AXPosition again. Nothing
            // in the helper's own resize paths runs, as with system tiling.
            let topLeft = NSPoint(x: try p.double("x"), y: try p.double("top"))
            let size = NSValue(size: NSSize(width: try p.double("width"), height: try p.double("height")))
            panel.setFrameTopLeftPoint(topLeft)
            _ = panel.perform(
                NSSelectorFromString("accessibilitySetValue:forAttribute:"), with: size,
                with: NSAccessibility.Attribute.size.rawValue)
            panel.setFrameTopLeftPoint(topLeft)
            return [:]
        case "test.moveTo":
            // Moves the top left corner, as a user drag would.
            let top = CGFloat(try p.double("top"))
            let x = CGFloat(try p.double("x"))
            panel.setFrameTopLeftPoint(NSPoint(x: x, y: top))
            return [:]
        case "test.resignKey":
            // Takes key status away from the visible panel, as a click into another app would,
            // by making a tiny transparent window of ours key for a moment. The app is then
            // deactivated too, as it is while the user works in another app: a panel made key
            // while the decoy still held the app active lost key again to the deferred
            // deactivation, which made the focus checks flaky.
            let decoy = KeyDecoyWindow()
            decoy.orderFrontRegardless()
            decoy.makeKey()
            NSApp.deactivate()
            self.decoy = decoy
            return [:]
        case "test.dropDecoy":
            decoy?.orderOut(nil)
            decoy = nil
            return [:]
        default:
            throw RPCError.methodNotFound(method)
        }
    }

    // The legacy attribute API is what an Accessibility client's requests reach (AXSubrole,
    // whether AXSize is settable, AXSize itself). It is deprecated for implementers, so it is
    // called by selector here rather than by name.
    private static func legacyAccessibilityValue(of window: NSWindow, _ attribute: NSAccessibility.Attribute) -> Any? {
        window.perform(NSSelectorFromString("accessibilityAttributeValue:"), with: attribute.rawValue)?.takeUnretainedValue()
    }

    private static func legacyAccessibilitySettable(_ window: NSWindow, _ attribute: NSAccessibility.Attribute) -> Bool {
        typealias Settable = @convention(c) (AnyObject, Selector, NSString) -> Bool
        let selector = NSSelectorFromString("accessibilityIsAttributeSettable:")
        let function = unsafeBitCast(window.method(for: selector), to: Settable.self)
        return function(window, selector, attribute.rawValue as NSString)
    }

    private static func webView(in view: NSView) -> NotesWebView? {
        find(NotesWebView.self, in: view)
    }

    private static func find<T: NSView>(_ type: T.Type, in view: NSView?) -> T? {
        guard let view else { return nil }
        if let match = view as? T { return match }
        for subview in view.subviews {
            if let found = find(type, in: subview) { return found }
        }
        return nil
    }

    private static var screenUnderPointer: NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
    }

    private static func rectJSON(_ rect: NSRect) -> JSONValue {
        ["x": .double(rect.minX), "y": .double(rect.minY), "width": .double(rect.width), "height": .double(rect.height)]
    }

    /// A point given from the content's top left, in window coordinates.
    private static func windowPoint(_ x: Double, _ y: Double, in panel: NSWindow) -> NSPoint {
        let height = panel.contentView?.bounds.height ?? panel.frame.height
        return NSPoint(x: x, y: Double(height) - y)
    }

    private static func mouseEvent(_ type: NSEvent.EventType, at point: NSPoint, windowNumber: Int) throws -> NSEvent {
        guard let event = NSEvent.mouseEvent(
            with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
        else { throw RPCError.internal("Could not make a mouse event") }
        return event
    }

    private static func keyCode(_ key: String) throws -> UInt16 {
        switch key.lowercased() {
        case "w": return 13
        case "a": return 0
        case "c": return 8
        default: throw RPCError.badParams("Unsupported key: \(key)")
        }
    }
}

/// A 1 pt transparent window that can take key status, used only by `test.resignKey`.
private final class KeyDecoyWindow: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 1, height: 1), styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        alphaValue = 0.01
        isReleasedWhenClosed = false
    }

    override var canBecomeKey: Bool { true }
}
