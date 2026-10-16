import { closeMainWindow, showHUD } from "@raycast/api";

import { ensureHelper } from "./api/helper";
import { errorMessage } from "./domain/errors";

/**
 * Shows the floating panel on the note you last had open, and focuses it. Unlike Toggle Overnote
 * it never hides the panel. Success is silent; only errors produce a HUD.
 */
export default async function OpenNotes() {
  try {
    await closeMainWindow();
    const { client, started } = await ensureHelper({ show: true });
    if (!started) await client.call("window.show", {});
  } catch (error) {
    await showHUD(`Overnote: ${errorMessage(error)}`);
  }
}
