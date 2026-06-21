'use strict';
require('dotenv').config();
const TelegramBot   = require('node-telegram-bot-api');
const { generateReceipt } = require('./receipt');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
//  CONFIG  (set via environment variables)
// ─────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const OWNER_IDS  = (process.env.OWNER_IDS || '')
  .split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
const SHOP_NAME  = process.env.SHOP_NAME  || 'My Shop';
const SHOP_ADDR  = process.env.SHOP_ADDR  || '';
const SHOP_PHONE = process.env.SHOP_PHONE || '';
const CURRENCY   = process.env.CURRENCY   || 'RM';

if (!BOT_TOKEN)      { console.error('❌  BOT_TOKEN is not set.');  process.exit(1); }
if (!OWNER_IDS.length){ console.error('❌  OWNER_IDS is not set.'); process.exit(1); }

// ─────────────────────────────────────────────
//  PERSISTENCE
// ─────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE))
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {}
  return { products: [], orders: {}, counter: 1 };
}

let db = loadData();

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

function nextOrderId() {
  const id = `ORD-${String(db.counter).padStart(4, '0')}`;
  db.counter++;
  save();
  return id;
}

// ─────────────────────────────────────────────
//  BOT + SESSION
// ─────────────────────────────────────────────
const bot      = new TelegramBot(BOT_TOKEN, { polling: true });
const sessions = {};   // userId -> { cart: [], step: '' }

function session(uid) {
  if (!sessions[uid]) sessions[uid] = { cart: [], step: 'idle' };
  return sessions[uid];
}

function isOwner(uid) { return OWNER_IDS.includes(uid); }

function fmt(n) { return `${CURRENCY}${parseFloat(n).toFixed(2)}`; }

function cartTotal(cart) {
  return cart.reduce((s, i) => s + i.price * i.qty, 0);
}

function cartText(cart) {
  if (!cart.length) return '_Your cart is empty._';
  let t = '🛒 *Your cart:*\n';
  cart.forEach(i => { t += `· ${i.name} × ${i.qty} = ${fmt(i.price * i.qty)}\n`; });
  t += `\nTotal: *${fmt(cartTotal(cart))}*`;
  return t;
}

// ─────────────────────────────────────────────
//  KEYBOARDS
// ─────────────────────────────────────────────
function menuKeyboard() {
  const active = db.products.filter(p => p.active && p.stock > 0);
  const rows   = [];
  for (let i = 0; i < active.length; i += 2) {
    const row = [{ text: `${active[i].name}  ${fmt(active[i].price)}`, callback_data: `prod_${active[i].id}` }];
    if (active[i + 1]) row.push({ text: `${active[i+1].name}  ${fmt(active[i+1].price)}`, callback_data: `prod_${active[i+1].id}` });
    rows.push(row);
  }
  rows.push([
    { text: '🛒 View Cart',   callback_data: 'view_cart'  },
    { text: '📋 My Orders',  callback_data: 'my_orders'  },
  ]);
  return { inline_keyboard: rows };
}

function qtyKeyboard(prodId) {
  return { inline_keyboard: [
    [{ text:'1', callback_data:`qty_${prodId}_1` }, { text:'2', callback_data:`qty_${prodId}_2` },
     { text:'3', callback_data:`qty_${prodId}_3` }, { text:'5', callback_data:`qty_${prodId}_5` }],
    [{ text:'↩️ Back to menu', callback_data:'menu' }],
  ]};
}

function cartKeyboard() {
  return { inline_keyboard: [
    [{ text:'➕ Add more', callback_data:'menu' }, { text:'📨 Place Order', callback_data:'place_order' }],
    [{ text:'🗑 Clear cart', callback_data:'clear_cart' }],
  ]};
}

function confirmKeyboard() {
  return { inline_keyboard: [
    [{ text:'✅ Yes, send my order', callback_data:'confirm_order' }, { text:'❌ Cancel', callback_data:'menu' }],
  ]};
}

function ownerOrderKeyboard(oid) {
  return { inline_keyboard: [
    [{ text:'✅ Confirm Order', callback_data:`oc_${oid}` }, { text:'❌ Reject', callback_data:`or_${oid}` }],
  ]};
}

const OWNER_KB = { keyboard: [
  [{ text:'📋 Pending Orders' }, { text:'📊 Dashboard' }],
  [{ text:'📦 Products' },       { text:'☁️ Backup Data' }],
], resize_keyboard: true };

// ─────────────────────────────────────────────
//  CUSTOMER – SEND MENU
// ─────────────────────────────────────────────
async function sendMenu(chatId, firstName) {
  const s = session(chatId);
  s.step  = 'menu';
  const active = db.products.filter(p => p.active && p.stock > 0);
  if (!active.length) {
    return bot.sendMessage(chatId,
      `👋 Hi *${firstName}*!\n\n_${SHOP_NAME} has no products available right now. Please check back later._`,
      { parse_mode: 'Markdown' });
  }
  await bot.sendMessage(chatId,
    `👋 Hi *${firstName}*!\n\nWelcome to *${SHOP_NAME}*.\nChoose a product:`,
    { parse_mode: 'Markdown', reply_markup: menuKeyboard() });
}

// ─────────────────────────────────────────────
//  CUSTOMER – MESSAGES
// ─────────────────────────────────────────────
bot.onText(/^(\/start|hi|hello|order|menu)$/i, (msg) => {
  if (isOwner(msg.from.id)) return ownerStart(msg.chat.id, msg.from.first_name);
  sendMenu(msg.chat.id, msg.from.first_name);
});

bot.on('message', (msg) => {
  if (!msg.text) return;
  const txt = msg.text.toLowerCase().trim();
  if (['\/start','hi','hello','order','menu'].includes(txt)) return;

  if (isOwner(msg.from.id)) return handleOwnerText(msg);

  // Any other text from customer – prompt menu
  bot.sendMessage(msg.chat.id,
    `Type *hi* to start ordering from *${SHOP_NAME}* 😊`,
    { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────
//  CUSTOMER – CALLBACKS
// ─────────────────────────────────────────────
bot.on('callback_query', async (q) => {
  await bot.answerCallbackQuery(q.id);
  if (isOwner(q.from.id)) return handleOwnerCallback(q);

  const uid    = q.from.id;
  const chatId = q.message.chat.id;
  const cb     = q.data;
  const s      = session(uid);

  if (cb === 'menu')       return sendMenu(chatId, q.from.first_name);
  if (cb === 'clear_cart') { s.cart = []; return bot.sendMessage(chatId, '🗑 Cart cleared.', { reply_markup: menuKeyboard() }); }

  if (cb === 'view_cart') {
    if (!s.cart.length) return bot.sendMessage(chatId, '🛒 Your cart is empty!', { reply_markup: menuKeyboard() });
    return bot.sendMessage(chatId, cartText(s.cart), { parse_mode:'Markdown', reply_markup: cartKeyboard() });
  }

  if (cb === 'my_orders') {
    const mine = Object.values(db.orders).filter(o => o.customerId === uid).slice(-5).reverse();
    if (!mine.length) return bot.sendMessage(chatId, '📋 You have no orders yet.');
    let t = '📋 *Your recent orders:*\n\n';
    mine.forEach(o => { t += `*${o.id}* — ${o.status.toUpperCase()}\n${fmt(o.total)}  ·  ${new Date(o.createdAt).toLocaleDateString()}\n\n`; });
    return bot.sendMessage(chatId, t, { parse_mode:'Markdown' });
  }

  if (cb.startsWith('prod_')) {
    const prod = db.products.find(p => p.id === parseInt(cb.split('_')[1]));
    if (!prod) return;
    return bot.sendMessage(chatId,
      `📦 *${prod.name}*\nPrice: ${fmt(prod.price)}  ·  Stock: ${prod.stock}\n\nHow many?`,
      { parse_mode:'Markdown', reply_markup: qtyKeyboard(prod.id) });
  }

  if (cb.startsWith('qty_')) {
    const [,pId,qtyStr] = cb.split('_');
    const prod = db.products.find(p => p.id === parseInt(pId));
    if (!prod) return;
    const qty = parseInt(qtyStr);
    const existing = s.cart.find(i => i.prodId === prod.id);
    if (existing) existing.qty += qty;
    else s.cart.push({ prodId: prod.id, name: prod.name, price: prod.price, qty });
    return bot.sendMessage(chatId,
      `✅ Added ${qty} × ${prod.name}\n\n${cartText(s.cart)}`,
      { parse_mode:'Markdown', reply_markup: cartKeyboard() });
  }

  if (cb === 'place_order') {
    if (!s.cart.length) return bot.sendMessage(chatId, '🛒 Your cart is empty!');
    return bot.sendMessage(chatId,
      `📋 *Order Summary*\n\n${cartText(s.cart)}\n\nSend this order to the shop?`,
      { parse_mode:'Markdown', reply_markup: confirmKeyboard() });
  }

  if (cb === 'confirm_order') {
    if (!s.cart.length) return bot.sendMessage(chatId, '🛒 Your cart is empty!');
    const oid   = nextOrderId();
    const order = {
      id:               oid,
      customerId:       uid,
      customerName:     `${q.from.first_name || ''} ${q.from.last_name || ''}`.trim(),
      customerUsername: q.from.username || '',
      chatId:           chatId,
      items:            [...s.cart],
      total:            cartTotal(s.cart),
      status:           'pending',
      createdAt:        new Date().toISOString(),
    };
    db.orders[oid] = order;
    save();
    s.cart = [];

    await bot.sendMessage(chatId,
      `📨 *Order sent!*\nOrder ID: \`${oid}\`\n\n⏳ Waiting for the shop to confirm your order. We'll notify you here.`,
      { parse_mode:'Markdown' });

    // Notify all owners
    for (const ownerId of OWNER_IDS) {
      let omsg = `🛒 *New Order — ${oid}*\n\n`;
      omsg += `👤 ${order.customerName}`;
      if (order.customerUsername) omsg += ` (@${order.customerUsername})`;
      omsg += `\n🆔 \`${uid}\`\n\n`;
      order.items.forEach(i => { omsg += `· ${i.name} × ${i.qty} = ${fmt(i.price * i.qty)}\n`; });
      omsg += `\nTotal: *${fmt(order.total)}*`;
      try {
        await bot.sendMessage(ownerId, omsg, { parse_mode:'Markdown', reply_markup: ownerOrderKeyboard(oid) });
      } catch (e) { console.error(`Could not reach owner ${ownerId}:`, e.message); }
    }
  }
});

// ─────────────────────────────────────────────
//  OWNER – START
// ─────────────────────────────────────────────
async function ownerStart(chatId, firstName) {
  const all       = Object.values(db.orders);
  const pending   = all.filter(o => o.status === 'pending');
  const confirmed = all.filter(o => o.status === 'confirmed');
  const revenue   = confirmed.reduce((s, o) => s + o.total, 0);
  const msg =
    `🏪 *${SHOP_NAME}*\n` +
    `👋 Welcome, ${firstName}!\n\n` +
    `⏳ Pending:   *${pending.length}*\n` +
    `✅ Confirmed: *${confirmed.length}*\n` +
    `💰 Revenue:   *${fmt(revenue)}*\n\n` +
    `Use the buttons below 👇`;
  await bot.sendMessage(chatId, msg, { parse_mode:'Markdown', reply_markup: OWNER_KB });
}

// ─────────────────────────────────────────────
//  OWNER – TEXT COMMANDS
// ─────────────────────────────────────────────
async function handleOwnerText(msg) {
  const chatId = msg.chat.id;
  const txt    = msg.text;

  // ── Keyboard buttons ──
  if (txt === '📋 Pending Orders') {
    const pending = Object.values(db.orders).filter(o => o.status === 'pending');
    if (!pending.length) return bot.sendMessage(chatId, '✅ No pending orders right now.');
    for (const o of pending) {
      let m = `🛒 *${o.id}*\n👤 ${o.customerName}\n`;
      o.items.forEach(i => { m += `· ${i.name} × ${i.qty} = ${fmt(i.price * i.qty)}\n`; });
      m += `Total: *${fmt(o.total)}*`;
      await bot.sendMessage(chatId, m, { parse_mode:'Markdown', reply_markup: ownerOrderKeyboard(o.id) });
    }
    return;
  }

  if (txt === '📊 Dashboard') {
    const all       = Object.values(db.orders);
    const confirmed = all.filter(o => o.status === 'confirmed');
    const pending   = all.filter(o => o.status === 'pending');
    const rejected  = all.filter(o => o.status === 'rejected');
    const revenue   = confirmed.reduce((s, o) => s + o.total, 0);
    const today     = new Date().toDateString();
    const todayRev  = confirmed.filter(o => new Date(o.confirmedAt).toDateString() === today).reduce((s,o)=>s+o.total,0);
    const m =
      `📊 *Dashboard — ${SHOP_NAME}*\n\n` +
      `📦 Total orders:  *${all.length}*\n` +
      `⏳ Pending:       *${pending.length}*\n` +
      `✅ Confirmed:     *${confirmed.length}*\n` +
      `❌ Rejected:      *${rejected.length}*\n\n` +
      `💰 Total revenue: *${fmt(revenue)}*\n` +
      `📅 Today revenue: *${fmt(todayRev)}*`;
    return bot.sendMessage(chatId, m, { parse_mode:'Markdown' });
  }

  if (txt === '📦 Products') {
    if (!db.products.length) return bot.sendMessage(chatId, '📦 No products yet.\n\nAdd one:\n`/addproduct Name|Price|Stock`', { parse_mode:'Markdown' });
    let m = `📦 *Products*\n\n`;
    db.products.forEach(p => {
      m += `${p.active ? '🟢' : '🔴'} *${p.name}* — ${fmt(p.price)}  Stock: ${p.stock}\n`;
    });
    m += `\n*Commands:*\n\`/addproduct Name|Price|Stock\`\n\`/stock Name|NewStock\`\n\`/hideproduct Name\`\n\`/showproduct Name\``;
    return bot.sendMessage(chatId, m, { parse_mode:'Markdown' });
  }

  if (txt === '☁️ Backup Data') {
    const backup = JSON.stringify(db, null, 2);
    const buf    = Buffer.from(backup, 'utf8');
    const dt     = new Date().toISOString().slice(0,10);
    await bot.sendDocument(chatId, buf, { caption: `📦 Data backup — ${dt}` }, { filename: `orderbot-backup-${dt}.json`, contentType: 'application/json' });
    return;
  }

  // ── Slash commands ──
  if (txt.startsWith('/addproduct')) {
    const parts = txt.replace('/addproduct', '').trim().split('|');
    if (parts.length < 2) return bot.sendMessage(chatId,
      '⚠️ Usage: `/addproduct Name|Price|Stock`\nExample: `/addproduct Nasi Lemak|8.00|25`',
      { parse_mode:'Markdown' });
    const p = {
      id:     (Math.max(0, ...db.products.map(p => p.id)) + 1),
      name:   parts[0].trim(),
      price:  parseFloat(parts[1]) || 0,
      stock:  parseInt(parts[2]) || 99,
      active: true,
    };
    db.products.push(p);
    save();
    return bot.sendMessage(chatId, `✅ Added: *${p.name}* — ${fmt(p.price)}  Stock: ${p.stock}`, { parse_mode:'Markdown' });
  }

  if (txt.startsWith('/stock')) {
    const parts = txt.replace('/stock', '').trim().split('|');
    if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: `/stock Name|NewStock`', { parse_mode:'Markdown' });
    const p = db.products.find(x => x.name.toLowerCase() === parts[0].trim().toLowerCase());
    if (!p) return bot.sendMessage(chatId, `❌ Product not found: "${parts[0].trim()}"`);
    p.stock = parseInt(parts[1]) || 0;
    save();
    return bot.sendMessage(chatId, `✅ *${p.name}* stock updated to ${p.stock}`, { parse_mode:'Markdown' });
  }

  if (txt.startsWith('/hideproduct')) {
    const name = txt.replace('/hideproduct', '').trim();
    const p    = db.products.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!p) return bot.sendMessage(chatId, `❌ Not found: "${name}"`);
    p.active = false; save();
    return bot.sendMessage(chatId, `🔴 *${p.name}* is now hidden from customers.`, { parse_mode:'Markdown' });
  }

  if (txt.startsWith('/showproduct')) {
    const name = txt.replace('/showproduct', '').trim();
    const p    = db.products.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!p) return bot.sendMessage(chatId, `❌ Not found: "${name}"`);
    p.active = true; save();
    return bot.sendMessage(chatId, `🟢 *${p.name}* is now visible to customers.`, { parse_mode:'Markdown' });
  }

  if (txt.startsWith('/price')) {
    const parts = txt.replace('/price', '').trim().split('|');
    if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: `/price Name|NewPrice`', { parse_mode:'Markdown' });
    const p = db.products.find(x => x.name.toLowerCase() === parts[0].trim().toLowerCase());
    if (!p) return bot.sendMessage(chatId, `❌ Not found.`);
    p.price = parseFloat(parts[1]) || p.price;
    save();
    return bot.sendMessage(chatId, `✅ *${p.name}* price updated to ${fmt(p.price)}`, { parse_mode:'Markdown' });
  }

  if (txt === '/help') {
    const m =
      `📖 *Owner Commands*\n\n` +
      `/addproduct Name|Price|Stock\n` +
      `/stock Name|Amount\n` +
      `/price Name|NewPrice\n` +
      `/hideproduct Name\n` +
      `/showproduct Name\n\n` +
      `Use the keyboard buttons for orders & dashboard.`;
    return bot.sendMessage(chatId, m, { parse_mode:'Markdown' });
  }
}

// ─────────────────────────────────────────────
//  OWNER – CALLBACKS (Confirm / Reject)
// ─────────────────────────────────────────────
async function handleOwnerCallback(q) {
  const chatId = q.message.chat.id;
  const cb     = q.data;

  // ── Confirm ──
  if (cb.startsWith('oc_')) {
    const oid   = cb.slice(3);
    const order = db.orders[oid];
    if (!order)                    return bot.sendMessage(chatId, '❌ Order not found.');
    if (order.status !== 'pending') return bot.sendMessage(chatId, `Order *${oid}* is already *${order.status}*.`, { parse_mode:'Markdown' });

    order.status      = 'confirmed';
    order.confirmedAt = new Date().toISOString();
    save();

    // Deduct stock
    order.items.forEach(i => {
      const p = db.products.find(x => x.id === i.prodId);
      if (p) { p.stock = Math.max(0, p.stock - i.qty); }
    });
    save();

    // Notify customer + send customer receipt
    const custMsg =
      `✅ *Your order is confirmed!*\n\n` +
      `Order: \`${oid}\`\n` +
      order.items.map(i => `· ${i.name} × ${i.qty} = ${fmt(i.price * i.qty)}`).join('\n') +
      `\n\nTotal: *${fmt(order.total)}*\n\nThank you! 🎉\n📎 Your receipt is attached below.`;
    try {
      await bot.sendMessage(order.chatId, custMsg, { parse_mode:'Markdown' });
      const custPdf = await generateReceipt(order, { shopName: SHOP_NAME, shopAddr: SHOP_ADDR, shopPhone: SHOP_PHONE, currency: CURRENCY, copy: 'Customer Copy' });
      await bot.sendDocument(order.chatId, custPdf, {}, { filename: `${oid}.pdf`, contentType: 'application/pdf' });
    } catch (e) { console.error('Customer notify error:', e.message); }

    // Confirm to owner + owner receipt
    const ownerMsg =
      `✅ *${oid} Confirmed*\n\n` +
      `👤 ${order.customerName}\n` +
      order.items.map(i => `· ${i.name} × ${i.qty} = ${fmt(i.price * i.qty)}`).join('\n') +
      `\nTotal: *${fmt(order.total)}*\n\nCustomer notified. Shop copy receipt attached.`;
    await bot.sendMessage(chatId, ownerMsg, { parse_mode:'Markdown' });
    const ownerPdf = await generateReceipt(order, { shopName: SHOP_NAME, shopAddr: SHOP_ADDR, shopPhone: SHOP_PHONE, currency: CURRENCY, copy: 'Shop Copy' });
    await bot.sendDocument(chatId, ownerPdf, {}, { filename: `${oid}-shop.pdf`, contentType: 'application/pdf' });
    return;
  }

  // ── Reject ──
  if (cb.startsWith('or_')) {
    const oid   = cb.slice(3);
    const order = db.orders[oid];
    if (!order)                    return bot.sendMessage(chatId, '❌ Order not found.');
    if (order.status !== 'pending') return bot.sendMessage(chatId, `Order *${oid}* is already *${order.status}*.`, { parse_mode:'Markdown' });

    order.status     = 'rejected';
    order.rejectedAt = new Date().toISOString();
    save();

    try {
      await bot.sendMessage(order.chatId,
        `❌ Sorry, your order *${oid}* could not be fulfilled right now. Please try again later.`,
        { parse_mode:'Markdown' });
    } catch (e) {}

    await bot.sendMessage(chatId, `❌ Order *${oid}* rejected. Customer has been notified.`, { parse_mode:'Markdown' });
  }
}

// ─────────────────────────────────────────────
//  POLLING ERRORS
// ─────────────────────────────────────────────
bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log(`✅  ${SHOP_NAME} OrderBot is running`);
console.log(`   Owners : ${OWNER_IDS.join(', ')}`);
console.log(`   Currency: ${CURRENCY}`);
