/**
 * Office-family → PDF conversion via Gotenberg (LibreOffice in Docker).
 * Run locally with:  docker run -d -p 3010:3000 gotenberg/gotenberg:8
 * In the cloud, set GOTENBERG_URL and (since the service is on the open
 * internet) GOTENBERG_AUTH="user:parola" matching the container's basic auth.
 */
function gotenbergHeaders(): Record<string, string> {
  const auth = process.env.GOTENBERG_AUTH;
  return auth ? { Authorization: `Basic ${Buffer.from(auth).toString("base64")}` } : {};
}

export async function convertToPdf(buffer: Buffer, filename: string): Promise<Buffer> {
  const base = process.env.GOTENBERG_URL ?? "http://127.0.0.1:3010";
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(buffer)]), filename);
  const res = await fetch(`${base}/forms/libreoffice/convert`, {
    method: "POST",
    body: form,
    headers: gotenbergHeaders(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`PDF conversion failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** HTML → PDF via Gotenberg's Chromium engine (used for fixtures/tests). */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const base = process.env.GOTENBERG_URL ?? "http://127.0.0.1:3010";
  const form = new FormData();
  form.append("files", new Blob([html], { type: "text/html" }), "index.html");
  const res = await fetch(`${base}/forms/chromium/convert/html`, {
    method: "POST",
    body: form,
    headers: gotenbergHeaders(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`HTML→PDF failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export const CONVERTIBLE_KINDS = new Set(["docx", "doc", "odt", "rtf"]);
