// Stylelint catches CSS mistakes; Prettier owns formatting, so no stylistic rules here.
/** @type {import("stylelint").Config} */
export default {
  extends: ["stylelint-config-recommended"],
  plugins: ["./scripts/stylelint-editor-scope.mjs"],
  rules: {
    // It compares unrelated selectors by source order (".panel-row" after ".icon-button .icon"), which in
    // this codebase only ever flagged rules for different elements, never a real override bug.
    "no-descending-specificity": null,
    "overnote/editor-scope": [true, { allow: [".drop-cursor"] }],
  },
};
