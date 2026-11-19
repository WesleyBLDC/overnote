#!/usr/bin/env node
// React version drift check.
//
// The extension compiles against @raycast/api, which pins its own react and @types/react; the
// editor depends on react directly. When the root @types/react (extension) or the editor's react
// and @types/react drift from the API's pins, npm installs a second copy and TypeScript fails with
// "cannot be used as a JSX component" in whichever package sees the other copy. This check names
// the pin to change, so a future @raycast/api bump updates all of them together.
//
// Usage: node scripts/check-react-versions.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));

const api = readJson("node_modules/@raycast/api/package.json");
const apiPins = { ...api.peerDependencies, ...api.dependencies };
const rootPkg = readJson("package.json");
const editorPkg = readJson("editor/package.json");

const expected = [
  ["package.json devDependencies @types/react", rootPkg.devDependencies["@types/react"], apiPins["@types/react"]],
  ["editor/package.json dependencies react", editorPkg.dependencies.react, apiPins.react],
  ["editor/package.json dependencies react-dom", editorPkg.dependencies["react-dom"], apiPins.react],
  [
    "editor/package.json devDependencies @types/react",
    editorPkg.devDependencies["@types/react"],
    apiPins["@types/react"],
  ],
];

const drift = expected.filter(([, actual, wanted]) => wanted !== undefined && actual !== wanted);
for (const [where, actual, wanted] of drift) {
  console.error(`${where} is ${actual}; @raycast/api ${api.version} pins ${wanted}`);
}
if (drift.length > 0) process.exit(1);
console.log(`React pins match @raycast/api ${api.version}`);
