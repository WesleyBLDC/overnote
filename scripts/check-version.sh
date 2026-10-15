#!/bin/bash
# Checks that every place that names the release version agrees with it. The Release workflow
# runs it on tag builds, before publishing.
#
#   scripts/check-version.sh <version> [overnote-<version>.zip]
#
# Checks:
#   - the version is semver (1.2.3 or 1.2.3-beta.1)
#   - helper/VERSION and HelperVersion.current (helper/Sources/OvernoteCore/Version.swift)
#   - with a zip: its assets/prebuilt.json records the version, the same helper version, and an
#     integer schemaVersion
#
# CHANGELOG.md is not checked: it follows the Raycast Store format (`## [Title] - {PR_MERGE_DATE}`),
# which is not keyed by version.
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

if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  ok "$VERSION is a semver version"
else
  bad "$VERSION is not a version like 1.2.3 or 1.2.3-beta.1"
fi

helper_version="$(tr -d '[:space:]' <helper/VERSION)"
if [[ "$helper_version" == "$VERSION" ]]; then
  ok "helper/VERSION is $VERSION"
else
  bad "helper/VERSION is $helper_version, the tag says $VERSION"
fi

swift_version="$(sed -n 's/.*static let current = "\(.*\)".*/\1/p' helper/Sources/OvernoteCore/Version.swift)"
if [[ "$swift_version" == "$VERSION" ]]; then
  ok "HelperVersion.current is $VERSION"
else
  bad "HelperVersion.current is ${swift_version:-missing}, the tag says $VERSION"
fi

if [[ -n "$ZIP" ]]; then
  prebuilt="$(unzip -p "$ZIP" overnote/assets/prebuilt.json 2>/dev/null || true)"
  if [[ -z "$prebuilt" ]]; then
    bad "$ZIP has no overnote/assets/prebuilt.json"
  else
    read -r zip_version zip_helper zip_schema < <(node -e '
      const p = JSON.parse(process.argv[1]);
      console.log([p.version, p.helperVersion, Number.isInteger(p.schemaVersion) ? p.schemaVersion : "missing"].join(" "));' "$prebuilt")
    if [[ "$zip_version" == "$VERSION" ]]; then ok "prebuilt.json version is $VERSION"; else bad "prebuilt.json version is $zip_version, the tag says $VERSION"; fi
    if [[ "$zip_helper" == "$VERSION" ]]; then ok "prebuilt.json helperVersion is $VERSION"; else bad "prebuilt.json helperVersion is $zip_helper, the tag says $VERSION"; fi
    if [[ "$zip_schema" =~ ^[0-9]+$ ]]; then ok "prebuilt.json schemaVersion is $zip_schema"; else bad "prebuilt.json has no integer schemaVersion"; fi
  fi
fi

((failures == 0)) || exit 1
