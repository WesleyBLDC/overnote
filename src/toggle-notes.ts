import { closeMainWindow, showHUD, type LaunchProps } from "@raycast/api";

import { ensureHelper } from "./api/helper";
import { errorMessage } from "./domain/errors";

type ToggleContext = { id?: unknown };

/**
 * Shows or hides the floating panel. A launch context `{ id }` (from Copy Deeplink or a quicklink)
 * shows that note instead. Success is silent; only errors produce a HUD.
 */
export default async function ToggleNotes(props: LaunchProps<{ launchContext?: ToggleContext }>) {
  try {
    const noteId = typeof props.launchContext?.id === "string" ? props.launchContext.id : undefined;
    await closeMainWindow();
    if (noteId) {
      const { client } = await ensureHelper();
      await client.call("window.show", { noteId });
      return;
    }
    const { client, started } = await ensureHelper({ show: true });
    if (!started) await client.call("window.toggle", {});
  } catch (error) {
    await showHUD(`Overnote: ${errorMessage(error)}`);
  }
}
