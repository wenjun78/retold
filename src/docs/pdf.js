'use strict';
// A translated PDF is the original's pages rendered as pictures with the translation set
// over them (the same overlay as a manga page), bound back into a PDF at the original page
// sizes. Text search is lost; appearance is kept exactly.
const { PDFDocument } = require('pdf-lib');

// pages: [{ png: Buffer, width: points, height: points }]. Returns the PDF as a Buffer.
async function pdfFromPages(pages) {
  const doc = await PDFDocument.create();
  for (const p of pages) {
    const img = await doc.embedPng(p.png);
    const w = p.width || img.width, h = p.height || img.height;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { pdfFromPages };
