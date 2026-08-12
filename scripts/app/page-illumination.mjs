/* Page illumination — the sigil behind the Review frontispiece.
 *
 * Review is the one leaf that is a frontispiece rather than a working page: it
 * presents a finished character instead of offering choices, so it has room for
 * a figure behind its content. It gets a sigil drawn from the character's own
 * name, which means the same character always sits on the same figure.
 *
 * This module started out bleeding the compendium's artwork behind every pick
 * step's head, chosen on an availability rule. That is gone. In practice the
 * item images are emblems (classes) or alpha cutouts (species) rather than the
 * scenes the design assumed — an emblem bled behind a title reads as a
 * watermark, and a cutout floats rather than bleeds because it has no ground in
 * it to fade out. Neither survived cropping and scrimming. The heads are also
 * compact now, which leaves no room behind them for a figure regardless.
 *
 * What is left is deliberately narrow: one sigil, on one leaf, with nothing
 * competing with it.
 */

/**
 * Turn a name into a stable set of sigil parameters, so the same character
 * always draws the same figure and two rarely share one.
 * @param {string} name
 * @returns {{points: number, skip: number, rings: number}}
 */
function sigilSpec(name) {
  let h = 0;
  for ( let i = 0; i < name.length; i++ ) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return {
    points: 5 + (h % 5),                 // 5..9
    skip: 2 + (Math.floor(h / 5) % 2),   // 2..3, always under points/2 for that range
    rings: 2 + (Math.floor(h / 11) % 3)  // 2..4
  };
}

/**
 * Draw the sigil. Static by design — an ambient rotation would pull the eye
 * away from the character sheet it sits behind.
 * @param {HTMLCanvasElement} cv
 */
function drawSigil(cv) {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if ( !w || !h ) return;

  const { points, skip, rings } = sigilSpec(cv.dataset.seed ?? "");
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);

  const g = cv.getContext("2d");
  if ( !g ) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  // Read the palette rather than hard-coding it. These strokes were still being drawn in
  // the violet and gold the creator used before the colour system was made semantic, which
  // no amount of looking at the stylesheet would have revealed. Taking the tokens from the
  // live element means the figure follows the palette from now on. `globalAlpha` carries
  // the weighting so the token can stay a plain hex value.
  const styles = getComputedStyle(cv);
  const brass = styles.getPropertyValue("--cc-settled").trim() || "#c9a227";
  const teal = styles.getPropertyValue("--cc-open").trim() || "#4fb3a8";

  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) * 0.46;

  // Concentric rings — brass outermost, teal within.
  for ( let r = 0; r < rings; r++ ) {
    g.beginPath();
    g.arc(cx, cy, R * (1 - r * 0.17), 0, Math.PI * 2);
    g.strokeStyle = r === 0 ? brass : teal;
    g.globalAlpha = r === 0 ? 0.45 : 0.26;
    g.lineWidth = r === 0 ? 1.25 : 1;
    g.stroke();
  }

  // Tick marks around the outer ring, longer every fourth.
  const ticks = points * 8;
  g.strokeStyle = brass;
  g.globalAlpha = 0.34;
  g.lineWidth = 1;
  for ( let t = 0; t < ticks; t++ ) {
    const a = (t / ticks) * Math.PI * 2 - Math.PI / 2;
    const inner = R * 1.02;
    const outer = R * (t % 4 === 0 ? 1.09 : 1.05);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    g.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    g.stroke();
  }

  // The star polygon {points/skip}.
  const pr = R * (1 - (rings - 1) * 0.17);
  g.beginPath();
  for ( let i = 0; i <= points; i++ ) {
    const ang = (((i * skip) % points) / points) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(ang) * pr;
    const y = cy + Math.sin(ang) * pr;
    if ( i === 0 ) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.strokeStyle = brass;
  g.globalAlpha = 0.38;
  g.lineWidth = 1.15;
  g.stroke();

  // Radial spokes out to the vertices.
  g.strokeStyle = teal;
  g.globalAlpha = 0.2;
  for ( let p = 0; p < points; p++ ) {
    const pa = (p / points) * Math.PI * 2 - Math.PI / 2;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(pa) * R, cy + Math.sin(pa) * R);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/**
 * Put the sigil behind the Review portrait. Safe to call on every render: it
 * clears the previous pass first, so repeated renders never stack figures.
 * @param {HTMLElement} root  The application's root element.
 */
export function illuminatePages(root) {
  for ( const frame of root.querySelectorAll(".creator-review-portrait") ) {
    for ( const old of frame.querySelectorAll(".creator-page-sigil") ) old.remove();

    const cv = document.createElement("canvas");
    cv.className = "creator-page-sigil";
    // Seed from the character's name where there is one, so the figure is
    // theirs; the portrait's alt/src is a poor seed and changes with the image.
    cv.dataset.seed = root.querySelector("[name='name']")?.value?.trim()
      || frame.closest(".creator-review")?.querySelector("h2")?.textContent?.trim()
      || "";
    cv.setAttribute("aria-hidden", "true");
    frame.prepend(cv);
    // Lay out first, then measure: the canvas has no size until it is in flow.
    requestAnimationFrame(() => drawSigil(cv));
  }
}
