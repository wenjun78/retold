'use strict';
// Sets a translation into a region of the page on a canvas: lines centred in a diamond
// for left-to-right text, columns right to left for Chinese and Japanese set top to
// bottom, in the size, weight, colour and outline of the original lettering.
window.Lettering = (() => {
  const { layout, languages } = window.Gloss;
  const LATIN = '"CC Wild Words", "Anime Ace 2.0 BB", "Komika Axis", "Bangers", "Comic Sans MS", "Segoe UI", Arial, sans-serif';
  const CJK = { 'zh-Hans': '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif', 'zh-Hant': '"Noto Sans CJK TC", "Source Han Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif', ja: '"Noto Sans CJK JP", "Source Han Sans", "Yu Gothic UI", "Meiryo", "Hiragino Sans", sans-serif', ko: '"Noto Sans CJK KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif' };

  function familyFor(target, settings = {}) {
    if (languages.isCjk(target)) return settings.fontCjk ? `"${settings.fontCjk}", ${CJK[target] || CJK.ja}` : (CJK[target] || CJK.ja);
    return settings.fontLatin ? `"${settings.fontLatin}", ${LATIN}` : LATIN;
  }

  const font = (size, family, bold) => `${bold ? 'bold ' : ''}${size}px ${family}`;

  // ctx is only used for measuring here.
  function measurer(ctx, family, bold) {
    return (size) => { ctx.font = font(size, family, bold); return (s) => ctx.measureText(s).width; };
  }

  // region: { x, y, w, h, style, orientation, target }; opts: { target, direction, mimic, caps, settings }.
  // Returns the plan to draw, with the chosen size and direction.
  function plan(ctx, region, text, opts) {
    const t = opts.caps && !languages.isCjk(opts.target) ? text.toUpperCase() : text;
    const style = region.style || {};
    const bold = opts.mimic ? Boolean(style.bold) : true;
    const family = familyFor(opts.target, opts.settings);
    const direction = languages.directionFor(opts.target, opts.direction, region.orientation);
    const maxSize = opts.mimic && style.size ? Math.round(style.size * 1.15) : 200;
    const padding = region.kind === 'bubble' ? 0.1 : 0.04;
    const p = layout.fit({ text: t, box: { w: region.w, h: region.h }, measure: measurer(ctx, family, bold), cjk: languages.isCjk(opts.target), direction, minSize: 7, maxSize, padding });
    return { ...p, family, bold, color: opts.mimic && style.colorHex ? style.colorHex : '#111111', outline: opts.mimic && style.outline ? (style.outlineHex || '#ffffff') : null };
  }

  function draw(ctx, region, p) {
    ctx.save();
    ctx.font = font(p.size, p.family, p.bold);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const stroke = p.outline ? Math.max(2, p.size * 0.14) : 0;
    const put = (s, x, y) => {
      if (stroke) { ctx.lineWidth = stroke; ctx.strokeStyle = p.outline; ctx.strokeText(s, x, y); }
      ctx.fillStyle = p.color; ctx.fillText(s, x, y);
    };
    const cx = region.x + region.w / 2, cy = region.y + region.h / 2;
    if (p.direction === 'vertical') {
      const step = p.size * p.columnGap;
      const totalW = p.columns.length * step - (step - p.size);
      let x = cx + totalW / 2 - p.size / 2; // first column is the rightmost
      const top = cy - p.height / 2;
      for (const col of p.columns) {
        let y = top;
        for (const item of col) {
          if (item.gap) { y += item.h; continue; }
          if (item.rotate) {
            ctx.save(); ctx.translate(x, y + item.h / 2); ctx.rotate(Math.PI / 2); put(item.ch, 0, 0); ctx.restore();
          } else put(item.ch, x, y + item.h / 2 + (item.closing && /[︐︑︒]/.test(item.ch) ? -p.size * 0.2 : 0));
          y += item.h;
        }
        x -= step;
      }
    } else {
      const lh = p.size * p.lineHeight;
      let y = cy - (p.lines.length * lh) / 2 + lh / 2;
      for (const line of p.lines) { put(line.text, cx, y); y += lh; }
    }
    ctx.restore();
  }

  return { plan, draw, familyFor };
})();
