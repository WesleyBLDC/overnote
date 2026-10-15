import { closeMainWindow, getSelectedText, type LaunchProps } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { contentFromMarkdown } from "./api/content";
import { createNote } from "./api/notes";
import { resolveCaptureText } from "./domain/capture";

type CreateContext = { text?: unknown };

/** Creates a note from the launch context, argument, fallback text, or selection, and shows it. */
export default async function CreateNote(
  props: LaunchProps<{ arguments: Arguments.CreateNote; launchContext?: CreateContext }>,
) {
  try {
    const contextText = typeof props.launchContext?.text === "string" ? props.launchContext.text : undefined;
    const { text } = await resolveCaptureText({
      contextText,
      argument: props.arguments.text,
      fallbackText: props.fallbackText,
      getSelectedText,
    });
    await closeMainWindow();
    await createNote(contentFromMarkdown(text), { show: true });
  } catch (error) {
    await showFailureToast(error, { title: "Could not create a note" });
  }
}
