# Opdracht: aanvragen van Daniëls merksites doorzetten naar Budomatch (prioriteit 1)

**Gemaakt:** 17 november 2026 (chat "Budomatch live krijgen").
Doel: Budomatch heeft geen verkeer. Daniël krijgt via zijn eigen sites (AanEnUitbouw.nl, LumaDak, MaatwerkDakkapel, MaatwerkGaragedeur, LabelOmhoog, bestelkozijnenopmaat e.a.) aanvragen binnen die hij zelf niet oppakt (buiten zijn regio of vakgebied). Die moeten als echte lead op Budomatch terechtkomen, zodat vakmensen vanaf dag één klussen zien.

Te doen in deze repo:
1. Endpoint `POST /api/intake` met een API-sleutel per bronsite (env `INTAKE_KEYS`, kommagescheiden `bron:sleutel`). Velden: dienst, plaats/postcode, omschrijving, timing, naam, e-mail, telefoon, foto-URL's, `bron`, `toestemming_doorsturen` (verplicht true).
2. De lead wordt een gewone aanvraag (zelfde flow, matching op werkgebied en categorie). Bewaar de bron voor statistiek. Dubbele aanvragen (zelfde e-mail + dienst binnen 7 dagen) weigeren.
3. De klant krijgt de normale bevestigingsmail van Budomatch, met uitleg dat zijn aanvraag via <bron> is doorgezet.
4. Admin: overzicht leads per bron.

Voor de bronsites (aparte opdrachten daar, NIET in deze repo bouwen): een vinkje bij het aanvraagformulier "Mag je aanvraag worden gedeeld met andere vakmensen via Budomatch als wij hem niet uitvoeren?" (AVG: toestemming nodig), en in hun admin een knop "Doorzetten naar Budomatch". Noteer in je samenvatting welke sites dat nodig hebben.

Commit en push. Meld wat Daniël zelf nog moet doen (sleutels op Railway zetten).
