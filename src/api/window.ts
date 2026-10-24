import type { RpcParams, RpcResult } from "../domain/types";
import { callHelper } from "./helper";

/** A `window.place` placement, named exactly as the protocol names it on the wire. */
export type PanelPlacement = RpcParams<"window.place">["placement"];

/**
 * Shows the panel, then places it, in that order. Both calls go through `callHelper`, the launcher
 * path every other command uses, so a helper that is not running starts first.
 */
export async function showAndPlace(placement: PanelPlacement): Promise<RpcResult<"window.place">> {
  await callHelper("window.show", {});
  return callHelper("window.place", { placement });
}
