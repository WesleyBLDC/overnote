import CoreGraphics
import Foundation
import Testing
@testable import OvernoteCore

// The terminal drawer's helper side, headless: a real pseudo terminal with harmless programs
// (/bin/cat, /bin/sh, and a fake `hc`), never a real Herdr attach.

/// Collects a session's output and exit across its background queue.
private final class Capture: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes = Data()
    private var code: Int32?

    var text: String { lock.withLock { String(decoding: bytes, as: UTF8.self) } }
    var exitCode: Int32? { lock.withLock { code } }
    var count: Int { lock.withLock { bytes.count } }

    func attach(_ session: TerminalSession, ack: Bool = true) {
        session.onOutput = { [weak self, weak session] data in
            self?.lock.withLock { self?.bytes.append(data) }
            if ack { session?.ack(data.count) }
        }
        session.onExit = { [weak self] code in self?.lock.withLock { self?.code = code } }
        session.start()
    }

    /// Waits up to `seconds` for `condition`.
    func wait(_ seconds: Double = 5, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return condition()
    }
}

private func command(_ executable: String, _ arguments: [String] = []) -> TerminalSession.Command {
    TerminalSession.Command(
        executable: executable, arguments: arguments,
        environment: TerminalLauncher.terminalEnvironment(from: ProcessInfo.processInfo.environment),
        directory: NSTemporaryDirectory())
}

@Suite("Terminal session", .serialized)
struct TerminalSessionTests {
    @Test func catEchoesThroughThePseudoTerminalAndHangsUpOnClose() throws {
        let session = try TerminalSession(command: command("/bin/cat"), cols: 80, rows: 15)
        let capture = Capture()
        capture.attach(session)
        session.write(Data("hello drawer\r".utf8))
        // The terminal echoes the line, then cat prints it back.
        #expect(capture.wait { capture.text.components(separatedBy: "hello drawer").count >= 3 })
        session.close()
        #expect(capture.wait { capture.exitCode != nil })
        #expect(session.isFinished)
    }

    @Test func resizeReachesTheProgram() throws {
        let script = "stty size; read line; stty size"
        let session = try TerminalSession(command: command("/bin/sh", ["-c", script]), cols: 80, rows: 15)
        let capture = Capture()
        capture.attach(session)
        #expect(capture.wait { capture.text.contains("15 80") })
        session.resize(cols: 120, rows: 20)
        session.write(Data("\r".utf8))
        #expect(capture.wait { capture.text.contains("20 120") })
        #expect(capture.wait { capture.exitCode == 0 })
    }

    @Test func exitCodeAndLastOutputArriveTogether() throws {
        let session = try TerminalSession(command: command("/bin/sh", ["-c", "echo last words; exit 3"]), cols: 80, rows: 15)
        let capture = Capture()
        capture.attach(session)
        #expect(capture.wait { capture.exitCode == 3 })
        #expect(capture.text.contains("last words"))
    }

    @Test func readingPausesAboveTheHighWaterMarkUntilAcked() throws {
        // About 1 MB of output that nobody acks: reading stops near 256 KB and resumes on ack.
        let script = "head -c 1000000 /dev/zero | tr '\\0' x; echo; echo done"
        let session = try TerminalSession(command: command("/bin/sh", ["-c", script]), cols: 80, rows: 15)
        let capture = Capture()
        capture.attach(session, ack: false)
        #expect(capture.wait { session.isPaused })
        let held = capture.count
        #expect(held >= TerminalSession.highWater)
        #expect(held < 600_000)
        Thread.sleep(forTimeInterval: 0.2)
        #expect(capture.count == held)
        while capture.exitCode == nil, capture.wait(2, until: { session.isPaused || capture.exitCode != nil }) {
            session.ack(session.unackedBytes)
        }
        #expect(capture.wait { capture.text.contains("done") && capture.exitCode == 0 })
    }
}

@Suite("Terminal launcher", .serialized)
struct TerminalLauncherTests {
    @Test func environmentKeepsOnlyTheTerminalBasics() {
        let env = TerminalLauncher.terminalEnvironment(from: [
            "HOME": "/Users/x", "USER": "x", "PATH": "/bin", "OVERNOTE_SUPPORT_DIR": "/secret", "API_TOKEN": "t",
        ])
        #expect(env["TERM"] == "xterm-256color")
        #expect(env["COLORTERM"] == "truecolor")
        #expect(env["LANG"] == "en_US.UTF-8")
        #expect(env["HOME"] == "/Users/x")
        #expect(env["OVERNOTE_SUPPORT_DIR"] == nil)
        #expect(env["API_TOKEN"] == nil)
    }

    @Test func missingHerdrFallsBackToTheLoginShell() {
        #expect(TerminalLauncher.findHC(environment: ["OVERNOTE_HC": "/nonexistent/hc"]) == nil)
        let (command, backend) = TerminalLauncher.command(hc: nil, environment: ["HOME": "/tmp", "SHELL": "/bin/sh"])
        #expect(backend == .shell)
        #expect(command.executable == "/bin/sh")
        #expect(command.arguments == ["-l"])
        #expect(command.directory == "/tmp")
    }

    /// A fake `hc` that logs its arguments: `get` fails until `run` created the terminal, and
    /// `attach` prints a line and exits, standing in for a detach.
    @Test func herdrCreatesTheKeptTerminalOnceThenAttaches() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("overnote-hc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let log = folder.appendingPathComponent("log").path
        let made = folder.appendingPathComponent("made").path
        let hc = folder.appendingPathComponent("hc").path
        try """
        #!/bin/sh
        echo "$*" >> '\(log)'
        case "$1" in
          get) [ -f '\(made)' ] ;;
          run) touch '\(made)' ;;
          attach) echo "attached to $2"; exit 0 ;;
        esac
        """.write(toFile: hc, atomically: true, encoding: .utf8)
        chmod(hc, 0o755)
        #expect(TerminalLauncher.findHC(environment: ["OVERNOTE_HC": hc]) == hc)

        for _ in 0..<2 {
            let (command, backend) = TerminalLauncher.command(hc: hc, environment: ProcessInfo.processInfo.environment)
            #expect(backend == .herdr)
            let session = try TerminalSession(command: command, cols: 80, rows: 15)
            let capture = Capture()
            capture.attach(session)
            #expect(capture.wait { capture.exitCode == 0 })
            #expect(capture.text.contains("attached to overnote-drawer"))
        }
        let calls = try String(contentsOfFile: log, encoding: .utf8).split(separator: "\n").map(String.init)
        #expect(calls.filter { $0.hasPrefix("run ") }.count == 1)
        let run = try #require(calls.first { $0.hasPrefix("run ") })
        #expect(run.contains("--bg --keep --no-parent --no-notify --name overnote-drawer"))
        #expect(run.contains("--label app=overnote"))
        #expect(calls.filter { $0 == "attach overnote-drawer --history 500" }.count == 2)
    }
}

@Suite("Terminal drawer geometry")
struct DrawerGeometryTests {
    @Test func theDrawerHangsBelowTheNoteAndOutOfItsArea() {
        let note = CGRect(x: 100, y: 400, width: 640, height: 560)
        let window = PanelGeometry.window(note: note, drawer: 260)
        #expect(window == CGRect(x: 100, y: 140, width: 640, height: 820))
        #expect(PanelGeometry.note(window: window, drawer: 260) == note)
        #expect(PanelGeometry.window(note: note, drawer: 0) == note)
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 875)
        let area = PanelGeometry.noteArea(visible: visible, drawer: 260)
        #expect(area == CGRect(x: 0, y: 260, width: 1440, height: 615))
        // Fill takes the drawer's space from the note, so note and drawer fill the display.
        let filled = PanelGeometry.placed(.fill, current: note.size, visible: area, minimum: PanelSizing.floorSize)
        #expect(PanelGeometry.window(note: filled, drawer: 260) == visible)
        // A note near the bottom moves up so the drawer stays on screen.
        let low = PanelGeometry.keepOnScreen(
            CGRect(x: 100, y: 50, width: 640, height: 400), visible: area, minimum: PanelSizing.floorSize)
        #expect(PanelGeometry.window(note: low, drawer: 260).minY >= visible.minY)
    }

    @Test func terminalSettingRoundTripsAndValidates() throws {
        var settings = Settings.defaults
        #expect(settings.json["terminal"] == ["open": false])
        settings = try settings.applying(["terminal": ["open": true]])
        #expect(settings.terminalOpen)
        #expect(throws: RPCError.self) { try Settings.defaults.applying(["terminal": ["open": "yes"]]) }
        #expect(throws: RPCError.self) { try Settings.defaults.applying(["terminal": true]) }
    }
}
