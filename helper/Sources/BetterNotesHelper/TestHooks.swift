import AppKit
import BetterNotesCore

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
                "key": .bool(panel.isKeyWindow),
                "appActive": .bool(NSApp.isActive),
                "level": .int(Int64(panel.level.rawValue)),
                "modalPanelLevel": .int(Int64(NSWindow.Level.modalPanel.rawValue)),
                "canJoinAllSpaces": .bool(behavior.contains(.canJoinAllSpaces)),
                "fullScreenAuxiliary": .bool(behavior.contains(.fullScreenAuxiliary)),
                "nonactivating": .bool(panel.styleMask.contains(.nonactivatingPanel)),
                "resizable": .bool(panel.styleMask.contains(.resizable)),
                "hidesOnDeactivate": .bool(panel.hidesOnDeactivate),
                "acceptsFirstMouse": .bool(panel.contentView.flatMap(Self.webView(in:))?.acceptsFirstMouse(for: nil) ?? true),
                "firstResponderIsWebView": .bool(panel.firstResponder is NotesWebView),
                "cornerRadius": .double(Double(NotesPanel.cornerRadius)),
                "frame": [
                    "x": .double(frame.minX), "y": .double(frame.minY),
                    "width": .double(frame.width), "height": .double(frame.height), "top": .double(frame.maxY),
                ],
                "screenKey": .string(panel.screen?.positionKey ?? ""),
                "visibleFrameHeight": .double(Double(panel.screen?.visibleFrame.height ?? 0)),
            ]
        case "test.asBridge":
            guard let dispatcher else { throw RPCError.internal("No dispatcher") }
            return try await dispatcher.handle(method: try p.string("method"), params: p.values["params"], source: .bridge)
        case "test.bridgeCalls":
            return [
                "methods": .array(controller.bridgeMethods.map(JSONValue.string)),
                "resizes": .array(controller.resizeReports.map(JSONValue.double)),
            ]
        case "test.editMenu":
            let edit = NSApp.mainMenu?.items.compactMap(\.submenu).first { $0.title == "Edit" }
            return .array((edit?.items ?? []).filter { !$0.isSeparatorItem }.map { item in
                var keys = ""
                if item.keyEquivalentModifierMask.contains(.shift) { keys += "⇧" }
                if item.keyEquivalentModifierMask.contains(.option) { keys += "⌥" }
                if item.keyEquivalentModifierMask.contains(.command) { keys += "⌘" }
                return ["title": .string(item.title), "keys": .string(keys + item.keyEquivalent.uppercased()),
                        "action": .string(item.action.map(NSStringFromSelector) ?? "")]
            })
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
        case "test.moveTo":
            // Moves the top left corner, as a user drag would.
            let top = CGFloat(try p.double("top"))
            let x = CGFloat(try p.double("x"))
            panel.setFrameTopLeftPoint(NSPoint(x: x, y: top))
            return [:]
        case "test.resignKey":
            // Takes key status away from the visible panel, as a click into another app would,
            // by making a tiny transparent window of ours key for a moment.
            let decoy = KeyDecoyWindow()
            decoy.orderFrontRegardless()
            decoy.makeKey()
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

    private static func webView(in view: NSView) -> NotesWebView? {
        if let webView = view as? NotesWebView { return webView }
        for subview in view.subviews {
            if let found = webView(in: subview) { return found }
        }
        return nil
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
