/** The extension deeplink that opens a note (contract: toggle-notes accepts launchContext { id }). */
export const EXTENSION_AUTHOR = "wesleybldc";
export const EXTENSION_NAME = "overnote";

export function noteDeeplink(id: string): string {
  const context = encodeURIComponent(JSON.stringify({ id }));
  return `raycast://extensions/${EXTENSION_AUTHOR}/${EXTENSION_NAME}/toggle-notes?launchContext=${context}`;
}
