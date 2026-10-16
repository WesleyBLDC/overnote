/** A stand-in for @raycast/utils in the command end-to-end tests (vitest alias). */
import { shown } from "./raycast-api";

export async function showFailureToast(error: unknown, options?: { title?: string }): Promise<void> {
  shown.push(`failure: ${options?.title ?? ""}: ${error instanceof Error ? error.message : String(error)}`);
}
