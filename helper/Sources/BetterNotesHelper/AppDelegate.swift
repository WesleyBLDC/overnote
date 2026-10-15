import AppKit
import BetterNotesCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let runtime: HelperRuntime
    private var panelController: PanelController?

    init(runtime: HelperRuntime) {
        self.runtime = runtime
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = MainMenu.make()
        guard let repository = runtime.repository else { return }
        let controller = PanelController(
            repository: repository,
            editorDirectory: runtime.arguments.editorDir,
            logger: runtime.logger,
            onShutdown: { [runtime] in runtime.scheduleShutdown() }
        )
        panelController = controller
        runtime.start(host: controller)
        // Prewarm: the panel and the web view exist and load now, hidden, so the first
        // toggle only has to order the panel in.
        controller.prewarm(dispatcher: runtime.dispatcher)
        if runtime.arguments.show {
            controller.show()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        runtime.shutdown(reason: "terminate")
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }
}

/// A main menu is needed even though an accessory app never shows it: AppKit routes
/// standard key equivalents (copy, paste, undo, select all) through it to the web view.
@MainActor
enum MainMenu {
    static func make() -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        // No Quit item: the extension owns the helper's lifetime, and a stray ⌘Q should not kill it.
        appItem.submenu = NSMenu()
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let pastePlain = edit.addItem(
            withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
        pastePlain.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }
}
