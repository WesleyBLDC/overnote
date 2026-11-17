#!/usr/bin/env node
// Colors come only from the theme tokens (editor/src/styles/theme.css, design/overnote/SPEC.md):
// - no raw color value (#hex, rgb(), rgba(), hsl(), hsla()) in editor source outside theme.css;
// - the retired iris accent (#8f80ff, #5b4bd5) appears in no tracked file outside the design handoff.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const THEME = "editor/src/styles/theme.css";
const RAW_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/;
const RETIRED = /#(?:8f80ff|5b4bd5)\b/i;

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const problems = [];

for (const file of tracked) {
  const isEditorSource = /^editor\/src\/.*\.(css|ts|tsx)$/.test(file) && file !== THEME;
  const isText = /\.(css|ts|tsx|js|mjs|json|md|swift|sh|html|svg)$/.test(file);
  if (!isText || file.startsWith("design/") || file === "scripts/check-theme-tokens.mjs") continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, index) => {
    if (RETIRED.test(line)) problems.push(`${file}:${index + 1}: the retired iris accent: ${line.trim()}`);
    else if (isEditorSource && RAW_COLOR.test(line))
      problems.push(`${file}:${index + 1}: a raw color; use a token from ${THEME}: ${line.trim()}`);
  });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("theme tokens: no raw colors outside theme.css, no retired accent");
