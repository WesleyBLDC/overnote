import Foundation

/// Decides what runs in the terminal drawer (docs/architecture.md, the terminal drawer).
///
/// With Herdr's `hc` installed, the drawer attaches to a kept Herdr terminal named
/// `overnote-drawer`, created on first use in the home folder, so the shell outlives the drawer,
/// the panel, and the helper. Herdr.app itself is never launched, focused, or moved.
/// Without `hc`, the drawer runs the login shell in a plain pseudo terminal, which ends with the helper.
public enum TerminalLauncher {
    /// The kept Herdr terminal's name: unique among live terminals, so two opens cannot create two.
    public static let terminalName = "overnote-drawer"
    /// Scrollback lines `hc attach` replays on every attach.
    public static let historyLines = 500

    /// Starts `hc` in a terminal: create the kept terminal when it is missing, then attach to it.
    /// `$1` is the path to `hc`. A failed create that finds the terminal afterwards lost a race
    /// with another open, which is fine.
    static let herdrScript = """
        hc="$1"
        if ! "$hc" get \(terminalName) >/dev/null 2>&1; then
          "$hc" run --bg --keep --no-parent --no-notify --name \(terminalName) --cwd "$HOME" --label app=overnote >/dev/null 2>&1 ||
            "$hc" get \(terminalName) >/dev/null 2>&1 || {
            echo "Overnote could not start the Herdr terminal \(terminalName)."
            exit 1
          }
        fi
        exec "$hc" attach \(terminalName) --history \(historyLines)
        """

    /// Folders `hc` installs into, checked when the login shell does not know it.
    static let knownFolders = ["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]

    /// The command for the drawer, given the `hc` path (nil: Herdr is missing).
    public static func command(hc: String?, environment: [String: String]) -> (TerminalSession.Command, TerminalBackend) {
        let env = terminalEnvironment(from: environment)
        let home = env["HOME"] ?? NSHomeDirectory()
        if let hc {
            let command = TerminalSession.Command(
                executable: "/bin/sh", arguments: ["-c", herdrScript, "overnote-terminal", hc], environment: env,
                directory: home)
            return (command, .herdr)
        }
        let shell = env["SHELL"] ?? "/bin/zsh"
        return (TerminalSession.Command(executable: shell, arguments: ["-l"], environment: env, directory: home), .shell)
    }

    /// What the terminal's programs see: the person's identity, home, and path, the terminal type,
    /// and the locale, and nothing else from the helper (no `OVERNOTE_*` and no secrets it inherited).
    public static func terminalEnvironment(from environment: [String: String]) -> [String: String] {
        var env: [String: String] = [:]
        for key in ["HOME", "USER", "LOGNAME", "TMPDIR"] {
            if let value = environment[key], !value.isEmpty { env[key] = value }
        }
        env["HOME"] = env["HOME"] ?? NSHomeDirectory()
        let shell = environment["SHELL"] ?? ""
        env["SHELL"] = shell.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: shell) ? shell : "/bin/zsh"
        env["PATH"] = environment["PATH"].flatMap { $0.isEmpty ? nil : $0 } ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        let lang = environment["LANG"] ?? ""
        env["LANG"] = lang.isEmpty ? "en_US.UTF-8" : lang
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        return env
    }

    /// Finds `hc`. `OVERNOTE_HC` overrides the lookup (tests point it at a fake, and an empty value
    /// or a missing file means no Herdr); otherwise the login shell's `command -v hc`, since a helper
    /// started by Raycast does not inherit the person's PATH; otherwise the known install folders.
    /// Runs the login shell, so call it off the main thread.
    public static func findHC(environment: [String: String]) -> String? {
        if let override = environment["OVERNOTE_HC"] {
            return FileManager.default.isExecutableFile(atPath: override) ? override : nil
        }
        let home = environment["HOME"] ?? NSHomeDirectory()
        if let found = loginShellLookup(environment: environment), FileManager.default.isExecutableFile(atPath: found) {
            return found
        }
        for folder in knownFolders {
            let path = (folder.replacingOccurrences(of: "~", with: home) as NSString).appendingPathComponent("hc")
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    /// `zsh -lc 'command -v hc'`, given up after 3 seconds.
    static func loginShellLookup(environment: [String: String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v hc"]
        process.environment = terminalEnvironment(from: environment)
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        do {
            try process.run()
        } catch {
            return nil
        }
        if done.wait(timeout: .now() + 3) == .timedOut {
            process.terminate()
            return nil
        }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        let line = String(decoding: data, as: UTF8.self).split(separator: "\n").last.map(String.init) ?? ""
        let path = line.trimmingCharacters(in: .whitespaces)
        return path.hasPrefix("/") ? path : nil
    }
}
