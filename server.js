// Budomatch — Express server
// Static site + accounts (klanten/professionals) + leads + facturatie + Stripe + AI-assistent.
// Node 18+ (global fetch). Deps: express, stripe.

const express = require('express');
const path = require('path');
// Productie: PostgreSQL zodra DATABASE_URL is gezet (Railway). Lokaal: JSON-bestand.
const store = process.env.DATABASE_URL ? require('./lib/db') : require('./lib/store');
console.log('[store]', store._pg ? 'PostgreSQL (DATABASE_URL)' : 'JSON-bestand (lib/store)');
const A = require('./lib/auth');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const INVOICE_FONT = path.join(__dirname, 'assets', 'DejaVuSans.ttf');
// Verkoper = de Poolse onderneming Budomatch (factuur zonder btw / reverse charge)
const SELLER = {
  name: process.env.SELLER_NAME || 'Budomatch DANIËL DE GRAAF',
  addr: process.env.SELLER_ADDR || 'Białka 15',
  zipcity: process.env.SELLER_ZIPCITY || '09-550 Białka',
  country: process.env.SELLER_COUNTRY || 'Polska',
  nip: process.env.SELLER_NIP || '7010869430',
  regon: process.env.SELLER_REGON || '381430120',
  email: process.env.SELLER_EMAIL || 'info@budomatch.nl',
};

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

// ---------------- e-mailhuisstijl ----------------
// Tabel-layout + inline styles (betrouwbaar in Gmail/Outlook/Apple Mail):
// donkere kop met goudkleurig woordmerk, lichte kaart, gouden knoppen.
const SITE_URL = (process.env.BASE_URL || 'https://budomatch.nl').replace(/\/$/, '');
const mailBtn = (url, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:24px auto"><tr>
     <td bgcolor="#C9A227" style="border-radius:50px">
       <a href="${url}" style="display:inline-block;padding:13px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#13110B;text-decoration:none">${label}</a>
     </td></tr></table>`;
const mailCode = code =>
  `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:24px auto"><tr>
     <td bgcolor="#13110B" style="border-radius:14px;padding:16px 34px">
       <span style="font-family:'Courier New',Courier,monospace;font-size:30px;letter-spacing:10px;font-weight:bold;color:#E3C158">${code}</span>
     </td></tr></table>`;
const mailMuted = s => `<p style="color:#8A8270;font-size:13px;margin:18px 0 0">${s}</p>`;
function mailWrap(title, inner) {
  return `<!DOCTYPE html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background-color:#EFECE2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#EFECE2"><tr><td align="center" style="padding:30px 12px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
    <tr><td bgcolor="#13110B" style="border-radius:16px 16px 0 0;padding:26px 36px;text-align:center">
      <a href="${SITE_URL}" style="text-decoration:none">
        <span style="font-family:Georgia,'Times New Roman',serif;font-size:23px;letter-spacing:5px;color:#D4AF37">BUDOMATCH</span><br>
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:3px;color:#A89C7E">VAKMANSCHAP&nbsp;DICHTBIJ</span>
      </a>
    </td></tr>
    <tr><td bgcolor="#FFFFFF" style="padding:32px 36px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#2B2820;border-left:1px solid #E7E1D2;border-right:1px solid #E7E1D2">
      ${title ? `<h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:22px;color:#13110B">${title}</h1>` : ''}
      ${inner}
    </td></tr>
    <tr><td bgcolor="#FBFAF6" style="border:1px solid #E7E1D2;border-top:0;border-radius:0 0 16px 16px;padding:18px 36px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.7;color:#8A8270">
      Budomatch — betrouwbare vakmensen in heel Nederland<br>
      <a href="${SITE_URL}" style="color:#A8842B;text-decoration:none">budomatch.nl</a> &nbsp;·&nbsp; <a href="mailto:${SELLER.email}" style="color:#A8842B;text-decoration:none">${SELLER.email}</a>
    </td></tr>
  </table>
</td></tr></table></body></html>`;
}

// ----- Pricing -----
// Standaardwaarden; de actuele waarden staan in de database (beheerpaneel →
// Instellingen) en worden bij het opstarten in PRICING geladen. Wijzigen kan
// zonder herstart via POST /api/admin/settings.
const FREE_LEADS = 5;
const LEAD_PRICE_GROSS = 18.15;         // euro (btw verlegd)
const VAT_RATE = 0;                      // 0% — btw verlegd (reverse charge, B2B NL)
const CURRENCY = 'eur';

const PRICING = { gross: LEAD_PRICE_GROSS, freeLeads: FREE_LEADS };
async function loadPricing() {
  try {
    const s = await store.getSettings();
    if (Number(s.leadPriceGross) > 0) PRICING.gross = Math.round(Number(s.leadPriceGross) * 100) / 100;
    if (Number.isFinite(Number(s.freeLeads)) && Number(s.freeLeads) >= 0) PRICING.freeLeads = Math.round(Number(s.freeLeads));
    console.log(`[pricing] leadprijs € ${PRICING.gross.toFixed(2)} · ${PRICING.freeLeads} gratis welkomstleads`);
  } catch (e) { console.error('[pricing] instellingen laden mislukt:', e.message); }
}
loadPricing();
// Samenvatting voor API-antwoorden (btw verlegd → netto = bruto, btw = 0)
const priceInfo = () => ({ gross: PRICING.gross, net: PRICING.gross, vat: 0, vatRate: VAT_RATE });

// Prijs per lead hangt af van het type aanvraag:
// - 'opdracht' (echte klus): volle prijs
// - 'orientatie' (klant oriënteert / wil iets kopen): 50% ontgrendelprijs
function leadPrice(r) {
  const factor = (r && r.intent === 'orientatie') ? 0.5 : 1;
  // in centen rekenen: 1815 × 0,5 = 907,5 → 908 → € 9,08 (geen float-afronding naar 9,07)
  const gross = Math.round(Math.round(PRICING.gross * 100) * factor) / 100;
  const net = +(gross / (1 + VAT_RATE)).toFixed(2);
  const vat = +(gross - net).toFixed(2);
  return { gross, net, vat, vatRate: VAT_RATE, orientation: factor !== 1 };
}
// Testaccount (SEED_TEST_PAYMENT) betaalt een vaste testprijs (bijv. € 1) —
// de globale prijs blijft voor iedereen anders gelden.
function proLeadPrice(r, pro) {
  if (pro && Number(pro.testPriceGross) > 0) {
    const gross = Math.round(Number(pro.testPriceGross) * 100) / 100;
    return { gross, net: gross, vat: 0, vatRate: VAT_RATE, orientation: false };
  }
  return leadPrice(r);
}

// ----- Stripe (alleen geladen als er een sleutel is) -----
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();

// Stripe-webhook MOET de ruwe body krijgen → vóór express.json() registreren.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Stripe webhook-signatuur ongeldig:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const proId = s.metadata && s.metadata.proId;
      const requestId = s.metadata && s.metadata.requestId;
      // idempotent: alleen claim aanmaken als die nog niet bestaat
      if (proId && requestId && !(await store.claimExists(proId, requestId))) {
        const r = await store.findRequest(requestId);
        const proU = await store.findUserById(proId);
        const p = proLeadPrice(r, proU);
        const claim = await store.addClaim({
          proId, requestId, free: false, paid: true,
          amountGross: p.gross, amountNet: p.net, amountVat: p.vat,
          invoiceNo: await store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online',
          stripeSession: s.id, paymentIntent: s.payment_intent || null,
        });
        // factuur ook in Faktura XL (+ KSeF) zetten — Poolse administratie
        fakturaXlExport(claim, proU, r).catch(() => {});
      }
    }
  } catch (e) { console.error('Webhook-verwerking mislukt:', e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
// Nette URL's: /dashboard i.p.v. /dashboard.html. Oude .html-links krijgen een
// 301-redirect (bookmarks en zoekmachines blijven werken), de static-server
// probeert daarna automatisch <pad>.html (optie "extensions").
app.use((req, res, next) => {
  if (req.method === 'GET' && /^\/[a-z0-9-]+\.html$/i.test(req.path)) {
    const clean = req.path === '/index.html' ? '/' : req.path.slice(0, -5);
    const q = req.originalUrl.indexOf('?');
    return res.redirect(301, clean + (q >= 0 ? req.originalUrl.slice(q) : ''));
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ----- 41 specialisaties -----
const CATS_NL = "Aanbouw, Uitbouw, Opbouw, Airco, Architect, Asbest verwijderen, Badkamerspecialist, Bestraten, Cv-ketel, Dakbedekking, Dakkapel, Dakraam, Elektricien, Garagedeur, Gevelreiniging, Glas, Hekwerken, Inbraakbeveiliging, Isolatie, Keukenspecialist, Kozijnen, Laadpalen, Loodgieter, Ongediertebestrijding, Rolluiken, Schilderwerk, Schuifpui, Serre, Stucwerk, Tegels zetten, Thuisbatterij, Trap, Tuinaanleg, Tuinonderhoud, Ventilatie, Verbouwing, Vloeren, Vloerverwarming, Vochtbestrijding, Warmtepomp, Wellness, Zonnepanelen, Zonwering";
const CATS_EN = "Extension, Bump-out extension, Storey addition, Air conditioning, Architect, Asbestos removal, Bathroom, Paving, Boiler (CH), Roofing, Dormer, Roof window, Electrician, Garage door, Facade cleaning, Glazing, Fencing, Burglary protection, Insulation, Kitchen, Window frames, EV charging, Plumber, Pest control, Roller shutters, Painting, Sliding doors, Conservatory, Plastering, Tiling, Home battery, Stairs, Landscaping, Garden maintenance, Ventilation, Renovation, Flooring, Underfloor heating, Damp proofing, Heat pump, Wellness & sauna, Solar panels, Awnings & sun protection";

// ---------------- helpers ----------------
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
// Sessietoken bevat een vingerafdruk van het wachtwoord (ph): na een wachtwoord-
// wijziging/reset vervallen alle oude sessies. Tokens zonder ph (van vóór deze
// wijziging) blijven geldig tot ze verlopen.
const passFp = u => String(u.passHash || '').slice(-8);
const sessionToken = u => A.sign({ uid: u.id, role: u.role, ph: passFp(u) });
async function getUser(req) {
  const t = A.parseCookies(req).bm_token;
  const p = A.verify(t);
  if (!p) return null;
  const u = await store.findUserById(p.uid);
  if (!u || u.blocked) return null; // geblokkeerde accounts zijn overal uitgelogd
  if (p.ph !== undefined && p.ph !== passFp(u)) return null; // wachtwoord gewijzigd → oude sessie vervalt
  return u;
}
async function publicUser(u) {
  if (!u) return null;
  const { passHash, twofaSecret, twofaTempSecret, twofaRecovery, regCode, regCodeExp, regCodeTries, ...rest } = u;
  rest.twofaEnabled = !!u.twofaEnabled;
  rest.twofaRecoveryLeft = (u.twofaRecovery || []).length;
  rest.emailVerified = u.emailVerified !== false; // bestaande accounts (zonder veld) gelden als bevestigd
  if (u.role === 'pro') {
    const ci = await creditInfo(u);
    rest.creditsUsed = ci.usedTotal;
    rest.creditsLeft = ci.freeAvailable;
    rest.rating = ci.rating;
    rest.tier = ci.tier;
    rest.welcomeLeft = ci.welcomeRemaining;
    rest.monthlyLeft = ci.monthlyRemaining;
    rest.bio = u.bio || ''; rest.website = u.website || ''; rest.logo = u.logo || '';
    rest.websitePreview = u.websitePreview || null;
    rest.photos = u.photos || []; rest.workRadius = u.workRadius || 0; rest.workZip = u.workZip || '';
    rest.workCategories = u.workCategories || [];
    rest.kvk = u.kvk || ''; rest.kvkVerified = !!(u.kvk && u.verifiedKvk && u.kvk === u.verifiedKvk); rest.kvkName = u.kvkName || '';
    rest.kvkAddress = u.kvkAddress || null;
    rest.vatVerified = !!(u.nip && u.verifiedVat && u.nip === u.verifiedVat); rest.vatName = u.vatName || '';
  }
  if (u.role === 'customer') {
    rest.customerType = u.customerType || 'particulier';
  }
  return rest;
}
const esc = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const isVerifiedPro = u => !!(u && u.kvk && u.verifiedKvk && u.kvk === u.verifiedKvk);
const requireRole = role => async (req, res, next) => {
  try {
    const u = await getUser(req);
    if (!u) return res.status(401).json({ error: 'auth' });
    if (role && u.role !== role) return res.status(403).json({ error: 'role' });
    req.user = u; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
};

// ---------------- rate limiting (in-memory, per IP) ----------------
// Beschermt login/registratie/reset tegen brute force en misbruik van formulieren.
const RL_BUCKETS = new Map();
setInterval(() => { const now = Date.now(); for (const [k, e] of RL_BUCKETS) if (now > e.reset) RL_BUCKETS.delete(k); }, 60000).unref();
const rateLimit = (name, max, windowMs) => (req, res, next) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const key = `${name}|${ip}`;
  const now = Date.now();
  let e = RL_BUCKETS.get(key);
  if (!e || now > e.reset) { e = { n: 0, reset: now + windowMs }; RL_BUCKETS.set(key, e); }
  if (++e.n > max) {
    res.set('Retry-After', String(Math.ceil((e.reset - now) / 1000)));
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
};
const baseUrl = req => process.env.BASE_URL || `${String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0]}://${req.headers.host}`;

// ---------------- 2FA (TOTP) ----------------
app.post('/api/login/2fa', rateLimit('2fa', 10, 15 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const p = A.verify(String(b.challenge || ''));
    if (!p || p.t !== '2fa') return res.status(401).json({ error: 'challenge' });
    const u = await store.findUserById(p.uid);
    if (!u || !u.twofaEnabled) return res.status(401).json({ error: 'auth' });
    let ok = A.verifyTotp(u.twofaSecret, b.code);
    if (!ok) {
      const list = u.twofaRecovery || [];
      const idx = list.indexOf(A.hashRecovery(b.code));
      if (idx >= 0) { list.splice(idx, 1); await store.updateUser(u.id, { twofaRecovery: list }); ok = true; }
    }
    if (!ok) return res.status(401).json({ error: 'bad_code' });
    A.setAuthCookie(res, sessionToken(u), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/2fa/setup', requireRole(), async (req, res) => {
  try {
    const secret = A.genTotpSecret();
    await store.updateUser(req.user.id, { twofaTempSecret: secret });
    const url = A.otpauthUrl(secret, req.user.email);
    let qr = ''; try { qr = await QRCode.toDataURL(url, { margin: 1, width: 220 }); } catch (e) {}
    res.json({ secret, otpauth: url, qr });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/2fa/enable', requireRole(), async (req, res) => {
  try {
    const u = req.user;
    if (!u.twofaTempSecret) return res.status(400).json({ error: 'no_setup' });
    if (!A.verifyTotp(u.twofaTempSecret, (req.body || {}).code)) return res.status(400).json({ error: 'bad_code' });
    const recovery = A.genRecoveryCodes(8);
    await store.updateUser(u.id, { twofaSecret: u.twofaTempSecret, twofaEnabled: true, twofaTempSecret: '', twofaRecovery: recovery.map(A.hashRecovery) });
    res.json({ ok: true, recovery });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/2fa/recovery', requireRole(), async (req, res) => {
  try {
    const u = req.user;
    if (!u.twofaEnabled) return res.status(400).json({ error: 'not_enabled' });
    const b = req.body || {};
    if (!(A.verifyTotp(u.twofaSecret, b.code) || A.verifyPassword(String(b.password || ''), u.passHash)))
      return res.status(400).json({ error: 'verify' });
    const recovery = A.genRecoveryCodes(8);
    await store.updateUser(u.id, { twofaRecovery: recovery.map(A.hashRecovery) });
    res.json({ ok: true, recovery });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/2fa/disable', requireRole(), async (req, res) => {
  try {
    const u = req.user; const b = req.body || {};
    const ok = A.verifyPassword(String(b.password || ''), u.passHash) || A.verifyTotp(u.twofaSecret, b.code);
    if (!ok) return res.status(400).json({ error: 'verify' });
    await store.updateUser(u.id, { twofaEnabled: false, twofaSecret: '', twofaTempSecret: '' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- feedback / ideeën ----------------
const FB_ADMIN = (process.env.ADMIN_EMAIL || '').toLowerCase();
app.post('/api/feedback', requireRole(), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 120);
    const message = String(b.message || '').trim().slice(0, 2000);
    if (!title) return res.status(400).json({ error: 'invalid' });
    const type = ['idee', 'probleem', 'verbetering'].includes(b.type) ? b.type : 'idee';
    const f = await store.addFeedback({ userId: req.user.id, role: req.user.role, name: req.user.company || req.user.name, type, title, message });
    sendMail(`Nieuwe feedback (${type}) — ${title}`,
      mailWrap('Nieuwe feedback', `<p><b>${esc(title)}</b> — <i>${type}</i></p><p>${esc(message) || '(geen toelichting)'}</p>${mailMuted(`Van ${esc(f.name)} · ${req.user.role === 'pro' ? 'vakman' : 'klant'} · ${esc(req.user.email)}`)}`),
      null, FB_ADMIN || undefined).catch(() => {});
    res.json({ feedback: f });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.get('/api/feedback', requireRole(), async (req, res) => {
  try {
    const items = (await store.listFeedback()).filter(f => f.kind !== 'support').map(f => ({
      id: f.id, type: f.type, title: f.title, message: f.message, name: f.name, role: f.role,
      status: f.status || 'nieuw', votes: (f.votes || []).length, voted: (f.votes || []).includes(req.user.id),
      mine: f.userId === req.user.id, createdAt: f.createdAt,
    }));
    res.json({ items, admin: !!(FB_ADMIN && req.user.email.toLowerCase() === FB_ADMIN) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/feedback/:id/vote', requireRole(), async (req, res) => {
  try {
    const f = await store.findFeedback(req.params.id);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const votes = f.votes || []; const i = votes.indexOf(req.user.id);
    if (i >= 0) votes.splice(i, 1); else votes.push(req.user.id);
    await store.updateFeedback(f.id, { votes });
    res.json({ ok: true, votes: votes.length, voted: i < 0 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/feedback/:id/status', requireRole(), async (req, res) => {
  try {
    if (!FB_ADMIN || req.user.email.toLowerCase() !== FB_ADMIN) return res.status(403).json({ error: 'forbidden' });
    const status = ['nieuw', 'gepland', 'bezig', 'afgerond', 'afgewezen'].includes((req.body || {}).status) ? req.body.status : 'nieuw';
    const f = await store.updateFeedback(req.params.id, { status });
    if (!f) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- auth ----------------
app.post('/api/register', rateLimit('register', 20, 60 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const role = b.role === 'pro' ? 'pro' : 'customer';
    const email = String(b.email || '').trim().toLowerCase();
    if (!email || !b.password || String(b.password).length < 6 || !b.name)
      return res.status(400).json({ error: 'invalid' });
    if (await store.findUserByEmail(email)) return res.status(409).json({ error: 'exists' });

    const u = {
      role, name: String(b.name).trim(), email,
      passHash: A.hashPassword(String(b.password)),
      // zonder mail-integratie valt er niets te bevestigen → direct als bevestigd markeren
      emailVerified: !process.env.RESEND_API_KEY,
    };
    if (role === 'pro') {
      u.company = String(b.company || '').trim();
      u.spec = String(b.spec || '').trim();
      u.city = String(b.city || '').trim();
      u.phone = String(b.phone || '').trim();
      u.nip = String(b.nip || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 20);
      u.address = String(b.address || '').trim();
      // btw-nummer al gevalideerd via /api/vat-lookup? Het ondertekende token
      // bewijst dat — dan direct als geverifieerd opslaan (naam uit VIES).
      if (b.vatToken) {
        const vp = A.verify(String(b.vatToken));
        if (vp && vp.t === 'vatreg' && vp.vat && vp.vat === u.nip.replace(/[^A-Z0-9]/g, '')) {
          u.nip = vp.vat; u.verifiedVat = vp.vat; u.vatName = String(vp.name || '');
        }
      }
      // werkcategorieën: expliciet meegegeven, anders het hoofdspecialisme —
      // zo is het bedrijf na KvK-verificatie direct matchbaar (meer vakken: tab Werkgebied)
      const cats = Array.isArray(b.workCategories)
        ? [...new Set(b.workCategories.map(x => String(x).trim().slice(0, 60)).filter(Boolean))].slice(0, 41)
        : [];
      if (!u.spec && cats.length) u.spec = cats[0];
      u.workCategories = cats.length ? cats : (u.spec ? [u.spec] : []);
      if (u.city) { const g = await geocodeNL(u.city); if (g) { u.lat = g.lat; u.lng = g.lng; } }
    } else {
      // Particulier of zakelijk (bedrijf)
      u.customerType = b.customerType === 'zakelijk' ? 'zakelijk' : 'particulier';
      if (u.customerType === 'zakelijk') {
        u.company = String(b.company || '').trim();
        u.nip = String(b.nip || '').trim();
      }
    }
    await store.addUser(u);
    if (role === 'pro') {
      // beheerder informeren: nieuw bedrijf wacht (handmatige) KvK-verificatie
      sendMail(`Nieuwe vakman-registratie — ${esc(u.company || u.name)}`,
        mailWrap('Nieuwe vakman-registratie',
          `<p><b>${esc(u.company || u.name)}</b> (${esc(u.name)}, ${esc(u.email)}${u.city ? ', ' + esc(u.city) : ''}) heeft zich aangemeld.</p>
           <p>Het profiel wordt pas actief na KvK-verificatie. Zolang de KvK-API niet gekoppeld is: verifieer handmatig zodra het KvK-nummer bekend is.</p>
           ${mailBtn(`${SITE_URL}/admin`, 'Open beheerpaneel')}`),
        null, FB_ADMIN || undefined).catch(() => {});
    }
    // E-mail eerst bevestigen met een 6-cijferige code — pas daarna is het
    // account ingelogd. Mislukt de mail, dan blokkeren we de registratie niet
    // (anders zou een mailstoring alle registraties tegenhouden).
    if (process.env.RESEND_API_KEY) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await store.updateUser(u.id, { regCode: A.hashRecovery(code), regCodeExp: Date.now() + 10 * 60e3, regCodeTries: 0 });
      try {
        await sendMail('Je bevestigingscode — Budomatch', regCodeMailHtml(u, code), null, u.email);
        return res.json({ codeRequired: true, challenge: A.sign({ t: 'regcode', uid: u.id }, 0.02) });
      } catch (e) { console.error('regcode-mail:', e.message); }
    }
    A.setAuthCookie(res, sessionToken(u), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/login', rateLimit('login', 10, 15 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const u = await store.findUserByEmail(String(b.email || ''));
    if (!u || !A.verifyPassword(String(b.password || ''), u.passHash))
      return res.status(401).json({ error: 'bad_credentials' });
    if (u.blocked) return res.status(403).json({ error: 'blocked' });
    if (u.twofaEnabled) {
      return res.json({ twofaRequired: true, challenge: A.sign({ t: '2fa', uid: u.id }, 0.02) });
    }
    A.setAuthCookie(res, sessionToken(u), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/logout', (req, res) => { A.clearAuthCookie(res); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const u = await getUser(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  res.json({ user: await publicUser(u) });
});

// ---------------- e-mailverificatie ----------------
// Bevestigingscode bij registratie (6 cijfers, 10 minuten geldig, max 5 pogingen)
const regCodeMailHtml = (u, code) => mailWrap(`Welkom bij Budomatch, ${esc(u.name)}!`,
  `<p>Vul deze bevestigingscode in op de website om je account te activeren:</p>
   ${mailCode(code)}
   ${mailMuted('De code is 10 minuten geldig. Heb jij je niet aangemeld? Negeer deze e-mail dan.')}`);
app.post('/api/register/verify', rateLimit('regverify', 15, 15 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const p = A.verify(String(b.challenge || ''));
    if (!p || p.t !== 'regcode') return res.status(401).json({ error: 'challenge' });
    const u = await store.findUserById(p.uid);
    if (!u || u.blocked) return res.status(401).json({ error: 'auth' });
    if (!u.regCode || Date.now() > (u.regCodeExp || 0)) return res.status(401).json({ error: 'expired' });
    if ((u.regCodeTries || 0) >= 5) return res.status(401).json({ error: 'too_many' });
    const code = String(b.code || '').replace(/\D/g, '');
    if (!code || A.hashRecovery(code) !== u.regCode) {
      await store.updateUser(u.id, { regCodeTries: (u.regCodeTries || 0) + 1 });
      return res.status(401).json({ error: 'bad_code' });
    }
    await store.updateUser(u.id, { regCode: '', regCodeExp: 0, regCodeTries: 0, emailVerified: true });
    A.setAuthCookie(res, sessionToken(u), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/register/resend', rateLimit('regresend', 5, 15 * 60e3), async (req, res) => {
  try {
    const p = A.verify(String((req.body || {}).challenge || ''));
    if (!p || p.t !== 'regcode') return res.status(401).json({ error: 'challenge' });
    const u = await store.findUserById(p.uid);
    if (!u || u.blocked || u.emailVerified) return res.status(401).json({ error: 'auth' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await store.updateUser(u.id, { regCode: A.hashRecovery(code), regCodeExp: Date.now() + 10 * 60e3, regCodeTries: 0 });
    await sendMail('Je bevestigingscode — Budomatch', regCodeMailHtml(u, code), null, u.email);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

async function sendVerifyMail(u, req) {
  if (u.emailVerified) return;
  const token = A.sign({ t: 'everify', uid: u.id }, 3); // 3 dagen geldig
  const link = `${baseUrl(req)}/api/verify-email?token=${encodeURIComponent(token)}`;
  await sendMail('Bevestig je e-mailadres — Budomatch',
    mailWrap(`Welkom bij Budomatch, ${esc(u.name)}!`,
      `<p>Bevestig je e-mailadres door op de knop te klikken:</p>
       ${mailBtn(link, 'E-mailadres bevestigen')}
       ${mailMuted(`Of open deze link: <a href="${link}" style="color:#A8842B">${link}</a><br>De link is 3 dagen geldig.`)}`),
    null, u.email);
}
app.get('/api/verify-email', async (req, res) => {
  try {
    const p = A.verify(String(req.query.token || ''));
    if (!p || p.t !== 'everify') return res.redirect('/?everify=invalid');
    await store.updateUser(p.uid, { emailVerified: true });
    res.redirect('/dashboard?everified=1');
  } catch (e) { console.error(e); res.redirect('/?everify=invalid'); }
});
app.post('/api/verify-email/resend', rateLimit('everesend', 5, 60 * 60e3), requireRole(), async (req, res) => {
  try {
    if (req.user.emailVerified) return res.json({ ok: true, already: true });
    if (!process.env.RESEND_API_KEY) { await store.updateUser(req.user.id, { emailVerified: true }); return res.json({ ok: true, already: true }); }
    await sendVerifyMail(req.user, req);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- wachtwoord vergeten / opnieuw instellen ----------------
// Antwoordt altijd ok — verraadt niet of een e-mailadres bestaat (geen enumeratie).
app.post('/api/password/forgot', rateLimit('pwforgot', 5, 60 * 60e3), async (req, res) => {
  res.json({ ok: true });
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email) return;
    const u = await store.findUserByEmail(email);
    if (!u || u.blocked) return;
    // v = vingerafdruk van het huidige wachtwoord → de link werkt maar één keer
    const token = A.sign({ t: 'pwreset', uid: u.id, v: String(u.passHash || '').slice(-12) }, 1 / 24); // 1 uur
    const link = `${baseUrl(req)}/?reset=${encodeURIComponent(token)}`;
    await sendMail('Wachtwoord opnieuw instellen — Budomatch',
      mailWrap('Wachtwoord opnieuw instellen',
        `<p>Hoi ${esc(u.name)}, klik op de knop om een nieuw wachtwoord in te stellen:</p>
         ${mailBtn(link, 'Nieuw wachtwoord instellen')}
         ${mailMuted(`Of open deze link: <a href="${link}" style="color:#A8842B">${link}</a><br>De link is 1 uur geldig. Niets aangevraagd? Negeer deze e-mail.`)}`),
      null, u.email);
  } catch (e) { console.error('pwforgot:', e.message); }
});
app.post('/api/password/reset', rateLimit('pwreset', 10, 60 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    const p = A.verify(String(b.token || ''));
    if (!p || p.t !== 'pwreset') return res.status(400).json({ error: 'token' });
    const u = await store.findUserById(p.uid);
    if (!u || String(u.passHash || '').slice(-12) !== p.v) return res.status(400).json({ error: 'token' });
    if (!b.password || String(b.password).length < 6) return res.status(400).json({ error: 'invalid' });
    await store.updateUser(u.id, { passHash: A.hashPassword(String(b.password)) });
    if (u.twofaEnabled) return res.json({ ok: true, login: true }); // 2FA blijft vereist → opnieuw inloggen
    A.setAuthCookie(res, sessionToken(u), isHttps(req));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- support (klanten én bedrijven) ----------------
app.post('/api/support', rateLimit('support', 10, 60 * 60e3), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.message) return res.status(400).json({ error: 'invalid' });
    const u = await getUser(req);
    const business = (u && u.customerType === 'zakelijk') || (b.customerType === 'zakelijk');
    // opslaan in de support-inbox (beheerpaneel) — de mail is een extra melding
    await store.addFeedback({
      kind: 'support', userId: u ? u.id : '', role: u ? u.role : 'gast',
      name: u ? (u.company || u.name) : String(b.name || 'Gast').slice(0, 80), business: !!business,
      subject: String(b.subject || '').slice(0, 150), message: String(b.message).slice(0, 4000),
      email: String(b.email || (u && u.email) || '').slice(0, 120), phone: String(b.phone || '').slice(0, 40),
    });
    const who = u
      ? `${esc(u.name)} &lt;${esc(u.email)}&gt; (${u.role}${u.role === 'customer' ? '/' + (u.customerType || 'particulier') : ''}${u.company ? ' — ' + esc(u.company) : ''})`
      : 'gast';
    sendMail(
      `${business ? '[ZAKELIJK] ' : ''}Support: ${esc(b.subject) || '(geen onderwerp)'}`,
      mailWrap(`Supportverzoek${business ? ' — zakelijke klant' : ''}`,
        `<p><b>Van:</b> ${who}</p>
         <p><b>Onderwerp:</b> ${esc(b.subject)}</p>
         <p><b>Bericht:</b><br>${esc(b.message)}</p>
         <p><b>Contact:</b> ${esc(b.email || (u && u.email) || '')} ${esc(b.phone || '')}</p>
         ${mailBtn(`${SITE_URL}/admin`, 'Open support-inbox')}`)
    ).catch(() => {});
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});

// ---------------- customer: requests (gratis) ----------------
function cleanPhotos(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(d => typeof d === 'string'
    && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d)
    && d.length < 3500000).slice(0, max || 3);
}
app.post('/api/requests', requireRole('customer'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.service || !b.description) return res.status(400).json({ error: 'invalid' });
    let targetProId = '', targetProName = '';
    if (b.targetProId) {
      const p = await store.findUserById(String(b.targetProId));
      if (p && p.role === 'pro') { targetProId = p.id; targetProName = p.company || p.name; }
    }
    const r = await store.addRequest({
      customerId: req.user.id,
      customerType: req.user.customerType || 'particulier',
      company: req.user.company || '',
      intent: b.intent === 'orientatie' ? 'orientatie' : 'opdracht',
      timing: String(b.timing || '').slice(0, 60),
      service: String(b.service).slice(0, 120),
      zip: String(b.zip || '').slice(0, 80),
      street: String(b.street || '').slice(0, 120),
      houseNumber: String(b.houseNumber || '').slice(0, 20),
      houseAdd: String(b.houseAdd || '').slice(0, 20),
      description: String(b.description).slice(0, 4000),
      name: req.user.name,
      phone: String(b.phone || '').slice(0, 40),
      email: req.user.email,
      lang: b.lang === 'pl' ? 'pl' : 'nl',
      photos: cleanPhotos(b.photos),
      targetProId, targetProName, direct: !!targetProId,
    });
    res.json({ request: r });
    notifyNewRequest(r, req.user).catch(() => {});
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.get('/api/requests/mine', requireRole('customer'), async (req, res) => {
  try {
    const reqs = await store.requestsByCustomer(req.user.id);
    const list = await Promise.all(reqs.map(async r => {
      const claims = await store.claimsByRequest(r.id);
      const responders = [];
      for (const c of claims) {
        const p = await store.findUserById(c.proId);
        if (!p) continue;
        const rating = await proRating(p.id);
        responders.push({ id: p.id, company: p.company || p.name, city: p.city || '', tier: tierInfo(rating), rating, kvkVerified: !!(p.kvk && p.verifiedKvk && p.kvk === p.verifiedKvk) });
      }
      return { ...r, claims: claims.length, status: r.status || 'open', assignedProId: r.assignedProId || '', assignedProName: r.assignedProName || '', responders };
    }));
    res.json({ requests: list });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant: bestaande aanvraag bewerken
app.post('/api/requests/:id', requireRole('customer'), async (req, res) => {
  try {
    const r = await store.findRequest(req.params.id);
    if (!r || r.customerId !== req.user.id) return res.status(404).json({ error: 'not_found' });
    if ((r.status || 'open') === 'cancelled') return res.status(409).json({ error: 'cancelled' });
    const b = req.body || {};
    const patch = {};
    if (b.service !== undefined) patch.service = String(b.service).slice(0, 120);
    if (b.description !== undefined) patch.description = String(b.description).slice(0, 4000);
    if (b.timing !== undefined) patch.timing = String(b.timing).slice(0, 60);
    if (b.zip !== undefined) patch.zip = String(b.zip).slice(0, 80);
    if (b.phone !== undefined) patch.phone = String(b.phone).slice(0, 40);
    if (b.intent !== undefined) patch.intent = b.intent === 'orientatie' ? 'orientatie' : 'opdracht';
    const u = await store.updateRequest(r.id, patch);
    res.json({ request: { ...u, claims: await store.claimsCountByRequest(u.id) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant: annuleren / heropenen
app.post('/api/requests/:id/cancel', requireRole('customer'), async (req, res) => {
  try {
    const r = await store.findRequest(req.params.id);
    if (!r || r.customerId !== req.user.id) return res.status(404).json({ error: 'not_found' });
    await store.updateRequest(r.id, { status: 'cancelled' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/requests/:id/reopen', requireRole('customer'), async (req, res) => {
  try {
    const r = await store.findRequest(req.params.id);
    if (!r || r.customerId !== req.user.id) return res.status(404).json({ error: 'not_found' });
    await store.updateRequest(r.id, { status: 'open', assignedProId: '', assignedProName: '' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant: aanvraag toewijzen aan 1 vakman (uit de reageerders)
app.post('/api/requests/:id/assign', requireRole('customer'), async (req, res) => {
  try {
    const r = await store.findRequest(req.params.id);
    if (!r || r.customerId !== req.user.id) return res.status(404).json({ error: 'not_found' });
    const proId = String((req.body || {}).proId || '');
    const claims = await store.claimsByRequest(r.id);
    if (!claims.some(c => c.proId === proId)) return res.status(400).json({ error: 'not_a_responder' });
    const p = await store.findUserById(proId);
    await store.updateRequest(r.id, { status: 'assigned', assignedProId: proId, assignedProName: p ? (p.company || p.name) : '' });
    res.json({ ok: true, assignedProName: p ? (p.company || p.name) : '' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- pro: leads + claim + billing ----------------
async function leadView(r, pro) {
  const claimed = await store.claimExists(pro.id, r.id);
  const base = {
    id: r.id, service: r.service, zip: r.zip, description: r.description,
    createdAt: r.createdAt, lang: r.lang, claimed,
    customerType: r.customerType || 'particulier',
    intent: r.intent || 'opdracht', timing: r.timing || '',
    direct: !!r.targetProId,
    price: proLeadPrice(r, pro),
    photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
    matchesSpec: pro.spec && r.service && r.service.toLowerCase().includes(pro.spec.toLowerCase().split(' ')[0]),
  };
  if (claimed) { base.name = r.name; base.phone = r.phone; base.email = r.email; base.company = r.company || ''; base.photos = r.photos || []; base.street = r.street || ''; base.houseNumber = r.houseNumber || ''; base.houseAdd = r.houseAdd || ''; }
  return base;
}

app.get('/api/leads', requireRole('pro'), async (req, res) => {
  try {
    const pro = req.user;
    const ci = await creditInfo(pro);
    const openAll = (await store.openRequests())
      .filter(r => !r.targetProId || r.targetProId === pro.id)
      // testaccount ziet uitsluitend zijn eigen (directe) testaanvragen
      .filter(r => !pro.testAccount || r.targetProId === pro.id);
    const leads = [];
    for (const r of openAll) {
      const claimed = await store.claimExists(pro.id, r.id);
      const cnt = await store.claimsCountByRequest(r.id);
      if (!claimed && cnt >= 3) continue; // vol (max 3 reacties)
      const lv = await leadView(r, pro);
      lv.spotsLeft = Math.max(0, 3 - cnt);
      leads.push(lv);
    }
    res.json({
      leads,
      creditsLeft: ci.freeAvailable,
      creditsUsed: ci.usedTotal,
      welcomeLeft: ci.welcomeRemaining, monthlyLeft: ci.monthlyRemaining,
      tier: ci.tier, rating: ci.rating,
      price: priceInfo(),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/leads/:id/claim', requireRole('pro'), async (req, res) => {
  try {
    const pro = req.user;
    if (!isVerifiedPro(pro)) return res.status(403).json({ error: 'kvk_required' });
    const r = await store.findRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
    if (pro.testAccount && r.targetProId !== pro.id) return res.status(403).json({ error: 'test_account' });
    if (await store.claimExists(pro.id, r.id)) return res.json({ ok: true, lead: await leadView(r, pro) });
    if ((r.status || 'open') !== 'open') return res.status(409).json({ ok: false, error: 'closed' });
    if ((await store.claimsCountByRequest(r.id)) >= 3) return res.status(409).json({ ok: false, error: 'full' });

    const ci = await creditInfo(pro);
    if (ci.freeAvailable > 0) {
      const bucket = ci.welcomeRemaining > 0 ? 'welcome' : 'monthly';
      await store.addClaim({ proId: pro.id, requestId: r.id, free: true, paid: true, amountGross: 0, amountNet: 0, amountVat: 0, bucket });
      return res.json({ ok: true, free: true, lead: await leadView(r, pro), creditsLeft: ci.freeAvailable - 1 });
    }
    // betaling vereist
    res.json({ ok: false, paymentRequired: true, price: proLeadPrice(r, pro) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Ontgrendelen met betaling. Maakt een Stripe Checkout-sessie (PLN).
// Zonder Stripe-sleutel valt het terug op een demo (lead direct als betaald markeren).
// De definitieve bevestiging komt via de webhook (checkout.session.completed).
app.post('/api/leads/:id/checkout', requireRole('pro'), async (req, res) => {
  const pro = req.user;
  if (!isVerifiedPro(pro)) return res.status(403).json({ error: 'kvk_required' });
  const r = await store.findRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (pro.testAccount && r.targetProId !== pro.id) return res.status(403).json({ error: 'test_account' });
  if (await store.claimExists(pro.id, r.id)) return res.json({ ok: true, lead: await leadView(r, pro) });
  if ((r.status || 'open') !== 'open') return res.status(409).json({ ok: false, error: 'closed' });
  if ((await store.claimsCountByRequest(r.id)) >= 3) return res.status(409).json({ ok: false, error: 'full' });

  const ci = await creditInfo(pro);
  if (ci.freeAvailable > 0) { // nog gratis tegoed
    const bucket = ci.welcomeRemaining > 0 ? 'welcome' : 'monthly';
    await store.addClaim({ proId: pro.id, requestId: r.id, free: true, paid: true, amountGross: 0, amountNet: 0, amountVat: 0, bucket });
    return res.json({ ok: true, free: true, lead: await leadView(r, pro) });
  }

  if (!stripe) { // geen Stripe geconfigureerd → demo
    const p = proLeadPrice(r, pro);
    const claim = await store.addClaim({ proId: pro.id, requestId: r.id, free: false, paid: true, amountGross: p.gross, amountNet: p.net, amountVat: p.vat, invoiceNo: await store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online' });
    fakturaXlExport(claim, pro, r).catch(() => {});
    return res.json({ ok: true, demo: true, lead: await leadView(r, pro) });
  }

  try {
    const p = proLeadPrice(r, pro);
    const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    const base = process.env.BASE_URL || `${proto}://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['ideal', 'card', 'bancontact'], // iDEAL = standaard in NL
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: Math.round(p.gross * 100),
          product_data: { name: `Budomatch lead: ${r.service}`, description: (p.orientation ? 'Oriëntatie-lead (50%) — ' : '') + 'ontgrendeling aanvraag (btw verlegd / reverse charge)' },
        },
      }],
      metadata: { proId: pro.id, requestId: r.id },
      success_url: `${base}/dashboard?paid=${encodeURIComponent(r.id)}`,
      cancel_url: `${base}/dashboard?cancel=1`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout-fout:', e.message);
    res.status(502).json({ error: 'stripe' });
  }
});

app.get('/api/billing', requireRole('pro'), async (req, res) => {
  try {
    const raw = (await store.claimsByPro(req.user.id)).sort((a, b) => b.createdAt - a.createdAt);
    const claims = await Promise.all(raw.map(async c => ({
      id: c.id, createdAt: c.createdAt, free: c.free, gross: c.amountGross, net: c.amountNet, vat: c.amountVat,
      invoiceNo: c.invoiceNo || null, invoiceDate: c.invoiceDate || c.createdAt, method: c.method || 'online',
      service: ((await store.findRequest(c.requestId)) || {}).service || '',
    })));
    const paidTotal = claims.filter(c => !c.free).reduce((s, c) => s + c.gross, 0);
    const ci = await creditInfo(req.user);
    res.json({
      claims, creditsUsed: ci.usedTotal, creditsLeft: ci.freeAvailable,
      welcomeLeft: ci.welcomeRemaining, monthlyLeft: ci.monthlyRemaining, tier: ci.tier, rating: ci.rating,
      freeLeads: PRICING.freeLeads, paidTotalGross: +paidTotal.toFixed(2),
      price: priceInfo(),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Bedrijfsprofiel + werkgebied opslaan (vakman)
app.post('/api/account', requireRole(), async (req, res) => {
  try {
    const b = req.body || {}, patch = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 80);
    if (b.phone !== undefined) patch.phone = String(b.phone).slice(0, 40);
    if (b.street !== undefined) patch.street = String(b.street).slice(0, 120);
    if (b.houseNumber !== undefined) patch.houseNumber = String(b.houseNumber).slice(0, 20);
    if (b.houseAdd !== undefined) patch.houseAdd = String(b.houseAdd).slice(0, 20);
    if (b.postcode !== undefined) patch.postcode = String(b.postcode).slice(0, 12);
    if (b.city !== undefined) patch.city = String(b.city).slice(0, 80);
    const u = await store.updateUser(req.user.id, patch);
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/profile', requireRole('pro'), async (req, res) => {
  try {
    const b = req.body || {}, patch = {};
    if (b.company !== undefined) patch.company = String(b.company).slice(0, 120);
    if (b.bio !== undefined) patch.bio = String(b.bio).slice(0, 2000);
    if (b.website !== undefined) patch.website = String(b.website).slice(0, 200);
    if (b.phone !== undefined) patch.phone = String(b.phone).slice(0, 40);
    if (b.city !== undefined) patch.city = String(b.city).slice(0, 80);
    if (b.spec !== undefined) patch.spec = String(b.spec).slice(0, 80);
    if (b.nip !== undefined) patch.nip = String(b.nip).toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 20); // btw-nummer (bijv. NL123456789B01) — komt op de factuur
    if (b.workZip !== undefined) patch.workZip = String(b.workZip).slice(0, 20);
    if (b.kvk !== undefined) patch.kvk = String(b.kvk).replace(/\D/g, '').slice(0, 8);
    if (b.workRadius !== undefined) patch.workRadius = Math.min(500, Math.max(0, parseInt(b.workRadius, 10) || 0));
    if (Array.isArray(b.workCategories)) patch.workCategories = b.workCategories.slice(0, 41).map(x => String(x).slice(0, 60));
    if (Array.isArray(b.photos)) patch.photos = cleanPhotos(b.photos, 6);
    if (b.logo !== undefined) { const l = cleanPhotos([b.logo], 1)[0]; patch.logo = l || ''; }
    if (patch.city) { const g = await geocodeNL(patch.city); if (g) { patch.lat = g.lat; patch.lng = g.lng; } }
    if (b.website !== undefined) { patch.websitePreview = patch.website ? (await fetchSitePreview(patch.website)) : null; }
    const u = await store.updateUser(req.user.id, patch);
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- openbare bedrijfsprofielen (voor klanten) ----------------
// Haalt een linkvoorbeeld (Open Graph) op van de bedrijfswebsite
async function fetchSitePreview(url) {
  try {
    let u = String(url).trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Budomatch/1.0)' }, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return { url: u };
    const html = (await r.text()).slice(0, 250000);
    const meta = prop => {
      let m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\\\']' + prop + '["\\\'][^>]*content=["\\\']([^"\\\']+)', 'i'));
      if (!m) m = html.match(new RegExp('<meta[^>]+content=["\\\']([^"\\\']+)["\\\'][^>]*(?:property|name)=["\\\']' + prop + '["\\\']', 'i'));
      return m ? m[1] : '';
    };
    let title = meta('og:title') || ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '');
    let desc = meta('og:description') || meta('description') || '';
    let img = meta('og:image') || meta('og:image:url') || '';
    try { if (img && !/^https?:\/\//i.test(img)) img = new URL(img, u).href; } catch (e) {}
    const dec = s => String(s)
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    return { url: u, title: dec(title).slice(0, 140), description: dec(desc).slice(0, 240), image: img.slice(0, 500) };
  } catch (e) { return { url: String(url) }; }
}
async function publicProfile(u) {
  const rating = await proRating(u.id);
  return {
    id: u.id, company: u.company || u.name, spec: u.spec || '', city: u.city || '',
    bio: u.bio || '', website: u.website || '', logo: u.logo || '', photos: u.photos || [],
    websitePreview: u.websitePreview || null,
    workCategories: u.workCategories || [], workRadius: u.workRadius || 0,
    kvk: u.kvk || '', kvkVerified: !!(u.kvk && u.verifiedKvk && u.kvk === u.verifiedKvk), kvkName: u.kvkName || '',
    rating, tier: tierInfo(rating), createdAt: u.createdAt || 0,
  };
}
// KvK-controle: haalt bedrijfsgegevens op en verifieert registratie (vereist KVK_API_KEY).
app.get('/api/kvk/:number', requireRole('pro'), async (req, res) => {
  try {
    const num = String(req.params.number).replace(/\D/g, '');
    if (num.length !== 8) return res.json({ ok: false, error: 'invalid' });
    if (!process.env.KVK_API_KEY) {
      // Geen API-sleutel: nummer opslaan en de beheerder mailen, zodat het
      // bedrijf handmatig geverifieerd kan worden (beheerpaneel → Gebruikers).
      await store.updateUser(req.user.id, { kvk: num });
      sendMail(`KvK-verificatie aangevraagd — ${esc(req.user.company || req.user.name)}`,
        mailWrap('KvK-verificatie aangevraagd',
          `<p><b>${esc(req.user.company || req.user.name)}</b> (${esc(req.user.email)}) heeft KvK-nummer <b>${esc(num)}</b> ingevuld en wacht op handmatige verificatie.</p>
           ${mailBtn(`${SITE_URL}/admin`, 'Verifieer in beheerpaneel')}`),
        null, FB_ADMIN || undefined).catch(() => {});
      return res.json({ ok: false, configured: false, saved: true });
    }
    const r = await fetch(`https://api.kvk.nl/api/v2/zoeken?kvkNummer=${num}`, { headers: { apikey: process.env.KVK_API_KEY } });
    if (!r.ok) return res.json({ ok: false, error: 'lookup', status: r.status });
    const d = await r.json();
    const item = (d.resultaten || [])[0];
    if (!item) return res.json({ ok: false, error: 'not_found' });
    const name = item.naam || '';
    const city = item.plaats || (item.adres && item.adres.binnenlandsAdres && item.adres.binnenlandsAdres.plaats) || '';
    const adr = (item.adres && item.adres.binnenlandsAdres) || {};
    const kvkAddress = {
      street: adr.straatnaam || '',
      houseNumber: [adr.huisnummer, adr.huisletter].filter(Boolean).join(''),
      postcode: adr.postcode || '',
      city: adr.plaats || city,
    };
    const dup = (await store.listPros()).find(p => p.id !== req.user.id && p.verifiedKvk === num);
    if (dup) return res.json({ ok: false, error: 'duplicate' });
    await store.updateUser(req.user.id, { kvk: num, verifiedKvk: num, kvkName: name, kvkAddress });
    res.json({ ok: true, kvk: num, name, city, type: item.type || '', address: kvkAddress });
  } catch (e) { console.error('KvK-fout:', e.message); res.json({ ok: false, error: 'server' }); }
});
// Btw-nummer-controle via euvatapi.com (EU VIES-databases). Vereist EUVAT_API_KEY.
// Bij succes wordt het geverifieerde nummer opgeslagen — dat komt op de lead-factuur.
// Gedeelde VIES-validatie via euvatapi.com. Geeft { ok, vat, name, address, city }
// of { ok:false, error/configured }.
async function vatValidate(raw) {
  let num = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^\d/.test(num)) num = 'NL' + num; // zonder landcode → NL aannemen
  if (num.length < 8 || num.length > 14) return { ok: false, error: 'invalid' };
  if (!process.env.EUVAT_API_KEY) return { ok: false, configured: false };
  const r = await fetch(`https://euvatapi.com/api/v1/validate?access_key=${encodeURIComponent(process.env.EUVAT_API_KEY)}&vat_number=${encodeURIComponent(num)}`);
  if (!r.ok) return { ok: false, error: 'lookup', status: r.status };
  const d = await r.json();
  if (!d.success) { console.error('EUVAT-fout:', JSON.stringify(d.error || d)); return { ok: false, error: 'lookup' }; }
  if (d.database === 'failure') return { ok: false, error: 'unavailable' }; // VIES-lidstaat tijdelijk offline
  if (!d.valid) return { ok: false, error: d.format_valid === false ? 'invalid' : 'not_found' };
  const address = d.company_address || '';
  // NL-adres eindigt op "1234 AB PLAATS" → plaats eruit halen (best effort)
  const m = address.toUpperCase().match(/\d{4}\s?[A-Z]{2}\s+([A-Z\-\s.'`]+)$/);
  const city = m ? m[1].trim().toLowerCase().replace(/(^|[\s\-'])\S/g, c => c.toUpperCase()) : '';
  return { ok: true, vat: num, name: d.company_name || '', address, city };
}
app.get('/api/vat/:number', rateLimit('vat', 10, 60 * 60e3), requireRole('pro'), async (req, res) => {
  try {
    const v = await vatValidate(req.params.number);
    if (!v.ok) return res.json(v);
    await store.updateUser(req.user.id, { nip: v.vat, verifiedVat: v.vat, vatName: v.name, vatAddress: v.address });
    res.json({ ok: true, vat: v.vat, name: v.name, address: v.address, city: v.city });
  } catch (e) { console.error('VAT-fout:', e.message); res.json({ ok: false, error: 'server' }); }
});
// Publieke lookup voor het registratieformulier: zoekt bedrijfsgegevens op bij het
// btw-nummer (autofill) en geeft een kortlevend ondertekend token mee, zodat de
// registratie het nummer als geverifieerd kan opslaan zonder tweede API-call.
app.get('/api/vat-lookup/:number', rateLimit('vatlookup', 10, 15 * 60e3), async (req, res) => {
  try {
    const v = await vatValidate(req.params.number);
    if (!v.ok) return res.json(v);
    res.json({ ok: true, vat: v.vat, name: v.name, city: v.city, token: A.sign({ t: 'vatreg', vat: v.vat, name: v.name }, 1 / 24) });
  } catch (e) { console.error('VAT-lookup-fout:', e.message); res.json({ ok: false, error: 'server' }); }
});
app.get('/api/pros', async (req, res) => {
  try {
    const pros = await store.listPros();
    const list = await Promise.all(pros.filter(p => p.company || p.name).map(publicProfile));
    list.sort((a, b) => (b.rating.avg - a.rating.avg) || (b.rating.count - a.rating.count) || (b.createdAt - a.createdAt));
    res.json({ pros: list });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.get('/api/pros/:id', async (req, res) => {
  try {
    const u = await store.findUserById(req.params.id);
    if (!u || u.role !== 'pro') return res.status(404).json({ error: 'not_found' });
    if (!isVerifiedPro(u)) return res.status(404).json({ error: 'inactive' });
    const rv = (await store.reviewsByPro(u.id)).map(r => ({
      rating: r.rating, comment: r.comment || '', name: (String(r.customerName || '').split(' ')[0] || 'Klant'), createdAt: r.createdAt,
    }));
    res.json({ pro: await publicProfile(u), reviews: rv });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant zoekt passende vakmensen: juiste categorie ÉN binnen de straal van de vakman.
app.get('/api/match', requireRole('customer'), async (req, res) => {
  try {
    const category = String(req.query.category || '').trim().toLowerCase();
    const city = String(req.query.city || '').trim();
    if (!category || !city) return res.json({ pros: [], need: true });
    const cust = await geocodeNL(city);
    if (!cust) return res.json({ pros: [], geocodeFailed: true });
    const pros = await store.listPros();
    const out = [];
    for (const p of pros) {
      const cats = (p.workCategories || []).map(c => String(c).toLowerCase());
      if (!cats.includes(category)) continue;
      if (!isVerifiedPro(p)) continue; // profiel pas actief na KvK-controle
      if (p.lat == null || p.lng == null) continue;
      const distance = haversineKm(cust, { lat: p.lat, lng: p.lng });
      if (distance > (p.workRadius || 30)) continue;
      const prof = await publicProfile(p);
      prof.distanceKm = Math.round(distance);
      out.push(prof);
    }
    out.sort((a, b) => (b.tier.bonus - a.tier.bonus) || (b.rating.avg - a.rating.avg) || (a.distanceKm - b.distanceKm));
    res.json({ pros: out });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- Faktura XL (Poolse boekhouding + KSeF) ----------------
// Elke BETAALDE lead-ontgrendeling wordt ook als factuur aangemaakt in
// Faktura XL (fakturaxl.pl) en doorgestuurd naar KSeF, zodat de verkoop
// rechtsgeldig in de Poolse administratie staat. Het Faktura XL-nummer wordt
// daarna het leidende factuurnummer in de app (zelfde nummer op de PDF).
// Vereist FAKTURAXL_API_KEY. Optioneel: FAKTURAXL_KSEF=0 (niet naar KSeF),
// FAKTURAXL_VAT (standaard "np" — nie podlega, art. 28b / reverse charge).
const FAKTURAXL_URL = process.env.FAKTURAXL_URL || 'https://program.fakturaxl.pl/api';
const xmlEsc = s => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const cdata = s => `<![CDATA[${String(s == null ? '' : s).replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
async function fxlPost(path, xml) {
  const r = await fetch(`${FAKTURAXL_URL}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body: xml,
  });
  const body = await r.text();
  return { status: r.status, body, tag: t => (body.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1] };
}
async function fakturaXlExport(claim, pro, request) {
  if (!process.env.FAKTURAXL_API_KEY || !pro) return;
  if (pro.testAccount) { console.log('[fakturaxl] testaccount — export overgeslagen'); return; }
  try {
    const d = new Date(claim.invoiceDate || claim.createdAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ka = pro.kvkAddress || {};
    const land = /^[A-Z]{2}/.test(pro.nip || '') ? pro.nip.slice(0, 2) : 'NL';
    const bedrag = Number(claim.amountGross || 0).toFixed(2);
    // Eigen nummerserie voor Budomatch (standaard "BM"), afgeleid van de gapless
    // interne teller — zo mengen de facturen niet met andere bedrijven op
    // hetzelfde Faktura XL-account. FAKTURAXL_SERIA="" schakelt dit uit
    // (dan nummert Faktura XL zelf, evt. per afdeling via FAKTURAXL_DZIAL_ID).
    const seria = process.env.FAKTURAXL_SERIA !== undefined ? process.env.FAKTURAXL_SERIA : 'BM';
    const im = String(claim.invoiceNo || '').match(/^(\d{4})-(\d+)$/);
    const eigenNr = (seria && im) ? `${seria}/${parseInt(im[2], 10)}/${im[1]}` : '';
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<dokument>
  <api_token>${xmlEsc(process.env.FAKTURAXL_API_KEY)}</api_token>
  <typ_faktury>0</typ_faktury>${eigenNr ? `\n  <numer_faktury>${xmlEsc(eigenNr)}</numer_faktury>` : ''}
  <data_wystawienia>${date}</data_wystawienia>
  <data_sprzedazy>${date}</data_sprzedazy>
  <termin_platnosci_data>${date}</termin_platnosci_data>
  <waluta>EUR</waluta>${process.env.FAKTURAXL_DZIAL_ID ? `\n  <id_dzialy_firmy>${xmlEsc(process.env.FAKTURAXL_DZIAL_ID)}</id_dzialy_firmy>` : ''}
  <status>2</status>
  <data_oplacenia>${date}</data_oplacenia>
  <kwota_oplacona>${bedrag}</kwota_oplacona>
  <rodzaj_platnosci>Przelew</rodzaj_platnosci>
  <nabywca>
    <firma_lub_osoba_prywatna>0</firma_lub_osoba_prywatna>
    <nazwa>${cdata(pro.kvkName || pro.company || pro.name)}</nazwa>
    <nip>${xmlEsc((pro.nip || '').replace(/[^A-Z0-9]/gi, ''))}</nip>
    <ulica_i_numer>${cdata((ka.street ? (ka.street + ' ' + (ka.houseNumber || '')).trim() : '') || pro.address || '')}</ulica_i_numer>
    <kod_pocztowy>${xmlEsc(ka.postcode || pro.postcode || '')}</kod_pocztowy>
    <miejscowosc>${cdata(ka.city || pro.city || '')}</miejscowosc>
    <kraj>${xmlEsc(land)}</kraj>
    <email>${xmlEsc(pro.email || '')}</email>
  </nabywca>
  <faktura_pozycje>
    <pozycja>
      <nazwa>${cdata(`Budomatch lead: ${(request && request.service) || 'aanvraag'} — odblokowanie zapytania / ontgrendeling aanvraag`)}</nazwa>
      <ilosc>1</ilosc>
      <jm>szt.</jm>
      <cena_netto>${bedrag}</cena_netto>
      <vat>${xmlEsc(process.env.FAKTURAXL_VAT || 'np')}</vat>
    </pozycja>
  </faktura_pozycje>
  <uwagi>${cdata(`Odwrotne obciążenie / reverse charge (btw verlegd) — art. 28b ustawy o VAT; podatek VAT rozlicza nabywca. Ref: Budomatch ${claim.invoiceNo || claim.id}`)}</uwagi>
</dokument>`;
    const r = await fxlPost('dokument_dodaj.php', xml);
    const kod = r.tag('kod'), id = r.tag('dokument_id'), nr = r.tag('dokument_nr');
    if (kod !== '1' || !id) {
      console.error('[fakturaxl] aanmaken mislukt, kod:', kod || r.status, String(r.body).slice(0, 300));
      await store.updateClaim(claim.id, { fxlError: 'create_' + (kod || r.status) });
      return;
    }
    const patch = { fxlId: id, fxlNr: nr || '', fxlError: '' };
    if (nr) patch.invoiceNo = nr; // Faktura XL / KSeF-nummer is leidend
    if (process.env.FAKTURAXL_KSEF !== '0') {
      try {
        const k = await fxlPost('dokument_ksef_wyslanie.php',
          `<?xml version="1.0" encoding="UTF-8"?>\n<dokument><api_token>${xmlEsc(process.env.FAKTURAXL_API_KEY)}</api_token><dokument_id>${id}</dokument_id></dokument>`);
        const kk = k.tag('kod');
        patch.fxlKsef = kk === '49' ? 'ok' : 'error_' + (kk || k.status);
        if (kk !== '49') console.error('[fakturaxl] KSeF-verzending mislukt, kod:', kk, String(k.body).slice(0, 300));
      } catch (e) { patch.fxlKsef = 'error'; console.error('[fakturaxl] KSeF:', e.message); }
    }
    await store.updateClaim(claim.id, patch);
    console.log(`[fakturaxl] factuur ${nr || id} aangemaakt${patch.fxlKsef === 'ok' ? ' + naar KSeF verstuurd' : ''}`);
  } catch (e) {
    console.error('[fakturaxl] export mislukt:', e.message);
    try { await store.updateClaim(claim.id, { fxlError: 'network' }); } catch (e2) {}
  }
}

// ---------------- PDF-factuur (Poolse verkoper, zonder btw / reverse charge) ----------------
app.get('/api/invoice/:id', requireRole('pro'), async (req, res) => {
  try {
    const c = (await store.claimsByPro(req.user.id)).find(x => x.id === req.params.id);
    if (!c) return res.status(404).send('Factuur niet gevonden');
    if (c.free || !c.invoiceNo) return res.status(400).send('Geen factuur voor een gratis lead');
    const r = (await store.findRequest(c.requestId)) || {};
    const b = req.user;
    const eur = n => '\u20ac ' + Number(n || 0).toFixed(2).replace('.', ',');
    const dt = ms => { const d = new Date(ms); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
    const date = dt(c.invoiceDate || c.createdAt);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="factuur-${c.invoiceNo}.pdf"`);
    doc.pipe(res);
    doc.font(INVOICE_FONT);

    doc.fontSize(22).fillColor('#1a1a1a').text('FAKTURA / FACTUUR', 50, 50);
    doc.fontSize(10).fillColor('#555');
    doc.text(`Nr / Numer: ${c.invoiceNo}`, 300, 55, { width: 245, align: 'right' });
    doc.text(`Datum / Data: ${date}`, 300, 70, { width: 245, align: 'right' });

    const y = 115;
    doc.fontSize(11).fillColor('#111').text('Sprzedawca / Verkoper', 50, y);
    doc.fontSize(9.5).fillColor('#333')
      .text(SELLER.name, 50, y + 17, { width: 240 })
      .text(SELLER.addr, 50, y + 31)
      .text(`${SELLER.zipcity}, ${SELLER.country}`, 50, y + 45)
      .text(`NIP: ${SELLER.nip}   REGON: ${SELLER.regon}`, 50, y + 59)
      .text(SELLER.email, 50, y + 73);
    doc.fontSize(11).fillColor('#111').text('Nabywca / Afnemer', 320, y);
    const ka = b.kvkAddress || {};
    const buyerName = b.kvkName || b.company || b.name;
    const buyerAddr = ((ka.street ? (ka.street + ' ' + (ka.houseNumber || '')).trim() : '') || b.address || '');
    const buyerZipCity = ([ka.postcode, ka.city].filter(Boolean).join(' ') || [b.zip, b.city].filter(Boolean).join(' '));
    doc.fontSize(9.5).fillColor('#333')
      .text(buyerName, 320, y + 17, { width: 225 })
      .text(buyerAddr, 320, y + 31, { width: 225 })
      .text(buyerZipCity, 320, y + 45)
      .text(b.kvk ? `KvK: ${b.kvk}${b.nip ? '  BTW: ' + b.nip : ''}` : (b.nip ? `BTW/NIP: ${b.nip}` : ''), 320, y + 59, { width: 225 })
      .text(b.email || '', 320, y + 73);

    let ty = y + 110;
    doc.moveTo(50, ty).lineTo(545, ty).strokeColor('#ccc').stroke();
    doc.fontSize(9).fillColor('#666')
      .text('Omschrijving / Opis', 55, ty + 7)
      .text('Aantal', 320, ty + 7)
      .text('Bedrag', 425, ty + 7, { width: 115, align: 'right' });
    ty += 26;
    doc.fontSize(10).fillColor('#111')
      .text(`Budomatch lead: ${r.service || 'aanvraag'} \u2014 ontgrendeling / odblokowanie`, 55, ty, { width: 250 })
      .text('1', 320, ty)
      .text(eur(c.amountGross), 425, ty, { width: 115, align: 'right' });
    ty += 44;
    doc.moveTo(50, ty).lineTo(545, ty).strokeColor('#ccc').stroke();
    doc.fontSize(10).fillColor('#333')
      .text('Subtotaal / Netto', 300, ty + 10, { width: 160, align: 'right' })
      .text(eur(c.amountNet), 470, ty + 10, { width: 75, align: 'right' })
      .text('BTW / VAT (0% \u2014 verlegd)', 300, ty + 26, { width: 160, align: 'right' })
      .text(eur(0), 470, ty + 26, { width: 75, align: 'right' });
    doc.fontSize(13).fillColor('#111')
      .text('Totaal / Suma', 300, ty + 46, { width: 160, align: 'right' })
      .text(eur(c.amountGross), 470, ty + 46, { width: 75, align: 'right' });

    doc.fontSize(9).fillColor('#555')
      .text('Odwrotne obci\u0105\u017cenie \u2014 podatek VAT rozlicza nabywca.', 50, ty + 90, { width: 495 })
      .text('Btw verlegd naar de afnemer (reverse charge). Er is geen btw in rekening gebracht.', 50, ty + 104, { width: 495 })
      .text(`Betaalwijze / Sposób p\u0142atno\u015bci: online. Betaald / Zap\u0142acono: ${date}.`, 50, ty + 128, { width: 495 });
    doc.fontSize(8).fillColor('#999').text(`Budomatch \u00b7 ${SELLER.email}`, 50, 778, { width: 495, align: 'center', lineBreak: false });
    doc.end();
  } catch (e) { console.error('Factuur-fout:', e.message); if (!res.headersSent) res.status(500).send('Kon factuur niet maken'); }
});

// ---------------- chat / berichten (klant ⇆ vakman) ----------------
// Een gesprek (thread) bestaat zodra een vakman een aanvraag heeft ontgrendeld.
// Toegang: de betrokken vakman en de klant-eigenaar van de aanvraag.
// Een thread is óf een klant⇆vakman gesprek (over een aanvraag) óf een
// vakman⇆vakman gesprek (over een collega-klus / projob).
async function resolveThread(rid, pid) {
  const r = await store.findRequest(rid);
  if (r) return { kind: 'request', request: r, service: r.service };
  const j = await store.findProJob(rid);
  if (j && pid === j.takenByProId) return { kind: 'projob', job: j, posterProId: j.posterProId, takenByProId: j.takenByProId, service: j.service };
  return null;
}
async function threadAccess(user, requestId, proId) {
  const ctx = await resolveThread(requestId, proId);
  if (!ctx) return null;
  if (ctx.kind === 'request') {
    if (!(await store.claimExists(proId, requestId))) return null;
    if (user.role === 'pro' && user.id === proId) return ctx;
    if (user.role === 'customer' && ctx.request.customerId === user.id) return ctx;
    return null;
  }
  if (user.role === 'pro' && (user.id === ctx.posterProId || user.id === ctx.takenByProId)) return ctx;
  return null;
}
async function proRating(proId) {
  const rv = await store.reviewsByPro(proId);
  if (!rv.length) return { avg: 0, count: 0 };
  const avg = rv.reduce((s, r) => s + (r.rating || 0), 0) / rv.length;
  return { avg: Math.round(avg * 10) / 10, count: rv.length };
}
// Tier op basis van reviews (score op /10 = gemiddelde × 2). Geeft extra gratis leads per maand.
function tierInfo(rating) {
  const score = rating.count ? rating.avg * 2 : 0;
  let key = 'brons', label = 'Brons', bonus = 1;
  if (rating.count && score >= 7) { key = 'goud'; label = 'Goud'; bonus = 3; }
  else if (rating.count && score >= 4) { key = 'zilver'; label = 'Zilver'; bonus = 2; }
  return { key, label, bonus, score: Math.round(score * 10) / 10 };
}
const monthKey = d => { const x = new Date(d); return x.getFullYear() + '-' + (x.getMonth() + 1); };
// Geocoding: kleine tabel voor veelvoorkomende NL-plaatsen (werkt zonder internet),
// anders val terug op OpenStreetMap Nominatim.
const NL_CITIES = {
  amsterdam: [52.3728, 4.8936], rotterdam: [51.9244, 4.4777], 'den haag': [52.0705, 4.3007], 'the hague': [52.0705, 4.3007],
  utrecht: [52.0907, 5.1214], eindhoven: [51.4416, 5.4697], groningen: [53.2194, 6.5665], tilburg: [51.5606, 5.0919],
  almere: [52.3508, 5.2647], breda: [51.5719, 4.7683], nijmegen: [51.8126, 5.8372], apeldoorn: [52.2112, 5.9699],
  haarlem: [52.3874, 4.6462], arnhem: [51.9851, 5.8987], amersfoort: [52.1561, 5.3878], zaanstad: [52.4389, 4.8167],
  'den bosch': [51.6978, 5.3037], "'s-hertogenbosch": [51.6978, 5.3037], zwolle: [52.5168, 6.0830], leiden: [52.1601, 4.4970],
  maastricht: [50.8514, 5.6910], dordrecht: [51.8133, 4.6901], ede: [52.0402, 5.6649], leeuwarden: [53.2012, 5.7999],
  alkmaar: [52.6324, 4.7534], emmen: [52.7792, 6.9069], delft: [52.0116, 4.3571], venlo: [51.3704, 6.1724],
  deventer: [52.2551, 6.1639], hilversum: [52.2242, 5.1758], amstelveen: [52.3114, 4.8701], hoorn: [52.6425, 5.0597],
  aalsmeer: [52.2645, 4.7621], bussum: [52.2769, 5.1614], purmerend: [52.5050, 4.9592], roosendaal: [51.5306, 4.4654],
};
async function geocodeNL(q) {
  const raw = String(q || '').toLowerCase().trim(); if (!raw) return null;
  const cityKey = raw.replace(/[0-9]/g, '').replace(/\s+/g, ' ').trim().replace(/\s+[a-z]{2}$/, '').trim();
  if (NL_CITIES[cityKey]) return { lat: NL_CITIES[cityKey][0], lng: NL_CITIES[cityKey][1] };
  for (const k in NL_CITIES) { if (cityKey.length > 3 && (cityKey.includes(k) || k.includes(cityKey))) return { lat: NL_CITIES[k][0], lng: NL_CITIES[k][1] }; }
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Budomatch/1.0 (info@budomatch.nl)' } });
    const d = await r.json();
    if (d && d[0]) return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) };
  } catch (e) { /* stil */ }
  return null;
}
function haversineKm(a, b) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Credit-overzicht: welkomstbucket (5 eenmalig) + maandbonus op basis van tier.
async function creditInfo(pro) {
  const claims = await store.claimsByPro(pro.id);
  const free = claims.filter(c => c.free);
  const welcomeUsed = free.filter(c => c.bucket !== 'monthly').length;
  let welcomeRemaining = Math.max(0, PRICING.freeLeads - welcomeUsed);
  const rating = await proRating(pro.id);
  const tier = tierInfo(rating);
  const cm = monthKey(Date.now());
  const monthlyUsed = free.filter(c => c.bucket === 'monthly' && monthKey(c.createdAt) === cm).length;
  let monthlyRemaining = Math.max(0, tier.bonus - monthlyUsed);
  if (pro.testAccount) { welcomeRemaining = 0; monthlyRemaining = 0; } // testaccount betaalt altijd
  return {
    welcomeRemaining, monthlyRemaining, freeAvailable: welcomeRemaining + monthlyRemaining,
    tier, rating, paidUsed: claims.filter(c => !c.free).length, usedTotal: claims.length,
  };
}

app.get('/api/threads', requireRole(), async (req, res) => {
  try {
    const u = req.user, out = [];
    const build = async (r, proId, withName, customerType, phone) => {
      const msgs = await store.messagesByThread(r.id, proId);
      const last = msgs[msgs.length - 1] || null;
      out.push({
        requestId: r.id, proId, service: r.service, with: withName, phone: phone || '',
        customerType: customerType || 'particulier', intent: r.intent || 'opdracht', kind: 'request',
        rating: await proRating(proId),
        last: last ? { type: last.type, text: last.text || '', amount: last.amount || null } : null,
        lastAt: last ? last.createdAt : 0,
        unread: msgs.filter(m => m.fromId !== u.id && m.fromRole !== 'system' && !(m.readBy || []).includes(u.id)).length,
      });
    };
    if (u.role === 'pro') {
      for (const c of await store.claimsByPro(u.id)) {
        const r = await store.findRequest(c.requestId); if (!r) continue;
        const who = (r.customerType === 'zakelijk' && r.company) ? r.company : r.name;
        await build(r, u.id, who, r.customerType, r.phone);
      }
      for (const j of await store.proJobsForPro(u.id)) {
        if (j.status !== 'taken' || !j.takenByProId) continue;
        const otherId = (u.id === j.posterProId) ? j.takenByProId : j.posterProId;
        const other = await store.findUserById(otherId);
        const msgs = await store.messagesByThread(j.id, j.takenByProId);
        const last = msgs[msgs.length - 1] || null;
        out.push({
          requestId: j.id, proId: j.takenByProId, service: j.service,
          with: other ? (other.company || other.name) : 'Vakman', phone: (other && other.phone) || '',
          kind: 'projob', intent: 'opdracht', rating: await proRating(otherId),
          last: last ? { type: last.type, text: last.text || '', amount: last.amount || null } : null,
          lastAt: last ? last.createdAt : j.createdAt,
          unread: msgs.filter(m => m.fromId !== u.id && m.fromRole !== 'system' && !(m.readBy || []).includes(u.id)).length,
        });
      }
    } else {
      for (const r of await store.requestsByCustomer(u.id)) {
        for (const c of await store.claimsByRequest(r.id)) {
          const pro = await store.findUserById(c.proId);
          await build(r, c.proId, pro ? (pro.company || pro.name) : 'Vakman', r.customerType, pro && pro.phone);
        }
      }
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    res.json({ threads: out });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.get('/api/threads/:rid/:pid/messages', requireRole(), async (req, res) => {
  try {
    const u = req.user;
    const ctx = await threadAccess(u, req.params.rid, req.params.pid);
    if (!ctx) return res.status(403).json({ error: 'forbidden' });
    const msgs = await store.messagesByThread(req.params.rid, req.params.pid);
    for (const m of msgs) if (m.fromId !== u.id && !(m.readBy || []).includes(u.id)) await store.updateMessage(m.id, { readBy: [...(m.readBy || []), u.id] });
    let phone = '', withName = '', rating = { avg: 0, count: 0 }, reviewed = true;
    if (ctx.kind === 'request') {
      const r = ctx.request;
      if (u.role === 'pro') { phone = r.phone || ''; withName = (r.customerType === 'zakelijk' && r.company) ? r.company : r.name; }
      else { const pro = await store.findUserById(req.params.pid); phone = (pro && pro.phone) || ''; withName = pro ? (pro.company || pro.name) : 'Vakman'; }
      rating = await proRating(req.params.pid);
      reviewed = u.role === 'customer' ? await store.reviewExists(u.id, req.params.pid, req.params.rid) : true;
    } else {
      const otherId = (u.id === ctx.posterProId) ? ctx.takenByProId : ctx.posterProId;
      const other = await store.findUserById(otherId);
      phone = (other && other.phone) || ''; withName = other ? (other.company || other.name) : 'Vakman';
      rating = await proRating(otherId);
    }
    res.json({ messages: msgs, me: u.role, meId: u.id, kind: ctx.kind, phone, with: withName, rating, reviewed });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

async function notifyMessage(ctx, sender) {
  let to;
  if (ctx.kind === 'request') {
    if (sender.role === 'pro') to = ctx.request.email;
    else { const pro = await store.findUserById(ctx.takenByProId || sender._pid); to = pro && pro.email; }
  } else {
    const otherId = (sender.id === ctx.posterProId) ? ctx.takenByProId : ctx.posterProId;
    const other = await store.findUserById(otherId);
    to = other && other.email;
  }
  if (!to) return;
  await sendMail(`Nieuw bericht op Budomatch — ${esc(ctx.service)}`,
    mailWrap('Je hebt een nieuw bericht',
      `<p>Er is een nieuw bericht in je gesprek over "<b>${esc(ctx.service)}</b>".</p>
       ${mailBtn(`${SITE_URL}/dashboard`, 'Bekijk het bericht')}`),
    null, to);
}

app.post('/api/threads/:rid/:pid/messages', requireRole(), async (req, res) => {
  try {
    const u = req.user;
    const ctx = await threadAccess(u, req.params.rid, req.params.pid);
    if (!ctx) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    let type = ['quote', 'image', 'appointment'].includes(b.type) ? b.type : 'text';
    if (type === 'quote' && (u.role !== 'pro' || ctx.kind !== 'request')) return res.status(403).json({ error: 'pro_only' });
    const m = {
      requestId: req.params.rid, proId: req.params.pid,
      fromRole: u.role, fromId: u.id, fromName: u.company || u.name, type,
      text: String(b.text || '').slice(0, 4000),
      readBy: [u.id],
    };
    if (type === 'quote') {
      m.amount = Math.max(0, Math.round(Number(b.amount) * 100) / 100) || 0;
      m.status = 'sent'; m.text = String(b.text || '').slice(0, 2000);
    } else if (type === 'appointment') {
      m.date = String(b.date || '').slice(0, 20);
      m.time = String(b.time || '').slice(0, 10);
      if (!m.date) return res.status(400).json({ error: 'invalid' });
      m.status = 'sent'; m.text = String(b.text || '').slice(0, 500);
    } else if (type === 'image') {
      const img = cleanPhotos([b.image])[0];
      if (!img) return res.status(400).json({ error: 'invalid' });
      m.image = img; m.text = String(b.text || '').slice(0, 500);
    } else if (!m.text.trim()) {
      return res.status(400).json({ error: 'empty' });
    }
    await store.addMessage(m);
    notifyMessage(ctx, u).catch(() => {});
    res.json({ message: m });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant accepteert of wijst een offerte af
app.post('/api/messages/:id/quote', requireRole('customer'), async (req, res) => {
  try {
    const u = req.user;
    const m = await store.findMessage(req.params.id);
    if (!m || m.type !== 'quote') return res.status(404).json({ error: 'not_found' });
    const r = await store.findRequest(m.requestId);
    if (!r || r.customerId !== u.id) return res.status(403).json({ error: 'forbidden' });
    if (m.status !== 'sent') return res.json({ ok: true, status: m.status });
    const status = (req.body && req.body.action === 'accept') ? 'accepted' : 'declined';
    await store.updateMessage(m.id, { status });
    await store.addMessage({
      requestId: m.requestId, proId: m.proId, fromRole: 'system', fromId: u.id, fromName: u.name,
      type: 'system', text: status === 'accepted' ? 'quote_accepted' : 'quote_declined', readBy: [u.id],
    });
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Afspraak bevestigen/afwijzen (door de tegenpartij van wie 'm voorstelde)
app.post('/api/messages/:id/appointment', requireRole(), async (req, res) => {
  try {
    const u = req.user;
    const m = await store.findMessage(req.params.id);
    if (!m || m.type !== 'appointment') return res.status(404).json({ error: 'not_found' });
    if (!(await threadAccess(u, m.requestId, m.proId))) return res.status(403).json({ error: 'forbidden' });
    if (u.id === m.fromId) return res.status(403).json({ error: 'own' });
    if (m.status !== 'sent') return res.json({ ok: true, status: m.status });
    const status = (req.body && req.body.action === 'accept') ? 'accepted' : 'declined';
    await store.updateMessage(m.id, { status });
    await store.addMessage({
      requestId: m.requestId, proId: m.proId, fromRole: 'system', fromId: u.id, fromName: u.name,
      type: 'system', text: status === 'accepted' ? 'appt_accepted' : 'appt_declined', readBy: [u.id],
    });
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klant laat een beoordeling achter voor een vakman
app.post('/api/reviews', requireRole('customer'), async (req, res) => {
  try {
    const u = req.user, b = req.body || {};
    const proId = String(b.proId || ''), requestId = String(b.requestId || '');
    if (!(await threadAccess(u, requestId, proId))) return res.status(403).json({ error: 'forbidden' });
    if (await store.reviewExists(u.id, proId, requestId)) return res.status(409).json({ error: 'exists' });
    const rating = Math.min(5, Math.max(1, parseInt(b.rating, 10) || 0));
    if (!rating) return res.status(400).json({ error: 'invalid' });
    await store.addReview({ proId, customerId: u.id, requestId, rating, comment: String(b.comment || '').slice(0, 1000), customerName: u.name });
    await store.addMessage({ requestId, proId, fromRole: 'system', fromId: u.id, fromName: u.name, type: 'system', text: 'review_left', readBy: [u.id] });
    res.json({ ok: true, rating: await proRating(proId) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- collega-klussen (vakman → vakman, gratis) ----------------
app.post('/api/projobs', requireRole('pro'), async (req, res) => {
  try {
    const u = req.user, b = req.body || {};
    if (!b.service || !b.description) return res.status(400).json({ error: 'invalid' });
    const j = await store.addProJob({
      posterProId: u.id, posterName: u.company || u.name,
      service: String(b.service).slice(0, 120),
      description: String(b.description).slice(0, 4000),
      zip: String(b.zip || '').slice(0, 80),
      timing: String(b.timing || '').slice(0, 60),
      note: String(b.note || '').slice(0, 300),
      photos: cleanPhotos(b.photos),
    });
    res.json({ job: j });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Open collega-klussen van ándere vakmensen
app.get('/api/projobs', requireRole('pro'), async (req, res) => {
  try {
    const u = req.user;
    const open = (await store.openProJobs()).filter(j => j.posterProId !== u.id).map(j => ({
      id: j.id, service: j.service, description: j.description, zip: j.zip, timing: j.timing,
      note: j.note || '', posterName: j.posterName, createdAt: j.createdAt,
      photoCount: Array.isArray(j.photos) ? j.photos.length : 0,
    }));
    const mine = (await store.proJobsForPro(u.id)).filter(j => j.posterProId === u.id).map(j => ({
      id: j.id, service: j.service, status: j.status, createdAt: j.createdAt,
      description: j.description || '', zip: j.zip || '', timing: j.timing || '', note: j.note || '',
      taken: j.status === 'taken', photoCount: Array.isArray(j.photos) ? j.photos.length : 0,
    }));
    res.json({ jobs: open, mine });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Status aanpassen (Actueel = open / Opgelost) — alleen de plaatser
app.post('/api/projobs/:id/status', requireRole('pro'), async (req, res) => {
  try {
    const j = await store.findProJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'not_found' });
    if (j.posterProId !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    const status = (req.body && req.body.status === 'opgelost') ? 'opgelost' : 'open';
    await store.updateProJob(j.id, { status });
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Verwijderen — alleen de plaatser
app.post('/api/projobs/:id/delete', requireRole('pro'), async (req, res) => {
  try {
    const j = await store.findProJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'not_found' });
    if (j.posterProId !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    await store.deleteProJob(j.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Bewerken — alleen de plaatser
app.post('/api/projobs/:id/edit', requireRole('pro'), async (req, res) => {
  try {
    const j = await store.findProJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'not_found' });
    if (j.posterProId !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {}; const patch = {};
    if (b.service !== undefined) patch.service = String(b.service).slice(0, 120);
    if (b.description !== undefined) patch.description = String(b.description).slice(0, 2000);
    if (b.zip !== undefined) patch.zip = String(b.zip).slice(0, 80);
    if (b.timing !== undefined) patch.timing = String(b.timing).slice(0, 60);
    if (b.note !== undefined) patch.note = String(b.note).slice(0, 300);
    await store.updateProJob(j.id, patch);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Eigen reviews (vakman)
app.get('/api/reviews/mine', requireRole('pro'), async (req, res) => {
  try {
    const rv = (await store.reviewsByPro(req.user.id)).map(r => ({
      rating: r.rating, comment: r.comment || '', name: (String(r.customerName || '').split(' ')[0] || 'Klant'), createdAt: r.createdAt,
    }));
    res.json({ reviews: rv, rating: await proRating(req.user.id) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Klus oppakken (gratis) → opent vakman⇆vakman gesprek
app.post('/api/projobs/:id/take', requireRole('pro'), async (req, res) => {
  try {
    const u = req.user;
    const j = await store.findProJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'not_found' });
    if (j.posterProId === u.id) return res.status(400).json({ error: 'own' });
    if (j.status !== 'open') return res.status(409).json({ error: 'taken' });
    await store.updateProJob(j.id, { status: 'taken', takenByProId: u.id, takenByName: u.company || u.name });
    // openingsbericht in het gesprek
    await store.addMessage({
      requestId: j.id, proId: u.id, fromRole: 'pro', fromId: u.id, fromName: u.company || u.name,
      type: 'text', text: `Ik pak deze klus graag op: ${j.service}`, readBy: [u.id],
    });
    notifyMessage({ kind: 'projob', service: j.service, posterProId: j.posterProId, takenByProId: u.id }, u).catch(() => {});
    res.json({ ok: true, requestId: j.id, proId: u.id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- AI assistant ----------------
// Kennisbank: alle regels, prijzen en functies van het platform, zodat de assistent
// vragen over Budomatch feitelijk juist beantwoordt. Prijzen komen live uit
// PRICING (beheerpaneel → Instellingen) — een prijswijziging werkt direct door.
function platformKnowledge() {
  const eur = n => '€ ' + n.toFixed(2).replace('.', ',');
  const orient = Math.round(Math.round(PRICING.gross * 100) * 0.5) / 100;
  return `PLATFORMKENNIS BUDOMATCH (feiten — baseer je antwoorden uitsluitend hierop; verzin geen functies of prijzen die hier niet staan):

VOOR KLANTEN (altijd gratis)
- Een klant maakt gratis een account aan en plaatst gratis een aanvraag: dienst, plaats, omschrijving, gewenste termijn en optioneel foto's (max 3) en adres.
- Type aanvraag: "opdracht" (moet echt uitgevoerd worden) of "oriëntatie" (klant oriënteert zich nog; vakmensen betalen dan 50% minder voor het contact).
- Maximaal 3 vakmensen kunnen op een aanvraag reageren. De contactgegevens van de klant zijn afgeschermd tot een vakman de aanvraag ontgrendelt.
- Zodra een vakman ontgrendelt, opent automatisch een chat in het portaal (tab Berichten). Daar kan de vakman ook een offerte sturen (bedrag + omschrijving) die de klant met één klik accepteert of afwijst, en een afspraak voorstellen die de klant bevestigt.
- De klant vergelijkt reageerders (bedrijfsnaam, reviews, niveau-badge, profiel via "Bekijk"), kan de klus aan één vakman toewijzen ("Kies deze vakman"), en kan de aanvraag bewerken, annuleren of heropenen.
- Na contact kan de klant de vakman beoordelen (1-5 sterren + opmerking) — één review per aanvraag.
- Tab "Vakman zoeken": kies soort werk + plaats en zie alleen KvK-geverifieerde bedrijven die dat werk doen én binnen wiens werkstraal de klant valt. Daar (en bij een nieuwe aanvraag) kan de klant een aanvraag direct naar één bedrijf sturen — alleen dat bedrijf ziet 'm dan. Vakmensen met een GOUDEN badge zijn direct te benaderen.
- Elk vakbedrijf heeft een openbare profielpagina met logo, omschrijving, projectfoto's, reviews, website-voorbeeld en een badge (Brons/Zilver/Goud).

VOOR VAKMENSEN (professionals)
- Registratie is kort: bedrijfsnaam, één hoofdspecialisme, plaats. Meer vakgebieden en de werkstraal stel je in onder Werkgebied; telefoon, btw-nummer en KvK vul je in je Bedrijfsprofiel in.
- Het profiel wordt pas ACTIEF na KvK-verificatie (Bedrijfsprofiel → KvK-controle): zonder verificatie is het bedrijf niet zichtbaar en kan het niet op aanvragen reageren. Eén KvK-nummer kan maar bij één account horen. De geverifieerde KvK-gegevens (naam + adres) komen op de factuur.
- Kosten: de eerste ${PRICING.freeLeads} leads zijn gratis (welkomsttegoed). Daarna kost het ontgrendelen van een aanvraag ${eur(PRICING.gross)} per lead; oriëntatie-aanvragen kosten de helft: ${eur(orient)}. Plaatsen van collega-klussen, chatten en het profiel zijn gratis. Betalen kan met iDEAL, creditcard of Bancontact.
- Btw: de btw wordt verlegd naar de afnemer (reverse charge, 0% op de factuur). De vakman vult zijn btw-nummer (btw-id) in bij Bedrijfsprofiel → Gegevens; dat komt op de factuur. Facturen (PDF) staan onder Account → Facturatie.
- Niveaus op basis van reviewscore (score op 10 = gemiddelde sterren × 2): Brons (score < 4) geeft +1 gratis lead per maand, Zilver (4-6) +2, Goud (7-10) +3 — bovenop het eenmalige welkomsttegoed. GOUD betekent ook: klanten kunnen je direct een opdracht sturen — extra zichtbaarheid.
- Collega-klussen (gratis USP): werk dat blijft liggen deel je gratis met collega-vakmensen; een collega pakt de klus op en er opent automatisch een vakman⇆vakman chat. Zo ontstaan samenwerkingen.
- Werkgebied: plaats/postcode + straal (km) + vinkjes voor alle vakgebieden die het bedrijf doet — dit bepaalt welke aanvragen je ziet en of klanten je vinden.

ACCOUNT & VEILIGHEID
- Wachtwoord vergeten? Op de inlogpagina staat "Wachtwoord vergeten?" — je krijgt een herstel-link per e-mail (1 uur geldig).
- Na registratie krijg je een bevestigingsmail; bevestig je e-mailadres via de link (banner in het dashboard, met knop om opnieuw te sturen).
- Twee-stapsverificatie (2FA) met een authenticator-app kan aan via Instellingen/Beveiliging, inclusief herstelcodes.

SUPPORT
- Vragen of problemen: in het dashboard via Helpdesk het supportformulier invullen — zakelijke klanten krijgen voorrang. Verwijs de gebruiker daarnaar als je een vraag niet met bovenstaande feiten kunt beantwoorden (bijv. over betalingen, een specifiek account of een storing).`;
}

// Statisch deel van het system prompt (cachebaar): rol + doel + kennisbank.
function systemPrompt(lang, mode) {
  const cats = lang === 'en' ? CATS_EN : CATS_NL;
  if (lang === 'en') {
    const goal = mode === 'customer'
      ? 'Your goal is to guide the customer: sharpen the job (scope, location, timing, indicative budget), pick the right trade, and write a clear job description. When complete, summarise it so the customer can paste it into the form.'
      : mode === 'pro'
      ? 'You assist the TRADESMAN (professional). Help them win and handle jobs: draft a professional, friendly reply or quote text to a (potential) customer based on the request, suggest the right questions to ask the customer, and give practical tips. When drafting a reply, write it ready-to-send in the customer\'s language, concise and concrete. Never invent prices or facts — leave placeholders like [price] where needed.'
      : 'Help choose the right trade, describe the job and explain how Budomatch works.';
    return `You are the AI assistant of Budomatch — a marketplace connecting residents in the Netherlands with reliable, local tradespeople.\nSpecialisations (41): ${cats}.\n${goal}\nAnswer in English, short, warm and concrete. For facts about how the platform works, rely strictly on the platform knowledge below (it is written in Dutch; answer in English).\n\n${platformKnowledge()}`;
  }
  const goal = mode === 'customer'
    ? 'Je doel is de klant soepel door het traject loodsen: de klus aanscherpen (omvang, locatie, gewenste termijn, indicatief budget), het juiste vakgebied kiezen, en een heldere klusomschrijving opstellen. Als die compleet is, vat je die kort samen zodat de klant hem in het formulier kan plakken.'
    : mode === 'pro'
    ? 'Je ondersteunt de VAKMAN (professional). Help hem opdrachten binnenhalen en afhandelen: stel een professionele, vriendelijke reactie of offertetekst op aan een (potentiële) klant op basis van de aanvraag, bedenk de juiste vragen om aan de klant te stellen, en geef praktische tips. Als je een reactie opstelt, schrijf die kant-en-klaar zodat de vakman hem direct kan versturen — in de taal van de klant, beknopt en concreet. Verzin nooit prijzen of feiten; gebruik desnoods een plaatshouder als [prijs].'
    : 'Help het juiste vakgebied kiezen, de klus beschrijven en leg uit hoe Budomatch werkt.';
  return `Je bent de AI-assistent van Budomatch — een marktplaats die bewoners in Nederland koppelt aan betrouwbare, lokale bouwvakmensen.\nVakgebieden (41): ${cats}.\n${goal}\nAntwoord in het Nederlands, kort, warm en concreet. Baseer feiten over het platform strikt op onderstaande platformkennis.\n\n${platformKnowledge()}`;
}
// Dynamisch deel (per gebruiker) — apart blok NÁ het cachebare deel, zodat de
// kennisbank voor alle gebruikers uit de prompt-cache komt.
function userContext(lang, user) {
  if (!user) return '';
  return lang === 'en'
    ? `You are talking to a logged-in ${user.role === 'pro' ? 'tradesman' : 'customer'}: ${user.name}${user.company ? ' (' + user.company + ')' : ''}.`
    : `Je praat met een ingelogde ${user.role === 'pro' ? 'vakman' : 'klant'}: ${user.name}${user.company ? ' (' + user.company + ')' : ''}.`;
}

app.post('/api/chat', rateLimit('chat', 40, 10 * 60e3), async (req, res) => {
  try {
    const lang = req.body.lang === 'en' ? 'en' : 'nl';
    const mode = ['customer', 'pro'].includes(req.body.mode) ? req.body.mode : 'site';
    const user = await getUser(req);
    const messages = (Array.isArray(req.body.messages) ? req.body.messages : [])
      .slice(-20)
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content }));

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.json({ reply: lang === 'pl'
        ? 'Asystent nie jest jeszcze skonfigurowany (brak klucza API).'
        : 'De assistent is nog niet geconfigureerd (geen API-sleutel ingesteld).' });
    }

    // Systeem als blokken: het grote statische deel (rol + kennisbank) met
    // prompt-caching, het kleine gebruikersdeel erna zodat de cache gedeeld
    // blijft tussen alle gebruikers.
    const system = [{ type: 'text', text: systemPrompt(lang, mode), cache_control: { type: 'ephemeral' } }];
    const who = userContext(lang, user);
    if (who) system.push({ type: 'text', text: who });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system, messages }),
    });
    if (!r.ok) { console.error('Anthropic', r.status, await r.text()); return res.status(502).json({ reply: lang === 'pl' ? 'Asystent chwilowo niedostępny.' : 'De assistent is even niet bereikbaar.' }); }
    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ reply: reply || (lang === 'pl' ? 'Brak odpowiedzi.' : 'Geen antwoord.') });
  } catch (e) { console.error('chat', e); res.status(500).json({ reply: 'Sorry, er ging iets mis.' }); }
});

// ---------------- e-mail (Resend) voor gast-aanvragen / aanmeldingen ----------------
async function sendMail(subject, html, attachments, to) {
  if (!process.env.RESEND_API_KEY) { console.log('[Resend niet ingesteld]', subject, to ? '→ ' + to : '', attachments ? `(+${attachments.length} bijlage(n))` : ''); return { skipped: true }; }
  const payload = { from: process.env.MAIL_FROM || 'Budomatch <onboarding@resend.dev>', to: to || process.env.MAIL_TO || 'info@budomatch.nl', subject, html };
  if (attachments && attachments.length) payload.attachments = attachments;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
  return r.json();
}
// Mail bij nieuwe opdracht: bevestiging aan klant + melding aan passende vakmensen
async function notifyNewRequest(r, customer) {
  try {
    if (customer && customer.email) {
      await sendMail(`Je aanvraag staat online — ${esc(r.service)}`,
        mailWrap('Je aanvraag staat online',
          `<p>Hoi ${esc(customer.name)},</p><p>Je aanvraag <b>${esc(r.service)}</b>${r.zip ? ` (${esc(r.zip)})` : ''} staat op Budomatch. Passende vakmensen kunnen nu reageren — je krijgt bericht zodra er reacties zijn.</p>
           <p style="color:#8A8270;border-left:3px solid #E7E1D2;padding-left:12px;margin:16px 0">${esc(r.description).slice(0, 600).replace(/\n/g, '<br>')}</p>
           ${mailBtn(`${SITE_URL}/dashboard`, 'Naar mijn aanvragen')}`),
        null, customer.email).catch(() => {});
    }
    let pros = [];
    if (r.targetProId) {
      const p = await store.findUserById(r.targetProId); if (p) pros = [p];
    } else {
      const cust = await geocodeNL(r.zip || '');
      const cat = String(r.service || '').toLowerCase();
      for (const p of await store.listPros()) {
        const cats = (p.workCategories || []).map(c => String(c).toLowerCase());
        if (!cats.includes(cat)) continue;
        if (!cust || p.lat == null || p.lng == null) continue;
        if (haversineKm(cust, { lat: p.lat, lng: p.lng }) > (p.workRadius || 30)) continue;
        pros.push(p);
      }
    }
    for (const p of pros.slice(0, 30)) {
      if (!p.email) continue;
      await sendMail(`Nieuwe aanvraag in jouw regio — ${esc(r.service)}`,
        mailWrap('Nieuwe aanvraag in jouw regio',
          `<p>Hoi ${esc(p.company || p.name)},</p><p>Er staat een nieuwe aanvraag voor <b>${esc(r.service)}</b>${r.zip ? ` (${esc(r.zip)})` : ''} die past bij jouw werkgebied. Wees er snel bij — maximaal 3 vakmensen per aanvraag.</p>
           ${mailBtn(`${SITE_URL}/dashboard`, 'Bekijk de aanvraag')}`),
        null, p.email).catch(() => {});
    }
  } catch (e) { console.error('notifyNewRequest:', e.message); }
}
// data-URL -> Resend-bijlage (max 3 foto's, alleen afbeeldingen)
function photoAttachments(photos) {
  if (!Array.isArray(photos)) return [];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  return photos.slice(0, 3).map((d, i) => {
    const m = typeof d === 'string' && d.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    return { filename: `foto${i + 1}.${ext[m[1]] || 'jpg'}`, content: m[2] };
  }).filter(Boolean);
}
app.post('/api/quote', rateLimit('quote', 10, 60 * 60e3), async (req, res) => {
  try { const b = req.body || {};
    const atts = photoAttachments(b.photos);
    await sendMail(`Offerteaanvraag (gast) — ${esc(b.service) || '-'}`,
      mailWrap('Offerteaanvraag (gast)',
        `<p><b>Dienst:</b> ${esc(b.service)}</p><p><b>Plaats:</b> ${esc(b.zip)}</p><p><b>Adres:</b> ${esc([[b.street, b.houseNumber].filter(Boolean).join(' '), b.houseAdd].filter(Boolean).join(' '))}</p><p><b>Omschrijving:</b><br>${esc(b.description)}</p><p><b>Naam:</b> ${esc(b.name)}</p><p><b>Tel:</b> ${esc(b.phone)}</p><p><b>E-mail:</b> ${esc(b.email)}</p><p><b>Foto's:</b> ${atts.length}</p>`),
      atts);
    res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});
app.post('/api/pro', rateLimit('prosignup', 10, 60 * 60e3), async (req, res) => {
  try { const b = req.body || {};
    await sendMail(`Vakman-aanmelding — ${esc(b.company) || '-'}`,
      mailWrap('Vakman-aanmelding',
        `<p><b>Bedrijf:</b> ${esc(b.company)}</p><p><b>Specialisatie:</b> ${esc(b.spec)}</p><p><b>Stad:</b> ${esc(b.city)}</p><p><b>E-mail:</b> ${esc(b.email)}</p>`));
    res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});

// ---------------- beheer (admin) ----------------
// Toegang: het account waarvan het e-mailadres gelijk is aan ADMIN_EMAIL. Paneel: /admin
const requireAdmin = async (req, res, next) => {
  try {
    const u = await getUser(req);
    if (!u) return res.status(401).json({ error: 'auth' });
    if (!FB_ADMIN || u.email.toLowerCase() !== FB_ADMIN) return res.status(403).json({ error: 'forbidden' });
    req.user = u; next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
};
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const users = await store.listUsers();
    const requests = await store.listRequests();
    const claims = await store.listClaims();
    const reviews = await store.listReviews();
    const pros = users.filter(u => u.role === 'pro');
    const paid = claims.filter(c => !c.free);
    res.json({
      stats: {
        customers: users.filter(u => u.role === 'customer').length,
        pros: pros.length,
        prosVerified: pros.filter(isVerifiedPro).length,
        blocked: users.filter(u => u.blocked).length,
        requestsTotal: requests.length,
        requestsOpen: requests.filter(r => (r.status || 'open') === 'open').length,
        claimsTotal: claims.length,
        claimsPaid: paid.length,
        revenueGross: +paid.reduce((s, c) => s + (c.amountGross || 0), 0).toFixed(2),
        fxlErrors: claims.filter(c => c.fxlError).length,
        reviews: reviews.length,
        supportOpen: (await store.listFeedback()).filter(f => f.kind === 'support' && (f.status || 'nieuw') !== 'afgerond').length,
      },
      recentRequests: requests.slice(0, 20).map(r => ({
        id: r.id, service: r.service, zip: r.zip || '', status: r.status || 'open',
        createdAt: r.createdAt, name: r.name || '', direct: !!r.targetProId,
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    let users = await store.listUsers();
    if (q) users = users.filter(u => `${u.email} ${u.name} ${u.company || ''} ${u.kvk || ''} ${u.city || ''}`.toLowerCase().includes(q));
    users.sort((a, b) => b.createdAt - a.createdAt);
    res.json({
      users: users.slice(0, 200).map(u => ({
        id: u.id, role: u.role, name: u.name, email: u.email, company: u.company || '',
        city: u.city || '', customerType: u.customerType || '', kvk: u.kvk || '',
        kvkVerified: isVerifiedPro(u), emailVerified: u.emailVerified !== false,
        blocked: !!u.blocked, createdAt: u.createdAt,
      })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
// Handmatige KvK-verificatie (bijv. zolang er geen KVK_API_KEY is, of bij twijfelgevallen)
app.post('/api/admin/users/:id/verify', requireAdmin, async (req, res) => {
  try {
    const u = await store.findUserById(req.params.id);
    if (!u || u.role !== 'pro') return res.status(404).json({ error: 'not_found' });
    const num = String((req.body || {}).kvk || u.kvk || '').replace(/\D/g, '');
    if (num.length !== 8) return res.status(400).json({ error: 'invalid_kvk' });
    const dup = (await store.listPros()).find(p => p.id !== u.id && p.verifiedKvk === num);
    if (dup) return res.status(409).json({ error: 'duplicate' });
    await store.updateUser(u.id, { kvk: num, verifiedKvk: num, kvkName: u.kvkName || u.company || u.name });
    // bedrijf informeren: profiel is nu actief
    sendMail('Je bedrijf is geverifieerd — Budomatch',
      mailWrap('Je bedrijf is geverifieerd 🎉',
        `<p>Goed nieuws, ${esc(u.name)}!</p><p><b>${esc(u.company || u.name)}</b> is geverifieerd (KvK ${esc(num)}). Je profiel is nu actief: je bent zichtbaar voor klanten en kunt op aanvragen reageren.</p>
         ${mailBtn(`${SITE_URL}/dashboard`, 'Naar je dashboard')}`),
      null, u.email).catch(() => {});
    res.json({ ok: true, kvk: num });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/admin/users/:id/block', requireAdmin, async (req, res) => {
  try {
    const u = await store.findUserById(req.params.id);
    if (!u) return res.status(404).json({ error: 'not_found' });
    if (u.email.toLowerCase() === FB_ADMIN) return res.status(400).json({ error: 'self' });
    const blocked = !!(req.body || {}).blocked;
    await store.updateUser(u.id, { blocked });
    res.json({ ok: true, blocked });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.get('/api/admin/support', requireAdmin, async (req, res) => {
  try {
    const items = (await store.listFeedback()).filter(f => f.kind === 'support')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(f => ({
        id: f.id, name: f.name || '', role: f.role || '', business: !!f.business,
        subject: f.subject || '', message: f.message || '', email: f.email || '', phone: f.phone || '',
        status: f.status || 'nieuw', createdAt: f.createdAt,
      }));
    res.json({ items });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.post('/api/admin/support/:id/status', requireAdmin, async (req, res) => {
  try {
    const f = await store.findFeedback(req.params.id);
    if (!f || f.kind !== 'support') return res.status(404).json({ error: 'not_found' });
    const status = ['nieuw', 'bezig', 'afgerond'].includes((req.body || {}).status) ? req.body.status : 'nieuw';
    await store.updateFeedback(f.id, { status });
    res.json({ ok: true, status });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
// Faktura XL: mislukte exports opnieuw proberen (max 1 request/s bij Faktura XL).
app.post('/api/admin/fakturaxl/retry', requireAdmin, async (req, res) => {
  try {
    if (!process.env.FAKTURAXL_API_KEY) return res.json({ ok: false, configured: false });
    const failed = (await store.listClaims()).filter(c => c.fxlError && !c.fxlId && !c.free && c.paid);
    let done = 0;
    for (const c of failed) {
      const pro = await store.findUserById(c.proId);
      const r = await store.findRequest(c.requestId);
      await fakturaXlExport(c, pro, r);
      const after = (await store.claimsByPro(c.proId)).find(x => x.id === c.id);
      if (after && after.fxlId) done++;
      await new Promise(rs => setTimeout(rs, 1100));
    }
    res.json({ ok: true, retried: failed.length, success: done });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
// Faktura XL: afdelingen (działy) ophalen, zodat de beheerder het juiste
// FAKTURAXL_DZIAL_ID kan kiezen (aparte nummering per bedrijfsonderdeel).
app.get('/api/admin/fakturaxl/dzialy', requireAdmin, async (req, res) => {
  try {
    if (!process.env.FAKTURAXL_API_KEY) return res.json({ configured: false, items: [] });
    const r = await fxlPost('dokument_lista_dzialow.php',
      `<?xml version="1.0" encoding="UTF-8"?>\n<dokument><api_token>${xmlEsc(process.env.FAKTURAXL_API_KEY)}</api_token></dokument>`);
    const items = [...String(r.body).matchAll(/<dzial>\s*<id>(\d+)<\/id>\s*<nazwa>(?:<!\[CDATA\[)?([^<\]]*)/g)]
      .map(m => ({ id: m[1], nazwa: m[2].trim() }));
    res.json({ configured: true, dzialId: process.env.FAKTURAXL_DZIAL_ID || '', items });
  } catch (e) { console.error('[fakturaxl] dzialy:', e.message); res.json({ configured: true, dzialId: process.env.FAKTURAXL_DZIAL_ID || '', items: [], error: 'lookup' }); }
});
// Instellingen: leadprijs en gratis welkomstleads — direct actief, zonder herstart.
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json({
    leadPriceGross: PRICING.gross,
    orientPriceGross: leadPrice({ intent: 'orientatie' }).gross,
    freeLeads: PRICING.freeLeads,
    defaults: { leadPriceGross: LEAD_PRICE_GROSS, freeLeads: FREE_LEADS },
  });
});
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {}, patch = {};
    if (b.leadPriceGross !== undefined) {
      const v = Math.round(Number(b.leadPriceGross) * 100) / 100;
      if (!(v >= 1 && v <= 500)) return res.status(400).json({ error: 'invalid_price' });
      patch.leadPriceGross = v;
    }
    if (b.freeLeads !== undefined) {
      const v = Math.round(Number(b.freeLeads));
      if (!(v >= 0 && v <= 100)) return res.status(400).json({ error: 'invalid_free' });
      patch.freeLeads = v;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'empty' });
    await store.updateSettings(patch);
    await loadPricing();
    res.json({
      ok: true,
      leadPriceGross: PRICING.gross,
      orientPriceGross: leadPrice({ intent: 'orientatie' }).gross,
      freeLeads: PRICING.freeLeads,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Publieke prijsinfo — homepage, FAQ en voorwaarden vullen hiermee hun vaste
// teksten, zodat een prijswijziging in het beheerpaneel overal direct zichtbaar is.
app.get('/api/pricing', (req, res) => {
  res.json({ gross: PRICING.gross, orient: leadPrice({ intent: 'orientatie' }).gross, freeLeads: PRICING.freeLeads });
});

app.get('/healthz', (_, res) => res.send('ok'));
// Optionele demo-accounts (zet SEED_DEMO=1). Idempotent.
async function seedDemo() {
  if (!process.env.SEED_DEMO) return;
  try {
    let k = await store.findUserByEmail('klant@budomatch.nl');
    if (!k) {
      k = await store.addUser({ role: 'customer', name: 'Demo Klant', email: 'klant@budomatch.nl', passHash: A.hashPassword('demo1234'), customerType: 'particulier', emailVerified: true });
      await store.addRequest({ customerId: k.id, customerType: 'particulier', company: '', intent: 'opdracht', timing: 'Binnen 1 maand', service: 'Badkamerspecialist', zip: '1011 AB', description: 'Complete badkamer renoveren, ca. 6 m2 — tegels, douche en meubel.', name: k.name, phone: '0612345678', email: k.email, lang: 'nl', photos: [] });
      await store.addRequest({ customerId: k.id, customerType: 'particulier', company: '', intent: 'orientatie', timing: 'Meer dan 3 maanden', service: 'Zonnepanelen', zip: '1011 AB', description: 'Orienteren op ca. 10 zonnepanelen op schuin dak.', name: k.name, phone: '0612345678', email: k.email, lang: 'nl', photos: [] });
    }
    const v = await store.findUserByEmail('vakman@budomatch.nl');
    if (!v) {
      const pro = await store.addUser({ role: 'pro', name: 'Demo Vakman', email: 'vakman@budomatch.nl', passHash: A.hashPassword('demo1234'), company: 'Demo Bouw BV', spec: 'Verbouwing', city: 'Amsterdam', phone: '0687654321', bio: 'Demonstratiebedrijf voor Budomatch.', workRadius: 30, workCategories: ['Badkamerspecialist', 'Verbouwing', 'Tegels zetten'], kvk: '12345678', verifiedKvk: '12345678', kvkName: 'Demo Bouw BV', emailVerified: true });
      const g = await geocodeNL('Amsterdam'); if (g) await store.updateUser(pro.id, { lat: g.lat, lng: g.lng });
    } else if (!(v.kvk && v.verifiedKvk && v.kvk === v.verifiedKvk)) {
      // bestaande demo-vakman alsnog verifieren + coordinaten zetten
      const g = await geocodeNL(v.city || 'Amsterdam');
      const patch = { kvk: '12345678', verifiedKvk: '12345678', kvkName: v.company || 'Demo Bouw BV' };
      if (!(v.workCategories && v.workCategories.length)) patch.workCategories = ['Badkamerspecialist', 'Verbouwing', 'Tegels zetten'];
      if (!v.workRadius) patch.workRadius = 30;
      if (g) { patch.lat = g.lat; patch.lng = g.lng; }
      await store.updateUser(v.id, patch);
    }
    console.log('[seed] demo-accounts gereed — klant@budomatch.nl / vakman@budomatch.nl (wachtwoord: demo1234)');
  } catch (e) { console.error('[seed] mislukt:', e.message); }
}
seedDemo();

// Stripe-testomgeving (zet SEED_TEST_PAYMENT=1). Maakt een geïsoleerd testaccount:
// asdf@gmail.com / admin1234 — geverifieerd, GEEN gratis tegoed, betaalt € 1 per
// lead (globale prijs blijft ongemoeid), wordt overgeslagen door Faktura XL, en
// krijgt één DIRECTE testaanvraag die andere vakmensen niet zien. Idempotent —
// bij elke start staat er weer een open testaanvraag klaar.
async function seedTestPayment() {
  if (!process.env.SEED_TEST_PAYMENT) return;
  try {
    let pro = await store.findUserByEmail('asdf@gmail.com');
    if (!pro) {
      pro = await store.addUser({
        role: 'pro', name: 'Stripe Test', email: 'asdf@gmail.com', passHash: A.hashPassword('admin1234'),
        company: 'Stripe Test BV', spec: 'Schilderwerk', city: 'Amsterdam', workRadius: 30,
        workCategories: ['Schilderwerk'], kvk: '99999999', verifiedKvk: '99999999', kvkName: 'Stripe Test BV',
        emailVerified: true, testAccount: true, testPriceGross: 1,
      });
      const g = await geocodeNL('Amsterdam'); if (g) await store.updateUser(pro.id, { lat: g.lat, lng: g.lng });
    }
    let klant = await store.findUserByEmail('asdf-klant@gmail.com');
    if (!klant) {
      klant = await store.addUser({ role: 'customer', name: 'Stripe Testklant', email: 'asdf-klant@gmail.com', passHash: A.hashPassword('admin1234'), customerType: 'particulier', emailVerified: true, testAccount: true });
    }
    // zorg dat er altijd één open, nog niet ontgrendelde testaanvraag klaarstaat
    const open = (await store.openRequests()).find(r => r.targetProId === pro.id && !(r.status && r.status !== 'open'));
    const unlocked = open ? await store.claimExists(pro.id, open.id) : true;
    if (!open || unlocked) {
      await store.addRequest({
        customerId: klant.id, customerType: 'particulier', company: '', intent: 'opdracht',
        timing: 'Binnen 1 maand', service: 'Schilderwerk', zip: '1011 AB',
        description: 'Stripe-testaanvraag — ontgrendelen kost € 1 (alleen zichtbaar voor het testaccount).',
        name: klant.name, phone: '0600000000', email: klant.email, lang: 'nl', photos: [],
        targetProId: pro.id, targetProName: pro.company, direct: true,
      });
    }
    console.log('[seed] Stripe-testomgeving gereed — asdf@gmail.com / admin1234 (lead kost € 1)');
  } catch (e) { console.error('[seed] testbetaling mislukt:', e.message); }
}
seedTestPayment();

app.listen(PORT, () => console.log(`Budomatch draait op poort ${PORT}`));
