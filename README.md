# Budomatch NL

Tweetalige (NL/EN) marktplaats die bewoners in Nederland koppelt aan betrouwbare vakmensen.
E©n Node/Express-app: de site, accounts voor klanten en professionals, een leadmodel met
facturatie-logica, en een AI-assistent.

## Structuur
```
budomatch/
├─ server.js              # Express: static + auth + requests + leads + billing + AI-chat + e-mail
├─ lib/
│  ├─ auth.js             # wachtwoord-hashing (scrypt) + JWT (HMAC) + cookies
│  └─ store.js            # JSON-bestand opslag (users / requests / claims)
├─ package.json
├─ .env.example
└─ public/
   ├─ index.html          # marketingsite (NL/PL, standaard Nederlands, foto's, chat, inlog/registratie)
   ├─ dashboard.html      # dashboard (klant/vakman) — volledig tweetalig NL/PL
   ├─ voorwaarden.html      # Algemene voorwaarden (NL)
   ├─ privacy.html     # Privacyverklaring (privacy/AVG, NL)
   └─ budomatch-logo.svg
```

## Lokaal draaien
```bash
npm install
cp .env.example .env      # vul je sleutels in
npm start                 # http://localhost:3000
```
Werkt ook zonder sleutels: de AI-chat geeft dan een nette melding en gast-aanvragen
worden gelogd i.p.v. gemaild. Accounts/leads werken altijd.

## Hoe het werkt
- **Klanten** maken gratis een account aan en plaatsen **gratis** een aanvraag.
- **Professionals** zien aanvragen; contactgegevens zijn afgeschermd tot ze een lead
  **ontgrendelen**. Eerste **5 gratis**; daarna **€ 12,50 per lead** (btw verlegd / reverse charge).
- De **AI-assistent** helpt klanten hun klus scherp te omschrijven.

## Endpoints
| Route | Doel |
|---|---|
| `GET /` · `GET /dashboard.html` | site & dashboard |
| `POST /api/register` · `/api/login` · `/api/logout` · `GET /api/me` | accounts |
| `POST /api/requests` · `GET /api/requests/mine` | klant: plaatsen / overzicht |
| `GET /api/leads` · `POST /api/leads/:id/claim` · `POST /api/leads/:id/checkout` | pro: leads / gratis ontgrendelen / betalen (Stripe) |
| `POST /api/stripe/webhook` | Stripe-bevestiging (maakt de claim aan) |
| `GET /api/billing` | pro: facturatie |
| `POST /api/chat` | AI-assistent (mode: site of customer) |
| `POST /api/quote` · `/api/pro` | gast-aanvraag / aanmelding (Resend) |
| `GET /healthz` | health check |

## Omgevingsvariabelen
| Variabele | Verplicht | Omschrijving |
|---|---|---|
| `ANTHROPIC_API_KEY` | voor chat | sleutel voor de AI-assistent |
| `SESSION_SECRET` | aanbevolen | ondertekent inlog-tokens; lange willekeurige waarde |
| `DATA_FILE` | aanbevolen | pad naar JSON-databestand (op Railway: volume-pad) |
| `STRIPE_SECRET_KEY` | voor betalen | `sk_test_...` of `sk_live_...` (zonder = demo-betaling) |
| `STRIPE_WEBHOOK_SECRET` | voor betalen | `whsec_...` van de webhook-endpoint |
| `BASE_URL` | nee | basis-URL voor redirects; leeg = automatisch uit het request |
| `MODEL` | nee | standaard `claude-sonnet-4-6` (goedkoper: `claude-haiku-4-5-20251001`) |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_TO` | nee | e-mail voor gast-aanvragen |
| `PORT` | nee | Railway vult dit automatisch |

## Stripe instellen
1. Maak in het Stripe-dashboard een account (test-modus eerst). Kopieer de **Secret key** → `STRIPE_SECRET_KEY`.
2. Zet voor Nederland de betaalmethoden **iDEAL**, **creditcard** en **Bancontact** aan (Settings → Payment methods).
   EUR is de valuta; € 12,50 per lead, btw verlegd naar de afnemer (reverse charge, B2B).
3. Webhook: Developers → Webhooks → **Add endpoint** → URL `https://<jouw-domein>/api/stripe/webhook`,
   event `checkout.session.completed`. Kopieer de **Signing secret** → `STRIPE_WEBHOOK_SECRET`.
4. De claim wordt **via de webhook** aangemaakt (betrouwbaar), niet alleen bij terugkeer op de site.

### Lokaal testen met de Stripe CLI
```bash
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook   # toont de whsec_ voor STRIPE_WEBHOOK_SECRET
# Testkaart: 4242 4242 4242 4242, willekeurige datum/CVC
```

## Deployen op Railway
1. Push deze map naar GitHub.
2. Railway → New Project → Deploy from GitHub repo (detecteert Node, draait `npm install` + `npm start`).
3. Variables: `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (+ evt. `BASE_URL`).
4. Persistente data: voeg een Volume toe (mount bv. `/data`) en zet `DATA_FILE=/data/data.json`.
5. `PORT` niet zelf zetten.

## Productie-aandachtspunten
- **Opslag:** JSON is prima voor de start; voor schaal/meerdere instances is PostgreSQL beter.
- **Taal:** de site en het dashboard staan standaard op **Nederlands**; de taalkeuze (NL/PL) wordt onthouden via een cookie en is gedeeld tussen site en dashboard.
- **Beveiliging:** inlog-cookies krijgen automatisch de `Secure`-vlag achter HTTPS (Railway), zijn `HttpOnly` en `SameSite=Lax`.
- **Juridisch:** `voorwaarden.html` en `privacy.html` bevatten je bedrijfsgegevens (KvK/btw-nummer) en zijn opgesteld als degelijke basis — laat ze vóór livegang nog juridisch nakijken.
- **Facturen:** voor elke betaalde lead wordt automatisch een **factuur** aangemaakt met doorlopende nummering (jaar-volgnummer), verkoper- (KvK/btw-nummer) en kopergegevens (NIP/adres indien ingevuld) en de netto/btw/bruto-opbouw. Professionals downloaden de factuur (afdrukken of opslaan als PDF) vanuit hun facturatie-overzicht. De nummering reset per kalenderjaar.

## Database (PostgreSQL)

De app gebruikt automatisch **PostgreSQL** zodra `DATABASE_URL` is gezet (op Railway: voeg de PostgreSQL-plugin toe). Zonder die variabele valt de app terug op een JSON-bestand (`lib/store.js`) — handig voor lokaal ontwikkelen. Het schema (users, requests, claims, factuurteller) wordt bij het opstarten automatisch aangemaakt.

- Klanten kunnen zich registreren als **particulier** of **zakelijk** (bedrijfsnaam + btw-nummer).
- Vakmensen betalen via Stripe: eerste 5 leads gratis, daarna per lead.
- **Support**: klanten en bedrijven kunnen via het dashboard een supportverzoek sturen (zakelijke klanten worden gemarkeerd met prioriteit).
