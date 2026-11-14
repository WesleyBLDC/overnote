# Security

## Report a vulnerability

Report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/WesleyBLDC/overnote/security/advisories/new) form.
Do not post exploit details in a public issue, pull request, or discussion.

Include the Overnote version, how you run it (a release install, a source checkout, or `Overnote.app`), your macOS version, what you found, steps to reproduce it, and the impact.
A small proof of concept helps.
Remove note text, secrets, and other personal data from logs and screenshots.

Once a fix ships, the advisory is published, with credit to you if you want it.

## Supported versions

Only the latest release is supported.
Fixes ship as a new release; update with Check for Updates and `npm run update-extension` ([docs/install.md](docs/install.md#update)).

## How Overnote handles your data

These are the design facts a report is most likely to touch.
[`docs/architecture/system-design.md`](docs/architecture/system-design.md) and [`docs/architecture.md`](docs/architecture.md) have the detail.

- **Notes stay on your Mac.**
  They live in one SQLite file in `~/Library/Application Support/Overnote`, with backups in its `backups` folder (mode 0700, files 0600).
  Overnote does not encrypt them; FileVault protects them at rest.
- **The local socket.**
  The extension talks to the helper over a Unix socket in `/tmp/overnote-<uid>/`, a folder created with mode 0700.
  Any process running as your user can reach it, as it can reach your files.
- **Network.**
  The panel's editor runs under a Content Security Policy with `connect-src 'none'`, and links open in your default browser.
  The only network call is Check for Updates, which reads the GitHub releases API.
- **Updates.**
  `npm run update-extension` downloads over HTTPS from GitHub releases and checks the zip against the release's `SHA256SUMS`.
  That checksum comes from the same release, so it catches a damaged download; it is not an independent signature.
  The helper binary is ad hoc signed, and the launcher checks it against its recorded checksum before starting it.
