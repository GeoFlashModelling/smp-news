import type { Section } from "../config/sources.js";

/**
 * S.M.P. section artwork: the picture a story gets when no free-licensed photo of its subject exists.
 * Brand family style (00_NSR_Branding/Brand_Notes.md): navy gradient, steel-blue symbol, one gold accent.
 * Gradients use canvas coordinates: bounding-box gradients don't paint straight horizontal or vertical strokes.
 */
const STEEL = "url(#steel)";
const GOLD = "url(#gold)";

const SYMBOLS: Record<Section, string> = {
  // Southern Cross
  australia: [
    [326, 58, 30], [304, 296, 36], [222, 176, 30], [412, 142, 25], [368, 214, 15],
  ].map(([x, y, r], i) => star(x!, y!, r!, i === 1 ? GOLD : STEEL)).join(""),
  // Sun setting over the Indian Ocean
  "local-wa": `<path d="M240 200a80 80 0 0 1 160 0z" fill="${GOLD}"/>
${[0, 1, 2].map((i) => `<path d="M${180 + i * 20} ${222 + i * 22} q35 -14 70 0 t70 0 t70 0 t70 0" stroke="${STEEL}" stroke-width="8" fill="none" stroke-linecap="round"/>`).join("")}`,
  // Globe with a gold orbit, as in the S.M.P. browser icon
  world: `<circle cx="320" cy="180" r="100" fill="${STEEL}"/>
<g stroke="#dcebf3" stroke-opacity=".5" stroke-width="3" fill="none"><ellipse cx="320" cy="180" rx="45" ry="100"/><path d="M220 180h200M235 130h170M235 230h170M320 80v200"/></g>
<ellipse cx="320" cy="180" rx="150" ry="44" transform="rotate(-18 320 180)" stroke="${GOLD}" stroke-width="9" fill="none"/>
<circle cx="458" cy="134" r="12" fill="${GOLD}" stroke="#162939" stroke-width="4"/>`,
  // Parliament: dome, columns, steps
  politics: `<path d="M240 150a80 62 0 0 1 160 0z" fill="${GOLD}"/><rect x="314" y="58" width="12" height="32" fill="${GOLD}"/>
<rect x="220" y="150" width="200" height="16" fill="${STEEL}"/>
${[0, 1, 2, 3, 4].map((i) => `<rect x="${236 + i * 38}" y="172" width="20" height="80" rx="3" fill="${STEEL}"/>`).join("")}
<rect x="205" y="256" width="230" height="16" fill="${STEEL}"/><rect x="190" y="276" width="260" height="16" fill="${STEEL}"/>`,
  // Rising bars and trend line
  business: `${[0, 1, 2, 3].map((i) => `<rect x="${218 + i * 56}" y="${232 - i * 40}" width="38" height="${60 + i * 40}" rx="4" fill="${STEEL}"/>`).join("")}
<path d="M205 222 L265 182 L318 196 L380 130 L440 96" stroke="${GOLD}" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="440" cy="96" r="12" fill="${GOLD}" stroke="#162939" stroke-width="4"/>`,
  // Atom
  "science-tech": `${[0, 60, 120].map((a) => `<ellipse cx="320" cy="180" rx="118" ry="40" transform="rotate(${a} 320 180)" stroke="${STEEL}" stroke-width="9" fill="none"/>`).join("")}
<circle cx="320" cy="180" r="22" fill="${GOLD}" stroke="#162939" stroke-width="4"/>`,
  // Oval football with laces
  sport: `<ellipse cx="320" cy="180" rx="130" ry="82" transform="rotate(-24 320 180)" fill="${STEEL}"/>
<path d="M232 210 Q320 150 408 150" stroke="#dcebf3" stroke-opacity=".6" stroke-width="5" fill="none"/>
<g transform="rotate(-24 320 180)" stroke="${GOLD}" stroke-width="7" stroke-linecap="round">${[0, 1, 2, 3, 4].map((i) => `<path d="M${290 + i * 15} 166v28"/>`).join("")}<path d="M282 180h76"/></g>`,
  // Screen with a play button
  entertainment: `<rect x="200" y="90" width="240" height="160" rx="16" fill="${STEEL}"/>
<path d="M300 132 L362 170 L300 208z" fill="${GOLD}"/>
<rect x="280" y="262" width="80" height="12" rx="6" fill="${STEEL}"/>`,
  // Sun with rays
  "feel-good": `<g stroke="${STEEL}" stroke-width="10" stroke-linecap="round">${Array.from({ length: 12 }, (_, i) => {
    const a = (i * Math.PI) / 6;
    const p = (r: number) => `${(320 + r * Math.cos(a)).toFixed(1)} ${(180 + r * Math.sin(a)).toFixed(1)}`;
    return `<path d="M${p(86)} L${p(122)}"/>`;
  }).join("")}</g>
<circle cx="320" cy="180" r="64" fill="${GOLD}"/>`,
};

function star(cx: number, cy: number, r: number, fill: string): string {
  const pts = Array.from({ length: 14 }, (_, i) => {
    const a = (i * Math.PI) / 7 - Math.PI / 2;
    const rr = i % 2 === 0 ? r : r * 0.45;
    return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`;
  });
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
}

export function sectionArtwork(section: Section): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1D3A4D"/><stop offset="1" stop-color="#162939"/></linearGradient>
<radialGradient id="steel" gradientUnits="userSpaceOnUse" cx="270" cy="110" r="260"><stop offset="0" stop-color="#8CC0DB"/><stop offset=".45" stop-color="#3E8AB4"/><stop offset=".8" stop-color="#2E6E93"/><stop offset="1" stop-color="#1D3A4D"/></radialGradient>
<linearGradient id="gold" gradientUnits="userSpaceOnUse" x1="200" y1="60" x2="440" y2="300"><stop offset="0" stop-color="#936C1C"/><stop offset=".5" stop-color="#D9C08A"/><stop offset="1" stop-color="#B8A37C"/></linearGradient>
</defs>
<rect width="640" height="360" fill="url(#bg)"/>
${SYMBOLS[section]}
</svg>
`;
}
