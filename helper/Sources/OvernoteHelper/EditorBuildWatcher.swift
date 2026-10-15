import Foundation

/// Development only (`--watch-editor`): notices a new editor build in the editor directory.
///
/// Vite writes `index.html` last and names every asset by its content hash, so a changed
/// `index.html` means a complete new build. Polling it twice a second is cheap and avoids file
/// system event edge cases with Vite's delete and rewrite; the change fires once the file has
/// stayed the same for one more tick, so a build still being written never reloads half done.
@MainActor
final class EditorBuildWatcher {
    static let interval: TimeInterval = 0.5

    private let index: URL
    private let onChange: @MainActor () -> Void
    private var timer: Timer?
    private var current: Data?
    private var candidate: Data?

    init(directory: String, onChange: @escaping @MainActor () -> Void) {
        self.index = URL(fileURLWithPath: directory).appendingPathComponent("index.html")
        self.onChange = onChange
        self.current = try? Data(contentsOf: index)
    }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard let data = try? Data(contentsOf: index), !data.isEmpty, data != current else {
            candidate = nil
            return
        }
        if data == candidate {
            current = data
            candidate = nil
            onChange()
        } else {
            candidate = data
        }
    }
}
