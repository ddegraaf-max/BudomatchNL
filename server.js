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
  email: process.env.SELLER_EMAIL || 'info@budomatch.pl',
};

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

// ----- Pricing -----
const FREE_LEADS = 5;
const LEAD_PRICE_GROSS = 12.50;         // euro incl. btw
const VAT_RATE = 0;                      // 0% — btw verlegd (reverse charge, B2B NL)
const LEAD_PRICE_NET = +(LEAD_PRICE_GROSS / (1 + VAT_RATE)).toFixed(2);   // 12.50 (btw verlegd)
const LEAD_PRICE_VAT = +(LEAD_PRICE_GROSS - LEAD_PRICE_NET).toFixed(2);   // 0.00 (verlegd)
const CURRENCY = 'eur';

// Prijs per lead hangt af van het type aanvraag:
// - 'opdracht' (echte klus): volle prijs
// - 'orientatie' (klant oriënteert / wil iets kopen): 50% ontgrendelprijs
function leadPrice(r) {
  const factor = (r && r.intent === 'orientatie') ? 0.5 : 1;
  const gross = +(LEAD_PRICE_GROSS * factor).toFixed(2);
  const net = +(gross / (1 + VAT_RATE)).toFixed(2);
  const vat = +(gross - net).toFixed(2);
  return { gross, net, vat, vatRate: VAT_RATE, orientation: factor !== 1 };
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
        const p = leadPrice(r);
        await store.addClaim({
          proId, requestId, free: false, paid: true,
          amountGross: p.gross, amountNet: p.net, amountVat: p.vat,
          invoiceNo: await store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online',
          stripeSession: s.id, paymentIntent: s.payment_intent || null,
        });
      }
    }
  } catch (e) { console.error('Webhook-verwerking mislukt:', e.message); }
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- 41 specialisaties -----
const CATS_NL = "Aanbouw, Uitbouw, Opbouw, Airco, Architect, Asbest verwijderen, Badkamerspecialist, Bestraten, Cv-ketel, Dakbedekking, Dakkapel, Dakraam, Elektricien, Garagedeur, Gevelreiniging, Glas, Hekwerken, Inbraakbeveiliging, Isolatie, Keukenspecialist, Kozijnen, Laadpalen, Loodgieter, Ongediertebestrijding, Rolluiken, Schilderwerk, Schuifpui, Serre, Stucwerk, Tegels zetten, Thuisbatterij, Trap, Tuinaanleg, Tuinonderhoud, Ventilatie, Verbouwing, Vloeren, Vloerverwarming, Vochtbestrijding, Warmtepomp, Wellness, Zonnepanelen, Zonwering";
const CATS_EN = "Extension, Bump-out extension, Storey addition, Air conditioning, Architect, Asbestos removal, Bathroom, Paving, Boiler (CH), Roofing, Dormer, Roof window, Electrician, Garage door, Facade cleaning, Glazing, Fencing, Burglary protection, Insulation, Kitchen, Window frames, EV charging, Plumber, Pest control, Roller shutters, Painting, Sliding doors, Conservatory, Plastering, Tiling, Home battery, Stairs, Landscaping, Garden maintenance, Ventilation, Renovation, Flooring, Underfloor heating, Damp proofing, Heat pump, Wellness & sauna, Solar panels, Awnings & sun protection";

// ---------------- helpers ----------------
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
async function getUser(req) {
  const t = A.parseCookies(req).bm_token;
  const p = A.verify(t);
  if (!p) return null;
  const u = await store.findUserById(p.uid);
  return u || null;
}
async function publicUser(u) {
  if (!u) return null;
  const { passHash, twofaSecret, twofaTempSecret, twofaRecovery, ...rest } = u;
  rest.twofaEnabled = !!u.twofaEnabled;
  rest.twofaRecoveryLeft = (u.twofaRecovery || []).length;
  if (u.role === 'pro') {
    const ci = await creditInfo(u);
    rest.creditsUsed = ci.usedTotal;
    rest.creditsLeft = ci.freeAvailable;
    rest.rating = ci.rating;
    rest.tier = ci.tier;
    rest.welcomeLeft = ci.welcomeRemaining;
    rest.monthlyLeft = ci.monthlyRemaining;
    rest.bio = u.bio || ''; rest.website = u.website || ''; rest.logo = u.logo || '';
    rest.photos = u.photos || []; rest.workRadius = u.workRadius || 0; rest.workZip = u.workZip || '';
    rest.workCategories = u.workCategories || [];
    rest.kvk = u.kvk || ''; rest.kvkVerified = !!(u.kvk && u.verifiedKvk && u.kvk === u.verifiedKvk); rest.kvkName = u.kvkName || '';
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

// ---------------- 2FA (TOTP) ----------------
app.post('/api/login/2fa', async (req, res) => {
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
    A.setAuthCookie(res, A.sign({ uid: u.id, role: u.role }), isHttps(req));
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
      `<p><b>${esc(title)}</b> — <i>${type}</i></p><p>${esc(message) || '(geen toelichting)'}</p><p style="color:#888">Van ${esc(f.name)} · ${req.user.role === 'pro' ? 'vakman' : 'klant'} · ${esc(req.user.email)}</p>`,
      null, FB_ADMIN || undefined).catch(() => {});
    res.json({ feedback: f });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
app.get('/api/feedback', requireRole(), async (req, res) => {
  try {
    const items = (await store.listFeedback()).map(f => ({
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
app.post('/api/register', async (req, res) => {
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
    };
    if (role === 'pro') {
      u.company = String(b.company || '').trim();
      u.spec = String(b.spec || '').trim();
      u.city = String(b.city || '').trim();
      u.phone = String(b.phone || '').trim();
      u.nip = String(b.nip || '').trim();
      u.address = String(b.address || '').trim();
    } else {
      // Particulier of zakelijk (bedrijf)
      u.customerType = b.customerType === 'zakelijk' ? 'zakelijk' : 'particulier';
      if (u.customerType === 'zakelijk') {
        u.company = String(b.company || '').trim();
        u.nip = String(b.nip || '').trim();
      }
    }
    await store.addUser(u);
    A.setAuthCookie(res, A.sign({ uid: u.id, role: u.role }), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const b = req.body || {};
    const u = await store.findUserByEmail(String(b.email || ''));
    if (!u || !A.verifyPassword(String(b.password || ''), u.passHash))
      return res.status(401).json({ error: 'bad_credentials' });
    if (u.twofaEnabled) {
      return res.json({ twofaRequired: true, challenge: A.sign({ t: '2fa', uid: u.id }, 0.02) });
    }
    A.setAuthCookie(res, A.sign({ uid: u.id, role: u.role }), isHttps(req));
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/logout', (req, res) => { A.clearAuthCookie(res); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const u = await getUser(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  res.json({ user: await publicUser(u) });
});

// ---------------- support (klanten én bedrijven) ----------------
app.post('/api/support', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.message) return res.status(400).json({ error: 'invalid' });
    const u = await getUser(req);
    const who = u
      ? `${esc(u.name)} &lt;${esc(u.email)}&gt; (${u.role}${u.role === 'customer' ? '/' + (u.customerType || 'particulier') : ''}${u.company ? ' — ' + esc(u.company) : ''})`
      : 'gast';
    const business = (u && u.customerType === 'zakelijk') || (b.customerType === 'zakelijk');
    await sendMail(
      `${business ? '[ZAKELIJK] ' : ''}Support: ${esc(b.subject) || '(geen onderwerp)'}`,
      `<h2>Supportverzoek${business ? ' — zakelijke klant' : ''}</h2>
       <p><b>Van:</b> ${who}</p>
       <p><b>Onderwerp:</b> ${esc(b.subject)}</p>
       <p><b>Bericht:</b><br>${esc(b.message)}</p>
       <p><b>Contact:</b> ${esc(b.email || (u && u.email) || '')} ${esc(b.phone || '')}</p>`
    );
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
    price: leadPrice(r),
    photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
    matchesSpec: pro.spec && r.service && r.service.toLowerCase().includes(pro.spec.toLowerCase().split(' ')[0]),
  };
  if (claimed) { base.name = r.name; base.phone = r.phone; base.email = r.email; base.company = r.company || ''; base.photos = r.photos || []; }
  return base;
}

app.get('/api/leads', requireRole('pro'), async (req, res) => {
  try {
    const pro = req.user;
    const ci = await creditInfo(pro);
    const openAll = (await store.openRequests()).filter(r => !r.targetProId || r.targetProId === pro.id);
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
      price: { gross: LEAD_PRICE_GROSS, net: LEAD_PRICE_NET, vat: LEAD_PRICE_VAT, vatRate: VAT_RATE },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/leads/:id/claim', requireRole('pro'), async (req, res) => {
  try {
    const pro = req.user;
    if (!isVerifiedPro(pro)) return res.status(403).json({ error: 'kvk_required' });
    const r = await store.findRequest(req.params.id);
    if (!r) return res.status(404).json({ error: 'not_found' });
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
    res.json({ ok: false, paymentRequired: true, price: leadPrice(r) });
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
    const p = leadPrice(r);
    await store.addClaim({ proId: pro.id, requestId: r.id, free: false, paid: true, amountGross: p.gross, amountNet: p.net, amountVat: p.vat, invoiceNo: await store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online' });
    return res.json({ ok: true, demo: true, lead: await leadView(r, pro) });
  }

  try {
    const p = leadPrice(r);
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
      success_url: `${base}/dashboard.html?paid=${encodeURIComponent(r.id)}`,
      cancel_url: `${base}/dashboard.html?cancel=1`,
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
      freeLeads: FREE_LEADS, paidTotalGross: +paidTotal.toFixed(2),
      price: { gross: LEAD_PRICE_GROSS, net: LEAD_PRICE_NET, vat: LEAD_PRICE_VAT, vatRate: VAT_RATE },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// Bedrijfsprofiel + werkgebied opslaan (vakman)
app.post('/api/profile', requireRole('pro'), async (req, res) => {
  try {
    const b = req.body || {}, patch = {};
    if (b.company !== undefined) patch.company = String(b.company).slice(0, 120);
    if (b.bio !== undefined) patch.bio = String(b.bio).slice(0, 2000);
    if (b.website !== undefined) patch.website = String(b.website).slice(0, 200);
    if (b.phone !== undefined) patch.phone = String(b.phone).slice(0, 40);
    if (b.city !== undefined) patch.city = String(b.city).slice(0, 80);
    if (b.spec !== undefined) patch.spec = String(b.spec).slice(0, 80);
    if (b.workZip !== undefined) patch.workZip = String(b.workZip).slice(0, 20);
    if (b.kvk !== undefined) patch.kvk = String(b.kvk).replace(/\D/g, '').slice(0, 8);
    if (b.workRadius !== undefined) patch.workRadius = Math.min(500, Math.max(0, parseInt(b.workRadius, 10) || 0));
    if (Array.isArray(b.workCategories)) patch.workCategories = b.workCategories.slice(0, 41).map(x => String(x).slice(0, 60));
    if (Array.isArray(b.photos)) patch.photos = cleanPhotos(b.photos, 6);
    if (b.logo !== undefined) { const l = cleanPhotos([b.logo], 1)[0]; patch.logo = l || ''; }
    if (patch.city) { const g = await geocodeNL(patch.city); if (g) { patch.lat = g.lat; patch.lng = g.lng; } }
    const u = await store.updateUser(req.user.id, patch);
    res.json({ user: await publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});

// ---------------- openbare bedrijfsprofielen (voor klanten) ----------------
async function publicProfile(u) {
  const rating = await proRating(u.id);
  return {
    id: u.id, company: u.company || u.name, spec: u.spec || '', city: u.city || '',
    bio: u.bio || '', website: u.website || '', logo: u.logo || '', photos: u.photos || [],
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
    if (!process.env.KVK_API_KEY) return res.json({ ok: false, configured: false });
    const r = await fetch(`https://api.kvk.nl/api/v2/zoeken?kvkNummer=${num}`, { headers: { apikey: process.env.KVK_API_KEY } });
    if (!r.ok) return res.json({ ok: false, error: 'lookup', status: r.status });
    const d = await r.json();
    const item = (d.resultaten || [])[0];
    if (!item) return res.json({ ok: false, error: 'not_found' });
    const name = item.naam || '';
    const city = item.plaats || (item.adres && item.adres.binnenlandsAdres && item.adres.binnenlandsAdres.plaats) || '';
    const dup = (await store.listPros()).find(p => p.id !== req.user.id && p.verifiedKvk === num);
    if (dup) return res.json({ ok: false, error: 'duplicate' });
    await store.updateUser(req.user.id, { kvk: num, verifiedKvk: num, kvkName: name });
    res.json({ ok: true, kvk: num, name, city, type: item.type || '' });
  } catch (e) { console.error('KvK-fout:', e.message); res.json({ ok: false, error: 'server' }); }
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
    doc.fontSize(9.5).fillColor('#333')
      .text(b.company || b.name, 320, y + 17, { width: 225 })
      .text(b.address || '', 320, y + 31, { width: 225 })
      .text([b.zip, b.city].filter(Boolean).join(' '), 320, y + 45)
      .text(b.nip ? `BTW/NIP: ${b.nip}` : '', 320, y + 59)
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
    doc.fontSize(8).fillColor('#999').text(`Budomatch \u00b7 ${SELLER.email}`, 50, 790, { width: 495, align: 'center' });
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
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Budomatch/1.0 (info@budomatch.pl)' } });
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
  const welcomeRemaining = Math.max(0, FREE_LEADS - welcomeUsed);
  const rating = await proRating(pro.id);
  const tier = tierInfo(rating);
  const cm = monthKey(Date.now());
  const monthlyUsed = free.filter(c => c.bucket === 'monthly' && monthKey(c.createdAt) === cm).length;
  const monthlyRemaining = Math.max(0, tier.bonus - monthlyUsed);
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
    `<h2>Je hebt een nieuw bericht</h2><p>Er is een nieuw bericht in je gesprek over "<b>${esc(ctx.service)}</b>".</p><p>Log in op je Budomatch-portaal om te reageren.</p>`,
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
function systemPrompt(lang, user, mode) {
  const cats = lang === 'en' ? CATS_EN : CATS_NL;
  const who = user
    ? (lang === 'en'
        ? `You are talking to a logged-in ${user.role === 'pro' ? 'tradesman' : 'customer'}: ${user.name}${user.company ? ' (' + user.company + ')' : ''}.`
        : `Je praat met een ingelogde ${user.role === 'pro' ? 'vakman' : 'klant'}: ${user.name}${user.company ? ' (' + user.company + ')' : ''}.`)
    : '';
  if (lang === 'en') {
    const goal = mode === 'customer'
      ? 'Your goal is to guide the customer: sharpen the job (scope, location, timing, indicative budget), pick the right trade, and write a clear job description. When complete, summarise it so the customer can paste it into the form.'
      : mode === 'pro'
      ? 'You assist the TRADESMAN (professional). Help them win and handle jobs: draft a professional, friendly reply or quote text to a (potential) customer based on the request, suggest the right questions to ask the customer, and give practical tips. When drafting a reply, write it ready-to-send in the customer\'s language, concise and concrete. Never invent prices or facts — leave placeholders like [price] where needed.'
      : 'Help choose the right trade, describe the job and explain how Budomatch works.';
    return `You are the AI assistant of Budomatch — a marketplace connecting residents in the Netherlands with reliable, local tradespeople. ${who}\nSpecialisations (41): ${cats}.\n${goal}\nAnswer in English, short, warm and concrete. Do not invent fixed prices.`;
  }
  const goal = mode === 'customer'
    ? 'Je doel is de klant soepel door het traject loodsen: de klus aanscherpen (omvang, locatie, gewenste termijn, indicatief budget), het juiste vakgebied kiezen, en een heldere klusomschrijving opstellen. Als die compleet is, vat je die kort samen zodat de klant hem in het formulier kan plakken.'
    : mode === 'pro'
    ? 'Je ondersteunt de VAKMAN (professional). Help hem opdrachten binnenhalen en afhandelen: stel een professionele, vriendelijke reactie of offertetekst op aan een (potentiële) klant op basis van de aanvraag, bedenk de juiste vragen om aan de klant te stellen, en geef praktische tips. Als je een reactie opstelt, schrijf die kant-en-klaar zodat de vakman hem direct kan versturen — in de taal van de klant, beknopt en concreet. Verzin nooit prijzen of feiten; gebruik desnoods een plaatshouder als [prijs].'
    : 'Help het juiste vakgebied kiezen, de klus beschrijven en leg uit hoe Budomatch werkt.';
  return `Je bent de AI-assistent van Budomatch — een marktplaats die bewoners in Nederland koppelt aan betrouwbare, lokale bouwvakmensen. ${who}\nVakgebieden (41): ${cats}.\n${goal}\nAntwoord in het Nederlands, kort, warm en concreet. Verzin geen vaste prijzen.`;
}

app.post('/api/chat', async (req, res) => {
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

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: systemPrompt(lang, user, mode), messages }),
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
  const payload = { from: process.env.MAIL_FROM || 'Budomatch <onboarding@resend.dev>', to: to || process.env.MAIL_TO || 'info@budomatch.pl', subject, html };
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
        `<p>Hoi ${esc(customer.name)},</p><p>Je aanvraag <b>${esc(r.service)}</b>${r.zip ? ` (${esc(r.zip)})` : ''} staat op Budomatch. Passende vakmensen kunnen nu reageren — je krijgt bericht zodra er reacties zijn.</p><p style="color:#555">${esc(r.description).slice(0, 600).replace(/\n/g, '<br>')}</p>`,
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
        `<p>Hoi ${esc(p.company || p.name)},</p><p>Er staat een nieuwe aanvraag voor <b>${esc(r.service)}</b>${r.zip ? ` (${esc(r.zip)})` : ''} die past bij jouw werkgebied. Log in op Budomatch om te reageren — wees er snel bij (max. 3 vakmensen per aanvraag).</p>`,
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
app.post('/api/quote', async (req, res) => {
  try { const b = req.body || {};
    const atts = photoAttachments(b.photos);
    await sendMail(`Offerteaanvraag (gast) — ${esc(b.service) || '-'}`,
      `<h2>Offerteaanvraag</h2><p><b>Dienst:</b> ${esc(b.service)}</p><p><b>Plaats:</b> ${esc(b.zip)}</p><p><b>Omschrijving:</b><br>${esc(b.description)}</p><p><b>Naam:</b> ${esc(b.name)}</p><p><b>Tel:</b> ${esc(b.phone)}</p><p><b>E-mail:</b> ${esc(b.email)}</p><p><b>Foto's:</b> ${atts.length}</p>`,
      atts);
    res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});
app.post('/api/pro', async (req, res) => {
  try { const b = req.body || {};
    await sendMail(`Vakman-aanmelding — ${esc(b.company) || '-'}`,
      `<h2>Vakman-aanmelding</h2><p><b>Bedrijf:</b> ${esc(b.company)}</p><p><b>Specialisatie:</b> ${esc(b.spec)}</p><p><b>Stad:</b> ${esc(b.city)}</p><p><b>E-mail:</b> ${esc(b.email)}</p>`);
    res.json({ ok: true }); } catch (e) { console.error(e); res.status(500).json({ ok: false }); }
});

app.get('/healthz', (_, res) => res.send('ok'));
// Optionele demo-accounts (zet SEED_DEMO=1). Idempotent.
async function seedDemo() {
  if (!process.env.SEED_DEMO) return;
  try {
    let k = await store.findUserByEmail('klant@budomatch.nl');
    if (!k) {
      k = await store.addUser({ role: 'customer', name: 'Demo Klant', email: 'klant@budomatch.nl', passHash: A.hashPassword('demo1234'), customerType: 'particulier' });
      await store.addRequest({ customerId: k.id, customerType: 'particulier', company: '', intent: 'opdracht', timing: 'Binnen 1 maand', service: 'Badkamerspecialist', zip: '1011 AB', description: 'Complete badkamer renoveren, ca. 6 m2 — tegels, douche en meubel.', name: k.name, phone: '0612345678', email: k.email, lang: 'nl', photos: [] });
      await store.addRequest({ customerId: k.id, customerType: 'particulier', company: '', intent: 'orientatie', timing: 'Meer dan 3 maanden', service: 'Zonnepanelen', zip: '1011 AB', description: 'Orienteren op ca. 10 zonnepanelen op schuin dak.', name: k.name, phone: '0612345678', email: k.email, lang: 'nl', photos: [] });
    }
    const v = await store.findUserByEmail('vakman@budomatch.nl');
    if (!v) {
      const pro = await store.addUser({ role: 'pro', name: 'Demo Vakman', email: 'vakman@budomatch.nl', passHash: A.hashPassword('demo1234'), company: 'Demo Bouw BV', spec: 'Verbouwing', city: 'Amsterdam', phone: '0687654321', bio: 'Demonstratiebedrijf voor Budomatch.', workRadius: 30, workCategories: ['Badkamerspecialist', 'Verbouwing', 'Tegels zetten'], kvk: '12345678', verifiedKvk: '12345678', kvkName: 'Demo Bouw BV' });
      const g = await geocodeNL('Amsterdam'); if (g) await store.updateUser(pro.id, { lat: g.lat, lng: g.lng });
    }
    console.log('[seed] demo-accounts gereed — klant@budomatch.nl / vakman@budomatch.nl (wachtwoord: demo1234)');
  } catch (e) { console.error('[seed] mislukt:', e.message); }
}
seedDemo();

app.listen(PORT, () => console.log(`Budomatch draait op poort ${PORT}`));
