// Budomatch — Express server
// Static site + accounts (klanten/professionals) + leads + facturatie + Stripe + AI-assistent.
// Node 18+ (global fetch). Deps: express, stripe.

const express = require('express');
const path = require('path');
const store = require('./lib/store');
const A = require('./lib/auth');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

// ----- Pricing -----
const FREE_LEADS = 10;
const LEAD_PRICE_GROSS = 12.50;         // euro incl. btw
const VAT_RATE = 0;                      // 0% — btw verlegd (reverse charge, B2B NL)
const LEAD_PRICE_NET = +(LEAD_PRICE_GROSS / (1 + VAT_RATE)).toFixed(2);   // 12.50 (btw verlegd)
const LEAD_PRICE_VAT = +(LEAD_PRICE_GROSS - LEAD_PRICE_NET).toFixed(2);   // 0.00 (verlegd)
const CURRENCY = 'eur';

// ----- Stripe (alleen geladen als er een sleutel is) -----
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

const app = express();

// Stripe-webhook MOET de ruwe body krijgen → vóór express.json() registreren.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Stripe webhook-signatuur ongeldig:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const proId = s.metadata && s.metadata.proId;
    const requestId = s.metadata && s.metadata.requestId;
    // idempotent: alleen claim aanmaken als die nog niet bestaat
    if (proId && requestId && !store.claimExists(proId, requestId)) {
      store.addClaim({
        proId, requestId, free: false, paid: true,
        amountGross: LEAD_PRICE_GROSS, amountNet: LEAD_PRICE_NET, amountVat: LEAD_PRICE_VAT,
        invoiceNo: store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online',
        stripeSession: s.id, paymentIntent: s.payment_intent || null,
      });
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----- 41 specialisaties -----
const CATS_NL = "Aanbouw, Airco, Architect, Asbest verwijderen, Badkamerspecialist, Bestraten, Cv-ketel, Dakbedekking, Dakkapel, Dakraam, Elektricien, Garagedeur, Gevelreiniging, Glas, Hekwerken, Inbraakbeveiliging, Isolatie, Keukenspecialist, Kozijnen, Laadpalen, Loodgieter, Ongediertebestrijding, Rolluiken, Schilderwerk, Schuifpui, Serre, Stucwerk, Tegels zetten, Thuisbatterij, Trap, Tuinaanleg, Tuinonderhoud, Ventilatie, Verbouwing, Vloeren, Vloerverwarming, Vochtbestrijding, Warmtepomp, Wellness, Zonnepanelen, Zonwering";
const CATS_EN = "Extension, Air conditioning, Architect, Asbestos removal, Bathroom, Paving, Boiler (CH), Roofing, Dormer, Roof window, Electrician, Garage door, Facade cleaning, Glazing, Fencing, Burglary protection, Insulation, Kitchen, Window frames, EV charging, Plumber, Pest control, Roller shutters, Painting, Sliding doors, Conservatory, Plastering, Tiling, Home battery, Stairs, Landscaping, Garden maintenance, Ventilation, Renovation, Flooring, Underfloor heating, Damp proofing, Heat pump, Wellness & sauna, Solar panels, Awnings & sun protection";

// ---------------- helpers ----------------
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
function getUser(req) {
  const t = A.parseCookies(req).bm_token;
  const p = A.verify(t);
  if (!p) return null;
  const u = store.findUserById(p.uid);
  return u || null;
}
function publicUser(u) {
  if (!u) return null;
  const { passHash, ...rest } = u;
  if (u.role === 'pro') {
    const used = store.claimsByPro(u.id).length;
    rest.creditsUsed = used;
    rest.creditsLeft = Math.max(0, FREE_LEADS - used);
  }
  return rest;
}
const esc = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const requireRole = role => (req, res, next) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  if (role && u.role !== role) return res.status(403).json({ error: 'role' });
  req.user = u; next();
};

// ---------------- auth ----------------
app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const role = b.role === 'pro' ? 'pro' : 'customer';
  const email = String(b.email || '').trim().toLowerCase();
  if (!email || !b.password || String(b.password).length < 6 || !b.name)
    return res.status(400).json({ error: 'invalid' });
  if (store.findUserByEmail(email)) return res.status(409).json({ error: 'exists' });

  const u = {
    role, name: String(b.name).trim(), email,
    passHash: A.hashPassword(String(b.password)),
  };
  if (role === 'pro') {
    u.company = String(b.company || '').trim();
    u.spec = String(b.spec || '').trim();
    u.city = String(b.city || '').trim();
    u.nip = String(b.nip || '').trim();
    u.address = String(b.address || '').trim();
  }
  store.addUser(u);
  A.setAuthCookie(res, A.sign({ uid: u.id, role: u.role }), isHttps(req));
  res.json({ user: publicUser(u) });
});

app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const u = store.findUserByEmail(String(b.email || ''));
  if (!u || !A.verifyPassword(String(b.password || ''), u.passHash))
    return res.status(401).json({ error: 'bad_credentials' });
  A.setAuthCookie(res, A.sign({ uid: u.id, role: u.role }), isHttps(req));
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', (req, res) => { A.clearAuthCookie(res); res.json({ ok: true }); });

app.get('/api/me', (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: 'auth' });
  res.json({ user: publicUser(u) });
});

// ---------------- customer: requests (gratis) ----------------
function cleanPhotos(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(d => typeof d === 'string'
    && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(d)
    && d.length < 3500000).slice(0, 3);
}
app.post('/api/requests', requireRole('customer'), (req, res) => {
  const b = req.body || {};
  if (!b.service || !b.description) return res.status(400).json({ error: 'invalid' });
  const r = store.addRequest({
    customerId: req.user.id,
    service: String(b.service).slice(0, 120),
    zip: String(b.zip || '').slice(0, 80),
    description: String(b.description).slice(0, 4000),
    name: req.user.name,
    phone: String(b.phone || '').slice(0, 40),
    email: req.user.email,
    lang: b.lang === 'pl' ? 'pl' : 'nl',
    photos: cleanPhotos(b.photos),
  });
  res.json({ request: r });
});

app.get('/api/requests/mine', requireRole('customer'), (req, res) => {
  const list = store.requestsByCustomer(req.user.id).map(r => ({
    ...r, claims: store.data().claims.filter(c => c.requestId === r.id).length
  }));
  res.json({ requests: list });
});

// ---------------- pro: leads + claim + billing ----------------
function leadView(r, pro) {
  const claimed = store.claimExists(pro.id, r.id);
  const base = {
    id: r.id, service: r.service, zip: r.zip, description: r.description,
    createdAt: r.createdAt, lang: r.lang, claimed,
    photoCount: Array.isArray(r.photos) ? r.photos.length : 0,
    matchesSpec: pro.spec && r.service && r.service.toLowerCase().includes(pro.spec.toLowerCase().split(' ')[0]),
  };
  if (claimed) { base.name = r.name; base.phone = r.phone; base.email = r.email; base.photos = r.photos || []; }
  return base;
}

app.get('/api/leads', requireRole('pro'), (req, res) => {
  const pro = req.user;
  const used = store.claimsByPro(pro.id).length;
  res.json({
    leads: store.openRequests().map(r => leadView(r, pro)),
    creditsLeft: Math.max(0, FREE_LEADS - used),
    creditsUsed: used,
    price: { gross: LEAD_PRICE_GROSS, net: LEAD_PRICE_NET, vat: LEAD_PRICE_VAT, vatRate: VAT_RATE },
  });
});

app.post('/api/leads/:id/claim', requireRole('pro'), (req, res) => {
  const pro = req.user;
  const r = store.findRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (store.claimExists(pro.id, r.id)) return res.json({ ok: true, lead: leadView(r, pro) });

  const used = store.claimsByPro(pro.id).length;
  if (used < FREE_LEADS) {
    store.addClaim({ proId: pro.id, requestId: r.id, free: true, paid: true, amountGross: 0, amountNet: 0, amountVat: 0 });
    return res.json({ ok: true, free: true, lead: leadView(r, pro), creditsLeft: Math.max(0, FREE_LEADS - used - 1) });
  }
  // betaling vereist
  res.json({ ok: false, paymentRequired: true, price: { gross: LEAD_PRICE_GROSS, net: LEAD_PRICE_NET, vat: LEAD_PRICE_VAT } });
});

// Ontgrendelen met betaling. Maakt een Stripe Checkout-sessie (PLN).
// Zonder Stripe-sleutel valt het terug op een demo (lead direct als betaald markeren).
// De definitieve bevestiging komt via de webhook (checkout.session.completed).
app.post('/api/leads/:id/checkout', requireRole('pro'), async (req, res) => {
  const pro = req.user;
  const r = store.findRequest(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (store.claimExists(pro.id, r.id)) return res.json({ ok: true, lead: leadView(r, pro) });

  const used = store.claimsByPro(pro.id).length;
  if (used < FREE_LEADS) { // nog gratis tegoed
    store.addClaim({ proId: pro.id, requestId: r.id, free: true, paid: true, amountGross: 0, amountNet: 0, amountVat: 0 });
    return res.json({ ok: true, free: true, lead: leadView(r, pro) });
  }

  if (!stripe) { // geen Stripe geconfigureerd → demo
    store.addClaim({ proId: pro.id, requestId: r.id, free: false, paid: true, amountGross: LEAD_PRICE_GROSS, amountNet: LEAD_PRICE_NET, amountVat: LEAD_PRICE_VAT, invoiceNo: store.nextInvoiceNo(), invoiceDate: Date.now(), method: 'online' });
    return res.json({ ok: true, demo: true, lead: leadView(r, pro) });
  }

  try {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    const base = process.env.BASE_URL || `${proto}://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['ideal', 'card', 'bancontact'], // iDEAL = standaard in NL
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: Math.round(LEAD_PRICE_GROSS * 100), // grosze, incl. 23% btw
          product_data: { name: `Budomatch lead: ${r.service}`, description: 'Ontgrendeling aanvraag (btw verlegd / reverse charge)' },
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

app.get('/api/billing', requireRole('pro'), (req, res) => {
  const claims = store.claimsByPro(req.user.id).sort((a, b) => b.createdAt - a.createdAt).map(c => ({
    createdAt: c.createdAt, free: c.free, gross: c.amountGross, net: c.amountNet, vat: c.amountVat,
    invoiceNo: c.invoiceNo || null, invoiceDate: c.invoiceDate || c.createdAt, method: c.method || 'online',
    service: (store.findRequest(c.requestId) || {}).service || '',
  }));
  const paidTotal = claims.filter(c => !c.free).reduce((s, c) => s + c.gross, 0);
  res.json({
    claims, creditsUsed: claims.length, creditsLeft: Math.max(0, FREE_LEADS - claims.length),
    freeLeads: FREE_LEADS, paidTotalGross: +paidTotal.toFixed(2),
    price: { gross: LEAD_PRICE_GROSS, net: LEAD_PRICE_NET, vat: LEAD_PRICE_VAT, vatRate: VAT_RATE },
  });
});

// ---------------- AI assistant ----------------
function systemPrompt(lang, user, mode) {
  const cats = lang === 'en' ? CATS_EN : CATS_NL;
  const who = user
    ? (lang === 'en'
        ? `You are talking to a logged-in ${user.role === 'pro' ? 'tradesman' : 'customer'}: ${user.name}.`
        : `Je praat met een ingelogde ${user.role === 'pro' ? 'vakman' : 'klant'}: ${user.name}.`)
    : '';
  if (lang === 'en') {
    return `You are the AI assistant of Budomatch — a marketplace connecting residents in the Netherlands with reliable, local tradespeople. ${who}
Specialisations (41): ${cats}.
${mode === 'customer'
  ? 'Your goal is to guide the customer smoothly: sharpen the job (scope, location, desired timing, indicative budget), pick the right trade, and write a clear job description that tradesmen understand right away. When the description is complete, summarise it briefly so the customer can paste it into the form.'
  : 'Help choose the right trade, describe the job and explain how Budomatch works (customers post a request for free; tradesmen send quotes).'}
Answer in English, short, warm and concrete. Do not give fixed prices — tradesmen send individual quotes.`;
  }
  return `Je bent de AI-assistent van Budomatch — een marktplaats die bewoners in Polen koppelt aan betrouwbare, lokale bouwvakmensen. ${who}
Vakgebieden (41): ${cats}.
${mode === 'customer'
  ? 'Je doel is de klant soepel door het traject loodsen: de klus aanscherpen (omvang, locatie, gewenste termijn, indicatief budget), het juiste vakgebied kiezen, en een heldere klusomschrijving opstellen die vakmensen meteen begrijpen. Als de omschrijving compleet is, vat je die kort samen zodat de klant hem in het formulier kan plakken.'
  : 'Help het juiste vakgebied kiezen, de klus beschrijven en leg uit hoe Budomatch werkt (klant plaatst gratis een aanvraag; vakmensen sturen offertes).'}
Antwoord in het Nederlands, kort, warm en concreet. Geef geen vaste prijzen — vakmensen sturen individuele offertes.`;
}

app.post('/api/chat', async (req, res) => {
  try {
    const lang = req.body.lang === 'en' ? 'en' : 'nl';
    const mode = req.body.mode === 'customer' ? 'customer' : 'site';
    const user = getUser(req);
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
async function sendMail(subject, html, attachments) {
  if (!process.env.RESEND_API_KEY) { console.log('[Resend niet ingesteld]', subject, attachments ? `(+${attachments.length} bijlage(n))` : ''); return { skipped: true }; }
  const payload = { from: process.env.MAIL_FROM || 'Budomatch <onboarding@resend.dev>', to: process.env.MAIL_TO || 'info@budomatch.pl', subject, html };
  if (attachments && attachments.length) payload.attachments = attachments;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error('Resend ' + r.status);
  return r.json();
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
app.listen(PORT, () => console.log(`Budomatch draait op poort ${PORT}`));
