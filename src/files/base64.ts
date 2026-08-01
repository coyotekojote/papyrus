/**
 * Base64 for the one place the app needs it: handing a clip's PNG to the Rust
 * side, whose IPC carries command arguments as JSON.
 *
 * `FileReader` does the encoding in the engine rather than in JS, so a
 * multi-megabyte clip costs neither a chunking loop nor a spread of the whole
 * byte array onto the call stack (which `btoa(String.fromCharCode(...))` does,
 * and which throws once the image gets big enough).
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read the image"));
    reader.onload = () => {
      const url = reader.result;
      if (typeof url !== "string") {
        reject(new Error("Failed to encode the image"));
        return;
      }
      // "data:image/png;base64,AAAA" — everything up to the comma is the
      // media type the caller already knows.
      const comma = url.indexOf(",");
      resolve(comma < 0 ? "" : url.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}
