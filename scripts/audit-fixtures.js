/**
 * Audit fixtures: one reference article rendered into every supported format.
 * Sentinels: AUDITMARK-ONE (first page), AUDITMARK-LAST (last paragraph),
 * diacritics probe, tables, SVG charts, an embedded PNG image.
 * Output: <TEMP audit dir>/fixtures/
 */
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const OUT = path.join(process.env.TEMP, "rd-audit-fixtures");
fs.mkdirSync(OUT, { recursive: true });

const DIA = "Cercetătorii înțeleg știința țărilor europene — ă î ș ț é ü ö.";
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGNk+M9AGmAaVT+qnhAAAJdcAf9ptZ1DAAAAAElFTkSuQmCC";

function para(n) {
  return (
    `Section paragraph ${n}. Deep reading requires sustained attention to structure, not just vocabulary. ` +
    `The reader moves between local questions and global architecture, and every marginal note is a commitment. ` +
    `We repeat this paragraph family with small variations to give the document realistic length, so that ` +
    `pagination, scrolling, virtualisation and text extraction are all exercised end to end without shortcuts. ` +
    `Measurement beats intuition; a claim about rendering fidelity is only as good as the pixels behind it.`
  );
}

function barChart() {
  const bars = [62, 78, 45, 91, 70, 55]
    .map(
      (v, i) =>
        `<rect x="${30 + i * 55}" y="${180 - v * 1.6}" width="38" height="${v * 1.6}" fill="#4a6f8a"/>` +
        `<text x="${49 + i * 55}" y="196" font-size="10" text-anchor="middle" fill="#444">G${i + 1}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="210" viewBox="0 0 380 210"><rect width="380" height="210" fill="#fbfbf9"/><line x1="25" y1="180" x2="365" y2="180" stroke="#999"/>${bars}</svg>`;
}

const SECTIONS = [
  { h: "Abstract", ps: [`AUDITMARK-ONE This audit reference document verifies faithful ingestion. ${DIA}`, para(1)] },
  { h: "1. Introduction", ps: [para(2), para(3), para(4)] },
  { h: "2. Method", ps: [para(5), para(6), para(7), para(8)] },
  { h: "3. Results", ps: [para(9), para(10), para(11), para(12)] },
  { h: "4. Discussion", ps: [para(13), para(14), para(15), para(16)] },
  { h: "5. Conclusion", ps: [para(17), `Closing statement with the final sentinel AUDITMARK-LAST placed at the very end.`] },
];

const TABLE = [
  ["Condition", "Assistance", "Context window", "N"],
  ["Control", "Separate chat", "Whole document", "156"],
  ["Treatment", "Margin threads", "600 chars", "156"],
];

/* ---------- HTML (also the Gotenberg source for the PDF) ---------- */
function buildHtml() {
  const tbl =
    "<table border='1' cellspacing='0' cellpadding='4'>" +
    TABLE.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join("")}</tr>`).join("") +
    "</table>";
  const body = SECTIONS.map(
    (s, i) =>
      `<h2>${s.h}</h2>` +
      s.ps.map((p) => `<p>${p}</p>`).join("") +
      (i === 2 ? tbl : "") +
      (i === 3 ? barChart() + `<p><img src="data:image/png;base64,${PNG_1PX}" width="120" height="80" alt="probe"/></p>` : ""),
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Audit Reference</title></head><body><h1>Audit Reference Document</h1>${body}</body></html>`;
}

/* ---------- plain text / markdown ---------- */
function buildTxt() {
  return (
    "Audit Reference Document\n\n" +
    SECTIONS.map((s) => `${s.h}\n\n${s.ps.join("\n\n")}`).join("\n\n") +
    "\n"
  );
}

/* ---------- RTF ---------- */
function buildRtf() {
  const esc = (t) =>
    t.replace(/[\\{}]/g, (m) => "\\" + m).replace(/[^\x00-\x7F]/g, (ch) => `\\u${ch.codePointAt(0)}?`);
  const paras = SECTIONS.flatMap((s) => [`\\b ${esc(s.h)}\\b0`, ...s.ps.map(esc)]);
  return `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\f0\\fs24 ${paras.join("\\par\n")}\\par }`;
}

/* ---------- DOCX (minimal OOXML) ---------- */
async function buildDocx() {
  const zip = new JSZip();
  const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const tbl =
    `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/><w:bottom w:val="single"/></w:tblBorders></w:tblPr>` +
    TABLE.map(
      (r) => `<w:tr>${r.map((c) => `<w:tc><w:tcPr/><w:p><w:r><w:t>${esc(c)}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`,
    ).join("") +
    `</w:tbl>`;
  const bodyXml =
    p("Audit Reference Document") +
    SECTIONS.map((s, i) => p(s.h) + s.ps.map(p).join("") + (i === 2 ? tbl : "")).join("") +
    `<w:sectPr/>`;
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${w}"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

/* ---------- ODT (minimal ODF) ---------- */
async function buildOdt() {
  const zip = new JSZip();
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.file("mimetype", "application/vnd.oasis.opendocument.text", { compression: "STORE" });
  zip.file(
    "META-INF/manifest.xml",
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
  );
  const body =
    `<text:h text:outline-level="1">Audit Reference Document</text:h>` +
    SECTIONS.map(
      (s) => `<text:h text:outline-level="2">${esc(s.h)}</text:h>` + s.ps.map((p) => `<text:p>${esc(p)}</text:p>`).join(""),
    ).join("");
  zip.file(
    "content.xml",
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

/* ---------- EPUB ---------- */
async function buildEpub() {
  const zip = new JSZip();
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const chapters = SECTIONS.map((s, i) => ({
    id: `c${i + 1}`,
    file: `chap${i + 1}.xhtml`,
    html: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(s.h)}</title></head><body><h1>${esc(s.h)}</h1>${s.ps.map((p) => `<p>${esc(p)}</p>`).join("")}${i === 3 ? `<p><img src="probe.png" alt="probe"/></p>` : ""}</body></html>`,
  }));
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">audit-1</dc:identifier><dc:title>Audit Reference Document</dc:title><dc:language>en</dc:language></metadata><manifest>${chapters.map((c) => `<item id="${c.id}" href="${c.file}" media-type="application/xhtml+xml"/>`).join("")}<item id="img1" href="probe.png" media-type="image/png"/></manifest><spine>${chapters.map((c) => `<itemref idref="${c.id}"/>`).join("")}</spine></package>`,
  );
  for (const c of chapters) zip.file(`OEBPS/${c.file}`, c.html);
  zip.file("OEBPS/probe.png", PNG_1PX, { base64: true });
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

/* ---------- PDF via Gotenberg chromium ---------- */
async function buildPdf(html) {
  const fd = new FormData();
  fd.append("files", new Blob([html], { type: "text/html" }), "index.html");
  const res = await fetch("http://localhost:3010/forms/chromium/convert/html", { method: "POST", body: fd });
  if (!res.ok) throw new Error(`gotenberg ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  const html = buildHtml();
  const txt = buildTxt();
  fs.writeFileSync(path.join(OUT, "audit.html"), html);
  fs.writeFileSync(path.join(OUT, "audit.txt"), txt);
  fs.writeFileSync(path.join(OUT, "audit.md"), "# Audit Reference Document\n\n" + txt);
  fs.writeFileSync(path.join(OUT, "audit.rtf"), buildRtf());
  fs.writeFileSync(path.join(OUT, "audit.docx"), await buildDocx());
  fs.writeFileSync(path.join(OUT, "audit.odt"), await buildOdt());
  fs.writeFileSync(path.join(OUT, "audit.epub"), await buildEpub());
  fs.writeFileSync(path.join(OUT, "bad.xyz"), "not a supported document format");
  try {
    fs.writeFileSync(path.join(OUT, "audit.pdf"), await buildPdf(html));
  } catch (e) {
    console.error("PDF build failed:", e.message);
  }
  for (const f of fs.readdirSync(OUT)) {
    console.log(f, fs.statSync(path.join(OUT, f)).size, "bytes");
  }
  console.log("OUT:", OUT);
})();
