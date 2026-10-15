'use strict';
// Lifts the original lettering out of the picture, so the translation is set on clean
// ground. Inside a speech bubble that is simply the paper colour; anywhere else the hole
// is filled from its surroundings, layer by layer from the rim inwards, then softened.

// img is changed in place. region: { x, y, w, h }; mask: Uint8Array(w*h) of the pixels to
// fill; fill: [r,g,b] for a flat fill, or null to fill from the surroundings.
function inpaint(img, region, mask, fill = null) {
  const { data, width: W } = img;
  const w = region.w, h = region.h, x0 = region.x, y0 = region.y;
  if (fill) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const p = ((y0 + y) * W + x0 + x) * 4;
      data[p] = fill[0]; data[p + 1] = fill[1]; data[p + 2] = fill[2]; data[p + 3] = 255;
    }
    return;
  }
  // Onion peeling: each pass fills the masked pixels that touch an unmasked one with the
  // mean of their unmasked neighbours, then those count as unmasked for the next pass.
  const todo = mask.slice();
  let left = 0; for (let i = 0; i < todo.length; i++) if (todo[i]) left++;
  const layer = [];
  for (let pass = 0; left > 0 && pass < 4096; pass++) {
    layer.length = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!todo[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || todo[ny * w + nx]) continue;
        const px = x0 + nx, py = y0 + ny;
        if (px < 0 || py < 0 || px >= W || py >= img.height) continue;
        const p = (py * W + px) * 4;
        r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
      }
      if (n) layer.push(i, r / n, g / n, b / n);
    }
    if (!layer.length) break; // nothing borders the hole (mask covers the whole box)
    for (let k = 0; k < layer.length; k += 4) {
      const i = layer[k], x = i % w, y = (i - x) / w;
      const p = ((y0 + y) * W + x0 + x) * 4;
      data[p] = layer[k + 1]; data[p + 1] = layer[k + 2]; data[p + 2] = layer[k + 3]; data[p + 3] = 255;
      todo[i] = 0; left--;
    }
  }
  blurWithin(img, region, mask, 2);
}

// A small box blur applied only inside the mask, so the fill does not show its seams.
function blurWithin(img, region, mask, r) {
  const { data, width: W } = img;
  const w = region.w, h = region.h, x0 = region.x, y0 = region.y;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const px = x0 + nx, py = y0 + ny;
      if (px < 0 || py < 0 || px >= W || py >= img.height) continue;
      const p = (py * W + px) * 4;
      rr += data[p]; gg += data[p + 1]; bb += data[p + 2]; n++;
    }
    out[i * 3] = rr / n; out[i * 3 + 1] = gg / n; out[i * 3 + 2] = bb / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!mask[i]) continue;
    const p = ((y0 + y) * W + x0 + x) * 4;
    data[p] = out[i * 3]; data[p + 1] = out[i * 3 + 1]; data[p + 2] = out[i * 3 + 2];
  }
}

module.exports = { inpaint, blurWithin };
