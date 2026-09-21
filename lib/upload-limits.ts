/**
 * Upload size limit, shared by the client panels and the documents route.
 * Cloud Run caps request bodies at 32MB — keep the product limit safely under.
 * Override with NEXT_PUBLIC_MAX_UPLOAD_MB (client + server) if ever needed.
 */
export const MAX_UPLOAD_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB ?? "") || 25;

export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** The one friendly message both the client and the 413 response use. */
export function fileTooLargeMessage(sizeBytes: number): string {
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
  return `File is too large (${mb} MB). Maximum is ${MAX_UPLOAD_MB} MB.`;
}
