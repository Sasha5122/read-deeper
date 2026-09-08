/** Dev utility: build fixture files for each format and run the extractors. */
import JSZip from "jszip";
import { extractPages } from "../lib/extract";

async function buildEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Fixture Book</dc:title></metadata>
      <manifest>
        <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
        <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
      </manifest>
      <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
    </package>`,
  );
  zip.file(
    "OEBPS/chap1.xhtml",
    `<html><head><title>x</title></head><body><h1>Chapter One</h1><p>The first paragraph of the epub &amp; its friends.</p><p>Second paragraph here.</p></body></html>`,
  );
  zip.file(
    "OEBPS/chap2.xhtml",
    `<html><body><h1>Chapter Two</h1><p>Another chapter with <em>emphasis</em> and a<br/>line break.</p></body></html>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function buildOdt(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "content.xml",
    `<?xml version="1.0"?><office:document-content xmlns:office="x" xmlns:text="y">
      <office:body><office:text>
        <text:h>ODT Heading</text:h>
        <text:p>First odt paragraph with &amp; entity.</text:p>
        <text:p>Second<text:line-break/>with break.</text:p>
      </office:text></office:body>
    </office:document-content>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

const RTF = String.raw`{\rtf1\ansi\deff0 {\fonttbl {\f0 Times New Roman;}}{\colortbl;\red0\green0\blue0;}
\f0\fs24 Hello \b bold\b0  world.\par
Second paragraph with caf\'e9 accent.\par
{\*\generator Fixture 1.0}Third one after skipped group.\par }`;

const HTML = `<!doctype html><html><head><style>p{color:red}</style><script>var x=1;</script></head>
<body><h1>HTML Title</h1><p>Paragraph one &mdash; with dash.</p><ul><li>item a</li><li>item b</li></ul></body></html>`;

async function run() {
  const cases: [string, Buffer, Parameters<typeof extractPages>[1]][] = [
    ["epub", await buildEpub(), "epub"],
    ["odt", await buildOdt(), "odt"],
    ["rtf", Buffer.from(RTF, "utf-8"), "rtf"],
    ["html", Buffer.from(HTML, "utf-8"), "html"],
  ];
  for (const [name, buf, kind] of cases) {
    try {
      const pages = await extractPages(buf, kind);
      const preview = pages[0]?.text.slice(0, 200).replace(/\n/g, " | ");
      console.log(`✓ ${name}: ${pages.length} page(s) :: ${preview}`);
    } catch (err) {
      console.log(`✗ ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
void run();
