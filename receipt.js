'use strict';
const PDFDocument = require('pdfkit');

// 58 mm thermal paper = 164.4 pt at 72 pt/inch
const W  = 164.4;
const ML = 8;     // left margin
const CW = W - ML * 2;  // content width

/**
 * generateReceipt(order, config) → Promise<Buffer>
 *
 * order   : { id, customerId, customerName, customerUsername, items, total, createdAt, confirmedAt }
 * config  : { shopName, shopAddr, shopPhone, currency, copy }
 */
function generateReceipt(order, config) {
  return new Promise((resolve, reject) => {
    const { shopName, shopAddr, shopPhone, currency, copy } = config;

    // Estimate dynamic height
    const itemLines = order.items.reduce((s, i) => s + 2, 0); // 2 lines per item
    const baseH = 340;
    const pageH = baseH + itemLines * 14;

    const doc = new PDFDocument({
      size:    [W, pageH],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info:    { Title: `Receipt ${order.id}`, Author: shopName },
    });

    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   ()  => resolve(Buffer.concat(chunks)));
    doc.on('error', err => reject(err));

    let y = 10;

    // ── helpers ──────────────────────────────────────────────────
    function moveTo(newY) { y = newY; }

    function ctext(text, size, bold, color) {
      doc.font(bold ? 'Courier-Bold' : 'Courier')
         .fontSize(size)
         .fillColor(color || '#000000');
      doc.text(text, ML, y, { width: CW, align: 'center', lineBreak: false });
      y += size + 3;
    }

    function ltext(text, size, bold, color) {
      doc.font(bold ? 'Courier-Bold' : 'Courier')
         .fontSize(size)
         .fillColor(color || '#000000');
      doc.text(text, ML, y, { width: CW, lineBreak: false });
      y += size + 2;
    }

    function twoCol(left, right, size) {
      const s = size || 7;
      doc.font('Courier').fontSize(s).fillColor('#444444');
      doc.text(left, ML, y, { width: CW * 0.52, lineBreak: false });
      doc.font('Courier-Bold').fontSize(s).fillColor('#000000');
      doc.text(right, ML + CW * 0.52, y, { width: CW * 0.48, align: 'right', lineBreak: false });
      y += s + 3;
    }

    function dashes() {
      doc.font('Courier').fontSize(6.5).fillColor('#aaaaaa');
      doc.text('- - - - - - - - - - - - - - - - -', ML, y, { width: CW, align: 'center', lineBreak: false });
      y += 10;
    }

    function gap(h) { y += h || 4; }

    // ── perforated top ───────────────────────────────────────────
    doc.dash(3, { space: 3 })
       .moveTo(0, 5).lineTo(W, 5)
       .strokeColor('#cccccc').lineWidth(0.5).stroke()
       .undash();
    gap(8);

    // ── shop header ──────────────────────────────────────────────
    ctext(shopName.toUpperCase(), 11, true);
    if (shopAddr)  { gap(1); ctext(shopAddr,  6.5, false, '#555555'); }
    if (shopPhone) { gap(1); ctext(shopPhone, 6.5, false, '#555555'); }
    gap(4);
    dashes();

    // ── date + order id ──────────────────────────────────────────
    const dt = new Date(order.createdAt);
    const dateStr = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    ctext(`${dateStr}  ${timeStr}`, 7, false, '#444444');
    gap(2);
    ctext(order.id, 8.5, true);
    gap(3);
    dashes();

    // ── customer ─────────────────────────────────────────────────
    twoCol('Customer:', order.customerName || '-');
    twoCol('Cust ID:', String(order.customerId));
    if (order.customerUsername) twoCol('Username:', `@${order.customerUsername}`);
    gap(2);
    dashes();

    // ── items ────────────────────────────────────────────────────
    ctext('ITEMS', 7, true, '#555555');
    gap(3);

    order.items.forEach(item => {
      // item name line
      doc.font('Courier-Bold').fontSize(7.5).fillColor('#000000');
      doc.text(item.name, ML, y, { width: CW * 0.65, lineBreak: false });
      doc.font('Courier-Bold').fontSize(7.5).fillColor('#000000');
      doc.text(`${currency}${(item.price * item.qty).toFixed(2)}`,
        ML + CW * 0.65, y, { width: CW * 0.35, align: 'right', lineBreak: false });
      y += 11;
      // unit price + qty
      doc.font('Courier').fontSize(6.5).fillColor('#888888');
      doc.text(`  ${currency}${item.price.toFixed(2)} x ${item.qty}`, ML, y, { width: CW, lineBreak: false });
      y += 10;
    });

    gap(2);
    dashes();

    // ── total ────────────────────────────────────────────────────
    doc.font('Courier-Bold').fontSize(9).fillColor('#000000');
    doc.text('TOTAL', ML, y, { width: CW * 0.5, lineBreak: false });
    doc.font('Courier-Bold').fontSize(9).fillColor('#000000');
    doc.text(`${currency}${order.total.toFixed(2)}`, ML + CW * 0.5, y, { width: CW * 0.5, align: 'right', lineBreak: false });
    y += 13;
    gap(2);
    dashes();

    // ── status stamp ─────────────────────────────────────────────
    const confirmedAt = order.confirmedAt ? new Date(order.confirmedAt) : new Date();
    const confTime = confirmedAt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

    // Draw a box around CONFIRMED
    const bx = ML + CW * 0.1;
    const bw = CW * 0.8;
    const bh = 16;
    doc.rect(bx, y, bw, bh).fillColor('#000000').fill();
    doc.font('Courier-Bold').fontSize(8).fillColor('#ffffff');
    doc.text('✓ CONFIRMED', bx, y + 4, { width: bw, align: 'center', lineBreak: false });
    y += bh + 4;
    ctext(`at ${confTime}`, 6.5, false, '#555555');
    gap(3);
    dashes();

    // ── copy label ───────────────────────────────────────────────
    ctext(copy || 'Customer Copy', 7, false, '#888888');
    gap(3);
    dashes();

    // ── footer ───────────────────────────────────────────────────
    ctext('Thank you for your purchase!', 7, true);
    gap(2);
    ctext('Powered by OrderBot', 6, false, '#aaaaaa');
    gap(6);

    // perforated bottom
    doc.dash(3, { space: 3 })
       .moveTo(0, y).lineTo(W, y)
       .strokeColor('#cccccc').lineWidth(0.5).stroke()
       .undash();

    doc.end();
  });
}

module.exports = { generateReceipt };
