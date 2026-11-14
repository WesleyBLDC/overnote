import Foundation
import ServiceManagement

/// App mode only: Launch at Login through `SMAppService.mainApp` (macOS 13 and later).
@MainActor
enum LoginItem {
    /// True when the app is registered, including while it waits for approval in System Settings.
    static var isEnabled: Bool {
        switch SMAppService.mainApp.status {
        case .enabled, .requiresApproval: true
        default: false
        }
    }

    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    /// Registers or unregisters the app. Throws what ServiceManagement reports.
    static func setEnabled(_ enabled: Bool) throws {
        if enabled {
            try SMAppService.mainApp.register()
        } else {
            try SMAppService.mainApp.unregister()
        }
    }
}
