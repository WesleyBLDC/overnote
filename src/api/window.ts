import type { RpcParams, RpcResult } from "../domain/types";
import { callHelper } from "./helper";

/** A `window.place` placement, named exactly as the protocol names it on the wire. */
export type PanelPlacement = RpcParams<"window.place">["placement"];

/**
 * Shows the panel, then places it, in that order.
 * Each call goes through `callHelper`, so a helper that is not running is started first by the
 * same launcher path the other menu bar actions use, and the placement still lands after the show.
 */
export async function showAndPlace(placement: PanelPlacement): Promise<RpcResult<"window.place">> {
  await callHelper("window.show", {});
  return callHelper("window.place", { placement });
}
