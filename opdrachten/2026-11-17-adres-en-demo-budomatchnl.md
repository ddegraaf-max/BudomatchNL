# Opdracht: onvolledig bedrijfsadres + demo-accounts op productie

**Gemaakt:** 17 november 2026 (chat "Budomatch live krijgen"), gevonden bij controle van de live site.

## 1. Bedrijfsadres is onvolledig
Op de site staat als adres `15, 09-550 Białka, Polska` — de straat/plaatsnaam vóór het huisnummer ontbreekt. Correct: **Białka 15, 09-550 Białka, Polska**.
Komt voor in: `public/index.html` (footer), `public/voorwaarden.html` (2x), `public/privacy.html`, `public/dashboard.html` (SELLER-object, komt op facturen).
Pas alle plekken aan, het liefst vanuit één constante zodat het niet weer uit elkaar loopt.

## 2. Demo-/testdata op productie
Op Railway (BudomatchNL, production) staan de variabelen `SEED_DEMO` en `SEED_TEST_PAYMENT`. Controleer of ze een waarde hebben. Zo ja: de demo-accounts (klant@/vakman@budomatch.nl, wachtwoord demo1234) en testbetalingen bestaan op de live site.
- Zorg dat de seed alleen draait als `NODE_ENV !== 'production'` óf meld Daniël dat hij de variabelen leeg moet maken.
- Verwijder bestaande demo-accounts en demo-aanvragen uit de productiedatabase, zodat echte vakmensen geen nep-aanvragen zien.

Commit en push. Meld wat Daniël zelf nog moet doen.
