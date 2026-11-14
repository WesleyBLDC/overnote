import AppKit
import OvernoteCore

/// App mode only: the menu bar item. Show or Hide Overnote, New Note, Launch at Login, About,
/// and Quit. The app has no Dock icon (LSUIElement), so this is its only visible handle.
@MainActor
final class StatusMenu: NSObject, NSMenuDelegate {
    private let statusItem: NSStatusItem
    private let menu = NSMenu()
    private let toggleItem: NSMenuItem
    private let loginItem: NSMenuItem
    private let isPanelVisible: () -> Bool
    private let toggle: () -> Void
    private let newNote: () -> Void
    private let logger: FileLogger

    init(
        hotkey: GlobalHotkey.Shortcut?, logger: FileLogger, isPanelVisible: @escaping () -> Bool,
        toggle: @escaping () -> Void, newNote: @escaping () -> Void
    ) {
        self.logger = logger
        self.isPanelVisible = isPanelVisible
        self.toggle = toggle
        self.newNote = newNote
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        toggleItem = NSMenuItem(title: "Show Overnote", action: #selector(toggleClicked), keyEquivalent: "")
        loginItem = NSMenuItem(title: "Launch at Login", action: #selector(loginClicked), keyEquivalent: "")
        super.init()

        if let button = statusItem.button {
            // The logo template from the app bundle (assets/brand/menubar); a system symbol when run outside it.
            let image =
                Bundle.main.image(forResource: "OvernoteStatusTemplate")
                ?? NSImage(systemSymbolName: "note.text", accessibilityDescription: "Overnote")
            image?.size = NSSize(width: 18, height: 18)
            image?.accessibilityDescription = "Overnote"
            image?.isTemplate = true
            button.image = image
            button.toolTip = "Overnote"
        }
        // Shown for reference only: the global hotkey, not this menu, handles the keystroke.
        if let hotkey {
            toggleItem.keyEquivalent = hotkey.keyEquivalent
            toggleItem.keyEquivalentModifierMask = hotkey.modifierFlags
        }
        let newItem = NSMenuItem(title: "New Note", action: #selector(newNoteClicked), keyEquivalent: "")
        let aboutItem = NSMenuItem(title: "About Overnote", action: #selector(aboutClicked), keyEquivalent: "")
        let quitItem = NSMenuItem(title: "Quit Overnote", action: #selector(quitClicked), keyEquivalent: "q")
        for item in [toggleItem, newItem, loginItem, aboutItem, quitItem] { item.target = self }
        menu.addItem(toggleItem)
        menu.addItem(newItem)
        menu.addItem(.separator())
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(aboutItem)
        menu.addItem(quitItem)
        menu.delegate = self
        statusItem.menu = menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        toggleItem.title = isPanelVisible() ? "Hide Overnote" : "Show Overnote"
        loginItem.state = LoginItem.isEnabled ? .on : .off
        loginItem.title = LoginItem.needsApproval ? "Launch at Login (Needs Approval)" : "Launch at Login"
    }

    @objc private func toggleClicked() { toggle() }

    @objc private func newNoteClicked() { newNote() }

    @objc private func loginClicked() {
        let enable = !LoginItem.isEnabled
        do {
            try LoginItem.setEnabled(enable)
            logger.log("Launch at Login \(enable ? "on" : "off")")
        } catch {
            logger.log("Could not change Launch at Login: \(error)")
            let alert = NSAlert()
            alert.messageText = "Could not change Launch at Login"
            alert.informativeText = error.localizedDescription
            NSApp.activate()
            alert.runModal()
        }
    }

    @objc private func aboutClicked() {
        NSApp.activate()
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Overnote",
            .applicationVersion: HelperVersion.current,
            .version: "Running as app",
            .credits: NSAttributedString(string: "A floating Markdown notepad. Notes live in ~/Library/Application Support/Overnote."),
        ])
    }

    @objc private func quitClicked() { NSApp.terminate(nil) }
}
