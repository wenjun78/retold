// Languages the app translates between. `ocr` names the Tesseract data for reading the
// language off an image; `vertical` adds the model for text set top to bottom (manga,
// traditional Chinese typesetting). `writes` is how the language is normally set when the
// app letters a translation: Chinese and Japanese run top to bottom inside a speech bubble
// (columns right to left), everything else left to right.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Gloss = root.Gloss || {}).languages = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const LANGUAGES = [
  { code: 'auto', name: 'Detect' },
  { code: 'en', name: 'English', ocr: 'eng', writes: 'horizontal' },
  { code: 'zh-Hans', name: 'Chinese (Simplified)', ocr: 'chi_sim', vertical: 'chi_sim_vert', writes: 'vertical', cjk: true },
  { code: 'zh-Hant', name: 'Chinese (Traditional)', ocr: 'chi_tra', vertical: 'chi_tra_vert', writes: 'vertical', cjk: true },
  { code: 'ja', name: 'Japanese', ocr: 'jpn', vertical: 'jpn_vert', writes: 'vertical', cjk: true },
  { code: 'ko', name: 'Korean', ocr: 'kor', writes: 'horizontal', cjk: true },
  { code: 'ms', name: 'Malay', ocr: 'msa', writes: 'horizontal' },
  { code: 'id', name: 'Indonesian', ocr: 'ind', writes: 'horizontal' },
  { code: 'th', name: 'Thai', ocr: 'tha', writes: 'horizontal' },
  { code: 'vi', name: 'Vietnamese', ocr: 'vie', writes: 'horizontal' },
  { code: 'ta', name: 'Tamil', ocr: 'tam', writes: 'horizontal' },
  { code: 'hi', name: 'Hindi', ocr: 'hin', writes: 'horizontal' },
  { code: 'ar', name: 'Arabic', ocr: 'ara', writes: 'horizontal', rtl: true },
  { code: 'fr', name: 'French', ocr: 'fra', writes: 'horizontal' },
  { code: 'de', name: 'German', ocr: 'deu', writes: 'horizontal' },
  { code: 'es', name: 'Spanish', ocr: 'spa', writes: 'horizontal' },
  { code: 'pt', name: 'Portuguese', ocr: 'por', writes: 'horizontal' },
  { code: 'it', name: 'Italian', ocr: 'ita', writes: 'horizontal' },
  { code: 'ru', name: 'Russian', ocr: 'rus', writes: 'horizontal' },
];

const byCode = (code) => LANGUAGES.find(l => l.code === code) || LANGUAGES.find(l => l.code === 'auto');
const nameOf = (code) => byCode(code).name;
const isCjk = (code) => Boolean(byCode(code).cjk);
const isRtl = (code) => Boolean(byCode(code).rtl);

// Tesseract languages to load for reading `code` off an image: 'auto' loads the big three
// manga/document scripts plus English, which covers most of what people translate.
function ocrLangsFor(code, { vertical = false } = {}) {
  if (code === 'auto') return vertical ? 'jpn_vert+chi_sim_vert+jpn+chi_sim+eng' : 'jpn+chi_sim+kor+eng';
  const l = byCode(code);
  if (!l.ocr) return 'eng';
  return vertical && l.vertical ? `${l.vertical}+${l.ocr}` : l.ocr;
}

// Which way a translation into `target` is set, given the setting and the source lettering:
// 'auto' keeps the source direction when the target can be written that way, else the
// target's own default. Chinese set vertically stays vertical; English never does.
function directionFor(target, setting, sourceDirection) {
  if (setting === 'vertical' || setting === 'horizontal') return setting === 'vertical' && !isCjk(target) ? 'horizontal' : setting;
  const l = byCode(target);
  if (!l.cjk) return 'horizontal';
  if (sourceDirection === 'vertical' || sourceDirection === 'horizontal') return sourceDirection;
  return l.writes || 'horizontal';
}

// A rough script guess from the text itself, for picking OCR data and prompts.
function guessLanguage(text) {
  const t = String(text || '');
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[一-鿿]/.test(t)) return 'zh-Hans';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[؀-ۿ]/.test(t)) return 'ar';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  if (/[஀-௿]/.test(t)) return 'ta';
  return t.trim() ? 'en' : 'auto';
}

return { LANGUAGES, byCode, nameOf, isCjk, isRtl, ocrLangsFor, directionFor, guessLanguage };
});
