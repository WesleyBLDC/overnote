import { describe, expect, it, vi } from "vitest";

import { resolveCaptureText } from "../domain/capture";

const selection = (text: string) => async () => text;
const noSelection = async (): Promise<string> => {
  throw new Error("Unable to get selected text");
};

describe("Create Note text source order", () => {
  it("prefers launch context, then argument, then fallbackText, then selection, then empty", async () => {
    const all = {
      contextText: "context",
      argument: "argument",
      fallbackText: "fallback",
      getSelectedText: selection("selection"),
    };
    await expect(resolveCaptureText(all)).resolves.toMatchObject({ source: "context" });
    await expect(resolveCaptureText({ ...all, contextText: " " })).resolves.toMatchObject({ source: "argument" });
    await expect(resolveCaptureText({ ...all, contextText: null, argument: "" })).resolves.toMatchObject({
      text: "fallback",
    });
    await expect(resolveCaptureText({ getSelectedText: selection("picked") })).resolves.toEqual({
      text: "picked",
      source: "selection",
    });
    await expect(resolveCaptureText({ getSelectedText: noSelection })).resolves.toEqual({ text: "", source: "empty" });
  });

  it("does not read the selection when an earlier source has text", async () => {
    const read = vi.fn(selection("never"));
    await resolveCaptureText({ argument: "given", getSelectedText: read });
    expect(read).not.toHaveBeenCalled();
  });
});
