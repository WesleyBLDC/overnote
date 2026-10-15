export const EXTENSION_OWNER = "wesleybldc";
export const EXTENSION_NAME = "overnote";

/** A deeplink that runs Toggle Overnote with `{ id }` as launch context, opening that note. */
export function noteDeeplink(noteId: string): string {
  const context = encodeURIComponent(JSON.stringify({ id: noteId }));
  return `raycast://extensions/${EXTENSION_OWNER}/${EXTENSION_NAME}/toggle-notes?context=${context}`;
}
