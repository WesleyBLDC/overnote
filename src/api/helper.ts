import { environment } from "@raycast/api";

import { HelperLauncher, type EnsureOptions, type EnsureResult } from "../domain/launcher";
import { developmentAssetsPath, resolvePaths, type HelperPaths } from "../domain/paths";
import type { RpcMethod, RpcParams, RpcResult } from "../domain/types";

let launcher: HelperLauncher | null = null;

/** While `npm run dev` runs: the checkout's assets, so the panel follows every new build. */
function devAssetsPath(): string | null {
  return environment.isDevelopment ? developmentAssetsPath(environment.assetsPath) : null;
}

export function helperPaths(): HelperPaths {
  return resolvePaths({ supportPath: environment.supportPath, assetsPath: devAssetsPath() ?? environment.assetsPath });
}

export function getLauncher(): HelperLauncher {
  launcher ??= new HelperLauncher({ paths: helperPaths(), watchEditor: devAssetsPath() !== null });
  return launcher;
}

/** Starts the helper if needed (or restarts an outdated one) and returns the launch outcome. */
export function ensureHelper(options?: EnsureOptions): Promise<EnsureResult> {
  return getLauncher().ensure(options);
}

/** Calls a helper method, starting the helper first when it is not running. */
export async function callHelper<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  const { client } = await ensureHelper();
  return client.call(method, params);
}
