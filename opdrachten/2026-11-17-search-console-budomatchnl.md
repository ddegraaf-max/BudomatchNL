# Opdracht: API-URL's uit Google houden op budomatch.nl (Search Console)

**Gemaakt:** 17 november 2026, uit Google Search Console (rapport Pagina's en Verbeteringen). Er zijn geen handmatige acties of beveiligingsproblemen.
> Normaal en dus geen actie nodig: "Pagina met omleiding", "Alternatieve pagina met correcte canonieke tag" en kleine aantallen "Gecrawld/Gevonden – momenteel niet geïndexeerd".

Google probeert de API te crawlen en krijgt 9 × 401 en 20 × 404: `/api/requests/mine`, `/api/projobs/`, `/api/leads/`, `/api/leads`, `/api/me`, `/api/feedback/`, `/api/vve`, `/api/feedback`.

Te doen:
1. Zet `Disallow: /api/` in robots.txt.
2. Stuur bij alle `/api/*`-responses de header `X-Robots-Tag: noindex` mee.
3. Zoek waar deze API-URL's als gewone `<a href>` of in de sitemap staan en haal ze daar weg.
4. Controleer of de site deze repo is (budomatch.nl). Zo niet, zet deze opdracht dan over naar de juiste repo en meld dat.
