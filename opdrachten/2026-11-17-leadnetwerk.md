# Opdracht: leadnetwerk — losse leadsites → Budomatch als centraal punt (prioriteit 1, vervangt de aanpak in `2026-11-17-eigen-leads-doorzetten.md` waar die botsen)

**Gemaakt:** 17 november 2026 (chat "Budomatch live krijgen"). Daniëls keuzes:
- Leads gaan in deze volgorde: **eerst Creditline zelf → daarna Budomatch-vakmensen**. Restleads worden NIET doorverkocht aan andere netwerken.
- Verdienmodel: leads aan vakmensen via Budomatch (per lead). Later hetzelfde model in Polen met Fachora (aparte opdracht in repo `factuur`).
- Leadsites: **één codebase, veel domeinen**, in deze repo/service.
- Startdiensten: **aanbouw/uitbouw, kozijnen, schuifpui**.

## A. Leadsites in deze app (multi-domein)
1. Middleware die op `req.hostname` kijkt. Staat het domein in `data/leadsites.json`, toon dan de leadsite in plaats van de Budomatch-homepage. Per site in de config: domein, dienst(en), merknaam, kleuren/logo, titel/meta, prijsranges, FAQ, regio (optioneel), contacttekst.
2. Leadsite = één pagina met: korte uitleg, prijsindicatie/calculator voor die dienst (prijsdata uit de config; placeholders met `TODO` tot Daniël bedragen aanlevert), het **stappenformulier** (postcode+huisnr eerst, type, uitvoerdatum, koopintentie, omschrijving, foto's, contact), FAQ, privacy/voorwaarden-link. Geen Budomatch-branding behalve "aanvragen worden verwerkt door Budomatch" in de footer/privacytekst.
3. Toestemmingstekst in het formulier (AVG): de aanvraag wordt eerst bekeken door Creditline Montage en kan daarna gedeeld worden met maximaal 3 vakmensen in de regio via Budomatch.
4. Elke aanvraag wordt een gewone Budomatch-aanvraag met `bron` = domein. Eigen robots/sitemap/canonical per domein. Geen duplicate content tussen sites: per site eigen teksten.
5. README: hoe voeg je een nieuw domein toe (regel in `leadsites.json` + domein toevoegen aan de Railway-service + DNS in Cloudflare).

## B. Routering (waterval)
1. **Stap 1 – Creditline**: past de lead in Creditline's vakgebied + werkgebied (config `data/creditline.json`; startwaarden: kozijnen/schuifpui/deuren 120 km rond 2573 EP en 2435 XS, aanbouw/uitbouw/verbouwen 150 km rond 2435 XS, dakkapel 180 km rond 2573 EP), dan gaat hij eerst exclusief naar Creditline (mail naar montage@creditline.nl + in het admin-portaal) met knoppen **Ik pak hem op** / **Doorzetten**. Geen reactie binnen 4 uur (instelbaar) = automatisch door naar stap 2.
2. **Stap 2 – Budomatch-vakmensen**: beschikbaar voor maximaal 3 vakmensen (bestaande ontgrendel-flow). Pakt Creditline hem op, dan gaat hij niet naar stap 2.
3. Ook leads uit `/api/intake` (Daniëls bestaande merksites) lopen door deze waterval.

## C. Leadscore en meten
1. Score per lead op basis van koopintentie, uitvoerdatum, omschrijving/foto's aanwezig, telefoon geverifieerd (als die functie er is).
2. Admin-dashboard per bron: aantal leads, % door Creditline opgepakt, % ontgrendeld door vakmensen, omzet per bron, per week.

Commit en push. Meld in je samenvatting wat Daniël zelf moet doen (domeinen kopen/kiezen, prijzen aanleveren, domeinen koppelen).

## Domeinen (geregistreerd 17-11-2026 bij Mijndomein, DNS in Cloudflare, al als custom domain op deze Railway-service)
- **uitbouwprijscheck.nl** — leadsite aanbouw/uitbouw (hoofdsite)
- **kozijnenprijscheck.nl** — leadsite kozijnen (hoofdsite)
- **schuifpuiprijscheck.nl** — leadsite schuifpui (hoofdsite)
- **uitbouwprijs.nl** en **aanbouwprijs.nl** — eigen leadsite uitbouw resp. aanbouw met eigen teksten (geen kopie van uitbouwprijscheck.nl)
- **uitbouwberekenen.nl** → 301 naar uitbouwprijscheck.nl
- **schuifpuiberekenen.nl** en **schuifpuivergelijken.nl** → 301 naar schuifpuiprijscheck.nl
Steeds ook `www.`-variant (staat al op Railway); `www` → 301 naar de kale domeinnaam. Tot de leadsites gebouwd zijn tonen deze domeinen de Budomatch-homepage: zorg dat ze dan in elk geval `noindex` krijgen of naar budomatch.nl redirecten, zodat Google geen dubbele inhoud ziet.
