import AppKit
import Carbon.HIToolbox

/// App mode only: one system wide hotkey that toggles the panel, registered with Carbon's
/// `RegisterEventHotKey`, which needs no Accessibility permission.
@MainActor
final class GlobalHotkey {
    struct Shortcut {
        let keyCode: UInt32
        let modifiers: UInt32
        /// How menus show it.
        let display: String
        let keyEquivalent: String
        let modifierFlags: NSEvent.ModifierFlags
    }

    /// The default toggle: ⌃⌥N. The editor uses ⌃⌥ only with the arrow keys (window placement),
    /// and few apps bind ⌃⌥ letters. Customizing it comes in a later phase.
    static let defaultShortcut = Shortcut(
        keyCode: UInt32(kVK_ANSI_N), modifiers: UInt32(controlKey | optionKey), display: "⌃⌥N",
        keyEquivalent: "n", modifierFlags: [.control, .option])

    /// Carbon calls back through a C function pointer, which cannot capture, so the one live
    /// hotkey is reachable from here. Only touched on the main thread.
    nonisolated(unsafe) private static var active: GlobalHotkey?

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: @MainActor () -> Void

    /// Registers `shortcut`. Returns nil when another app already owns that combination.
    init?(shortcut: Shortcut = GlobalHotkey.defaultShortcut, action: @escaping @MainActor () -> Void) {
        self.action = action
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, _ in
                // Carbon delivers hot key events on the main run loop.
                MainActor.assumeIsolated { GlobalHotkey.active?.action() }
                return noErr
            }, 1, &eventType, nil, &handlerRef)
        guard installed == noErr else { return nil }
        // 'OVNT': a signature unique to this app.
        let id = EventHotKeyID(signature: OSType(0x4F56_4E54), id: 1)
        let registered = RegisterEventHotKey(
            shortcut.keyCode, shortcut.modifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        guard registered == noErr else {
            if let handlerRef { RemoveEventHandler(handlerRef) }
            return nil
        }
        GlobalHotkey.active = self
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let handlerRef { RemoveEventHandler(handlerRef) }
        hotKeyRef = nil
        handlerRef = nil
        if GlobalHotkey.active === self { GlobalHotkey.active = nil }
    }
}
