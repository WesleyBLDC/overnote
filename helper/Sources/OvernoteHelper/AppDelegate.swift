import AppKit
import OvernoteCore

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let runtime: HelperRuntime
    private var panelController: PanelController?
    private var testHooks: TestHooks?
    private var appFeatures: AppFeatures?

    init(runtime: HelperRuntime) {
        self.runtime = runtime
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let repository = runtime.repository else {
            NSApp.mainMenu = MainMenu.make(closeTarget: nil)
            return
        }
        let controller = PanelController(
            repository: repository,
            editorDirectory: runtime.arguments.editorDir,
            logger: runtime.logger,
            recordEvents: runtime.arguments.testHooks,
            onShutdown: { [runtime] in runtime.scheduleShutdown() }
        )
        panelController = controller
        NSApp.mainMenu = MainMenu.make(closeTarget: controller)
        let hooks = runtime.arguments.testHooks ? TestHooks(controller: controller) : nil
        testHooks = hooks
        runtime.start(host: controller, extensionHandler: hooks?.handler())
        hooks?.dispatcher = runtime.dispatcher
        // Prewarm: the panel and the web view exist and load now, hidden, so the first
        // toggle only has to order the panel in.
        controller.prewarm(dispatcher: runtime.dispatcher)
        if runtime.arguments.watchEditor, let editorDir = runtime.arguments.editorDir {
            controller.watchEditorBuild(directory: editorDir)
        }
        if runtime.arguments.app, let dispatcher = runtime.dispatcher {
            appFeatures = AppFeatures(controller: controller, dispatcher: dispatcher, logger: runtime.logger)
        }
        if runtime.arguments.show {
            controller.show()
        }
    }

    /// Opening `Overnote.app` again while it runs shows the panel.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let panelController {
            Task { await panelController.showWindow() }
        }
        return false
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
    static func make(closeTarget: PanelController?) -> NSMenu {
        let main = NSMenu()

        let appItem = NSMenuItem()
        // No Quit item: the extension owns the helper's lifetime, and a stray ⌘Q should not kill it.
        // Overnote.app quits from its menu bar item instead.
        appItem.submenu = NSMenu()
        main.addItem(appItem)

        // ⌘W hides the panel, like closing a window in any app.
        let fileItem = NSMenuItem()
        let file = NSMenu(title: "File")
        let close = file.addItem(
            withTitle: "Close Window", action: #selector(PanelController.closeWindow(_:)), keyEquivalent: "w")
        close.target = closeTarget
        fileItem.submenu = file
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        // ⇧⌘V sends a real paste event to the web view; the editor turns it into plain text.
        let pastePlain = edit.addItem(
            withTitle: "Paste and Match Style", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        pastePlain.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        return main
    }
}

/// App mode only: the global hotkey and the menu bar item, both acting through the dispatcher
/// so they behave exactly like `window.toggle` and `notes.create { show: true }` on the socket.
@MainActor
final class AppFeatures {
    private let hotkey: GlobalHotkey?
    private let statusMenu: StatusMenu

    init(controller: PanelController, dispatcher: RPCDispatcher, logger: FileLogger) {
        let toggle: @MainActor () -> Void = {
            Task { _ = try? await dispatcher.handle(method: "window.toggle", params: nil, source: .socket) }
        }
        let newNote: @MainActor () -> Void = {
            Task {
                do {
                    _ = try await dispatcher.handle(method: "notes.create", params: AppFeatures.emptyNote, source: .socket)
                } catch {
                    logger.log("New Note from the menu bar failed: \(error)")
                }
            }
        }
        hotkey = GlobalHotkey(action: toggle)
        if hotkey == nil {
            logger.log("Could not register the hotkey \(GlobalHotkey.defaultShortcut.display); another app may own it")
        }
        statusMenu = StatusMenu(
            hotkey: hotkey == nil ? nil : GlobalHotkey.defaultShortcut, logger: logger,
            isPanelVisible: { controller.panel.isVisible }, toggle: toggle, newNote: newNote)
    }

    /// An empty note, as core's `contentFromMarkdown("")` builds it.
    static let emptyNote: JSONValue = [
        "rawContent": #"{"type":"doc","content":[{"type":"paragraph"}]}"#, "markdown": "", "text": "", "title": "",
        "show": true,
    ]
}
