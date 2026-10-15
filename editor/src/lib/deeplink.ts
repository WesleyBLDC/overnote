/**
 * The extension deeplink that opens a note: Toggle Overnote with `{ id }` as launch context
 * (docs/architecture.md section 8). Raycast's documented deeplink parameter for the launch context is `context`.
 */
export const EXTENSION_AUTHOR = "wesleybldc";
export const EXTENSION_NAME = "overnote";

export function noteDeeplink(id: string): string {
  const context = encodeURIComponent(JSON.stringify({ id }));
  return `raycast://extensions/${EXTENSION_AUTHOR}/${EXTENSION_NAME}/toggle-notes?context=${context}`;
}
