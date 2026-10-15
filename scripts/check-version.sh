#!/bin/bash
# Checks that every place that names the release version agrees with it. The Release workflow
# runs it on tag builds, before publishing.
#
#   scripts/check-version.sh <version> [overnote-<version>.zip]
#
# Checks:
#   - helper/VERSION and HelperVersion.current (helper/Sources/OvernoteCore/Version.swift)
#   - the newest CHANGELOG.md entry (the first "## " heading) names the version
#   - with a zip: its assets/prebuilt.json records the version, the same helper version, and an
#     integer schemaVersion
set -euo pipefail

VERSION="${1:?usage: scripts/check-version.sh <version> [release zip]}"
VERSION="${VERSION#v}"
ZIP="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failures=0
ok() { printf '[check-version] ok  %s\n' "$*"; }
bad() {
  printf '[check-version] FAILED: %s\n' "$*" >&2
  failures=$((failures + 1))
}

helper_version="$(tr -d '[:space:]' <helper/VERSION)"
[[ "$helper_version" == "$VERSION" ]] && ok "helper/VERSION is $VERSION" || bad "helper/VERSION is $helper_version, the tag says $VERSION"

swift_version="$(sed -n 's/.*static let current = "\(.*\)".*/\1/p' helper/Sources/OvernoteCore/Version.swift)"
[[ "$swift_version" == "$VERSION" ]] && ok "HelperVersion.current is $VERSION" || bad "HelperVersion.current is ${swift_version:-missing}, the tag says $VERSION"

heading="$(grep -m 1 '^## ' CHANGELOG.md || true)"
# The version must appear as a whole word, so 0.3.0 does not match 0.3.01 or 10.3.0.
if [[ -n "$heading" ]] && grep -Eq "(^|[^0-9A-Za-z.])v?${VERSION//./\\.}([^0-9A-Za-z.]|$)" <<<"$heading"; then
  ok "the newest CHANGELOG.md entry is $heading"
else
  bad "the newest CHANGELOG.md entry (${heading:-none}) does not name $VERSION; add one such as '## [$VERSION] - {PR_MERGE_DATE}'"
fi

if [[ -n "$ZIP" ]]; then
  prebuilt="$(unzip -p "$ZIP" overnote/assets/prebuilt.json 2>/dev/null)" || bad "$ZIP has no overnote/assets/prebuilt.json"
  if [[ -n "${prebuilt:-}" ]]; then
    read -r zip_version zip_helper zip_schema < <(node -e '
      const p = JSON.parse(process.argv[1]);
      console.log([p.version, p.helperVersion, Number.isInteger(p.schemaVersion) ? p.schemaVersion : "missing"].join(" "));' "$prebuilt")
    [[ "$zip_version" == "$VERSION" ]] && ok "prebuilt.json version is $VERSION" || bad "prebuilt.json version is $zip_version, the tag says $VERSION"
    [[ "$zip_helper" == "$VERSION" ]] && ok "prebuilt.json helperVersion is $VERSION" || bad "prebuilt.json helperVersion is $zip_helper, the tag says $VERSION"
    [[ "$zip_schema" =~ ^[0-9]+$ ]] && ok "prebuilt.json schemaVersion is $zip_schema" || bad "prebuilt.json has no integer schemaVersion"
  fi
fi

((failures == 0)) || exit 1
