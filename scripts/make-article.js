// Dev fixture: a scientific-looking article with charts, tables and figures.
const fs = require("fs");

function barChart() {
  const bars = [62, 78, 45, 91, 70, 55].map(
    (v, i) =>
      `<rect x="${30 + i * 55}" y="${180 - v * 1.6}" width="38" height="${v * 1.6}" fill="#4a6f8a"/>` +
      `<text x="${49 + i * 55}" y="196" font-size="10" text-anchor="middle" fill="#444">G${i + 1}</text>` +
      `<text x="${49 + i * 55}" y="${174 - v * 1.6}" font-size="9" text-anchor="middle" fill="#222">${v}</text>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="210" viewBox="0 0 380 210">
    <rect width="380" height="210" fill="#fbfbf9"/>
    <line x1="25" y1="180" x2="365" y2="180" stroke="#999"/>
    <text x="12" y="105" font-size="10" fill="#666" transform="rotate(-90 12 105)">Accuracy (%)</text>
    ${bars.join("")}
  </svg>`;
}

function lineChart() {
  const pts = [20, 34, 31, 52, 61, 58, 75, 84, 80, 95];
  const path = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${35 + i * 33} ${175 - v * 1.5}`).join(" ");
  const dots = pts
    .map((v, i) => `<circle cx="${35 + i * 33}" cy="${175 - v * 1.5}" r="3" fill="#8a4a55"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="200" viewBox="0 0 380 200">
    <rect width="380" height="200" fill="#fbfbf9"/>
    <line x1="30" y1="175" x2="368" y2="175" stroke="#999"/>
    <line x1="30" y1="15" x2="30" y2="175" stroke="#999"/>
    <path d="${path}" fill="none" stroke="#8a4a55" stroke-width="2"/>
    ${dots}
    <text x="200" y="195" font-size="10" text-anchor="middle" fill="#666">Training epoch</text>
  </svg>`;
}

function scatter() {
  let seed = 42;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const points = Array.from({ length: 40 }, () => {
    const x = 40 + rnd() * 300;
    const y = 170 - (x - 40) * 0.35 - rnd() * 40;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="#3d5c46" opacity="0.75"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="200" viewBox="0 0 380 200">
    <rect width="380" height="200" fill="#fbfbf9"/>
    <line x1="30" y1="175" x2="368" y2="175" stroke="#999"/>
    <line x1="30" y1="15" x2="30" y2="175" stroke="#999"/>
    <line x1="40" y1="170" x2="340" y2="65" stroke="#b0b0b0" stroke-dasharray="4 3"/>
    ${points}
    <text x="200" y="195" font-size="10" text-anchor="middle" fill="#666">Context length (tokens)</text>
  </svg>`;
}

function pipelineDiagram() {
  const box = (x, label) =>
    `<rect x="${x}" y="70" width="90" height="44" rx="6" fill="#fff" stroke="#555"/>` +
    `<text x="${x + 45}" y="96" font-size="11" text-anchor="middle" fill="#222">${label}</text>`;
  const arrow = (x) => `<path d="M ${x} 92 L ${x + 22} 92" stroke="#555" marker-end="url(#a)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="180" viewBox="0 0 480 180">
    <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#555"/></marker></defs>
    <rect width="480" height="180" fill="#fbfbf9"/>
    <text x="240" y="40" font-size="12" text-anchor="middle" fill="#333" font-weight="bold">Deep-reading annotation pipeline</text>
    ${box(20, "Document")}${arrow(112)}${box(136, "Text layer")}${arrow(228)}${box(252, "Highlights")}${arrow(344)}${box(368, "AI margin")}
  </svg>`;
}

const html = `<!doctype html>
<html><head><title>Margin-Anchored AI Assistance and Reading Comprehension</title></head><body>
<h1>Margin-Anchored AI Assistance and Reading Comprehension: A Controlled Study</h1>
<p><em>A. Cercet&#259;toru, B. Lector, C. Adnotatoru — Institute of Reading Sciences</em></p>

<h2>Abstract</h2>
<p>We study whether anchoring AI conversations to exact passages改 improves comprehension of dense documents. Across six participant groups (N = 312), margin-anchored assistance produced a 23% mean improvement in comprehension scores relative to a chat-in-separate-window control, with the largest gains on legal and scientific material. We further find that passage-level context windows of roughly 600 characters balance answer specificity against token cost.</p>

<h2>1. Introduction</h2>
<p>Readers of contracts, regulations and scientific papers rarely fail on vocabulary; they fail on structure. The question that matters mid-paragraph is local — what does <em>this</em> clause mean, why is <em>this</em> coefficient negative — and generic chat interfaces force the reader to reconstruct that locality by hand. We hypothesise that binding each conversation to the exact highlighted span removes this reconstruction cost.</p>

<p>Figure 1 summarises comprehension accuracy by participant group under margin-anchored assistance.</p>
${barChart()}
<p>As Figure 1 shows, groups G4 and G6 — both composed of professional readers — reached the highest accuracy, while G3 (first-year students) benefited least in absolute terms but most relative to baseline.</p>

<h2>2. Method</h2>
<p>Participants read three documents (a commercial lease, an EU regulation excerpt, and a methods section from a biology paper) under one of two conditions. Table 1 lists the experimental conditions and their parameters.</p>
<table>
  <tr><th>Condition</th><th>Assistance</th><th>Context window</th><th>N</th></tr>
  <tr><td>Control</td><td>Separate chat window</td><td>Whole document</td><td>156</td></tr>
  <tr><td>Treatment</td><td>Margin-anchored threads</td><td>&#177;600 chars around highlight</td><td>156</td></tr>
</table>
<p>Comprehension was scored with a 40-item test written before assistance conditions were assigned. Scoring was blind.</p>

<p>The full annotation pipeline used in the treatment condition is sketched below.</p>
${pipelineDiagram()}

<h2>3. Results</h2>
<p>Learning curves under the treatment condition are shown in Figure 3: accuracy rises steadily across training epochs of the underlying retrieval model.</p>
${lineChart()}
<p>Table 2 breaks down the mean comprehension gain by document type. The effect is strongest precisely where baseline comprehension is weakest.</p>
<table>
  <tr><th>Document type</th><th>Baseline (%)</th><th>With margin AI (%)</th><th>Gain</th><th>p</th></tr>
  <tr><td>Commercial lease</td><td>48.2</td><td>66.9</td><td>+18.7</td><td>&lt;0.001</td></tr>
  <tr><td>EU regulation</td><td>41.5</td><td>63.0</td><td>+21.5</td><td>&lt;0.001</td></tr>
  <tr><td>Biology methods</td><td>55.4</td><td>71.2</td><td>+15.8</td><td>0.003</td></tr>
</table>

<p>Finally, the relationship between context length and answer usefulness is non-linear, as the scatter in Figure 4 indicates: usefulness saturates near 600 characters of surrounding context.</p>
${scatter()}

<h2>4. Discussion</h2>
<p>Anchoring is not a UI nicety; it is a context-engineering decision. The margin thread inherits exactly the locality the reader is struggling with, which the model would otherwise have to guess. Our results suggest the guessing is expensive: the control condition consumed 2.4&#215; more tokens per resolved question while scoring lower.</p>
<p>Limitations include a single-session design and self-selected professional readers. Future work should examine retention after one week and interaction with note-taking behaviour.</p>

<h2>5. Conclusion</h2>
<p>Margin-anchored AI assistance reliably improves comprehension of dense documents, with the greatest benefit on unfamiliar legal material. Passage-level context of about 600 characters is a practical sweet spot.</p>
</body></html>`;

fs.writeFileSync(process.env.TEMP + "/article.html", html, "utf-8");
console.log("article written:", (html.length / 1024).toFixed(1) + " KB");
