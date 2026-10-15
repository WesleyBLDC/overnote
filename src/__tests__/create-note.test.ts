import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeMainWindow, getSelectedText } from "@raycast/api";
import { resolveCaptureText } from "../domain/capture";

const createNote = vi.fn(async () => ({ id: "01" }));
const contentFromMarkdown = vi.fn((markdown: string) => ({
  rawContent: JSON.stringify({ type: "doc", markdown }),
  markdown,
  text: markdown,
  title: markdown.split("\n")[0] ?? "",
}));
const showFailureToast = vi.fn(async () => undefined);

vi.mock("../api/notes", () => ({ createNote }));
vi.mock("../api/content", () => ({ contentFromMarkdown }));
vi.mock("@raycast/utils", () => ({ showFailureToast }));

const selection = (text: string) => async () => text;
const noSelection = async (): Promise<string> => {
  throw new Error("Unable to get selected text");
};

describe("resolveCaptureText", () => {
  it("prefers launch context text over everything else", async () => {
    await expect(
      resolveCaptureText({
        contextText: "from context",
        argument: "from argument",
        fallbackText: "from fallback",
        getSelectedText: selection("from selection"),
      }),
    ).resolves.toEqual({ text: "from context", source: "context" });
  });

  it("uses the argument next", async () => {
    await expect(
      resolveCaptureText({ argument: "from argument", fallbackText: "fb", getSelectedText: selection("sel") }),
    ).resolves.toEqual({ text: "from argument", source: "argument" });
  });

  it("uses fallbackText when the argument is blank", async () => {
    await expect(
      resolveCaptureText({ argument: "   ", fallbackText: "from fallback", getSelectedText: selection("sel") }),
    ).resolves.toEqual({ text: "from fallback", source: "fallbackText" });
  });

  it("uses the selected text when nothing else is given", async () => {
    await expect(resolveCaptureText({ argument: "", getSelectedText: selection("picked") })).resolves.toEqual({
      text: "picked",
      source: "selection",
    });
  });

  it("creates an empty note when there is no selection", async () => {
    await expect(resolveCaptureText({ getSelectedText: noSelection })).resolves.toEqual({ text: "", source: "empty" });
    await expect(resolveCaptureText({ getSelectedText: selection("  \n ") })).resolves.toEqual({
      text: "",
      source: "empty",
    });
  });

  it("does not read the selection when an earlier source has text", async () => {
    const read = vi.fn(selection("never"));
    await resolveCaptureText({ argument: "given", getSelectedText: read });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("create-note command", () => {
  beforeEach(() => {
    createNote.mockClear();
    contentFromMarkdown.mockClear();
    showFailureToast.mockClear();
    vi.mocked(closeMainWindow).mockClear();
  });

  async function runCommand(props: object) {
    const { default: command } = await import("../create-note");
    await command(props as Parameters<typeof command>[0]);
  }

  it("builds full content with core and creates the note with show: true", async () => {
    await runCommand({ arguments: { text: "# Hello\nworld" }, launchType: "userInitiated" });
    expect(contentFromMarkdown).toHaveBeenCalledWith("# Hello\nworld");
    expect(createNote).toHaveBeenCalledWith(
      {
        rawContent: JSON.stringify({ type: "doc", markdown: "# Hello\nworld" }),
        markdown: "# Hello\nworld",
        text: "# Hello\nworld",
        title: "# Hello",
      },
      { show: true },
    );
    expect(closeMainWindow).toHaveBeenCalled();
  });

  it("follows the launch context, then the fallback text, then the selection", async () => {
    await runCommand({ arguments: { text: "" }, launchContext: { text: "ctx" }, fallbackText: "fb" });
    expect(contentFromMarkdown).toHaveBeenLastCalledWith("ctx");

    await runCommand({ arguments: { text: "" }, fallbackText: "fb" });
    expect(contentFromMarkdown).toHaveBeenLastCalledWith("fb");

    vi.mocked(getSelectedText).mockResolvedValueOnce("selected words");
    await runCommand({ arguments: { text: "" } });
    expect(contentFromMarkdown).toHaveBeenLastCalledWith("selected words");

    await runCommand({ arguments: {} });
    expect(contentFromMarkdown).toHaveBeenLastCalledWith("");
  });

  it("ignores a launch context whose text is not a string", async () => {
    await runCommand({ arguments: { text: "arg" }, launchContext: { text: 42 } });
    expect(contentFromMarkdown).toHaveBeenLastCalledWith("arg");
  });

  it("shows a failure toast when the helper call fails", async () => {
    createNote.mockRejectedValueOnce(new Error("helper down"));
    await runCommand({ arguments: { text: "x" } });
    expect(showFailureToast).toHaveBeenCalledWith(expect.any(Error), { title: "Could not create a note" });
  });
});
