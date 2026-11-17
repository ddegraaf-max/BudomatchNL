# Opdracht: functies die Homedeal heeft en Budomatch mist (prioriteit 3)

**Gemaakt:** 17 november 2026, na vergelijking met het ingelogde Homedeal-vakmanportaal.

Budomatch heeft al: Beschikbaar/Ontgrendeld, niveaus Brons/Zilver/Goud, AI-reactie, collega-klussen. Toevoegen:

1. **Aantal concurrenten per lead** tonen in de lijst ("2 van max. 4 vakmensen") en een label **"Ontgrendel als eerste"** zolang nog niemand heeft ontgrendeld. Afstand in km tot de vakman tonen.
2. **Telefoonverificatie van de klant** via sms-code bij het plaatsen van een aanvraag (optioneel voor de klant; geverifieerde leads krijgen een badge "Telefoon geverifieerd"). Gebruik de sms-provider die Daniël al heeft; maak het configureerbaar via env en schakel het uit als er geen sleutel is.
3. **Opgeslagen berichten**: vakman bewaart standaardberichten (e-mail en WhatsApp) met variabelen `{naam_klant}`, `{bedrijf}`, `{profiel_url}`; met één klik versturen of WhatsApp openen (wa.me-link) vanaf de lead.
4. **Meerdere werkgebieden** per vakman (meerdere postcodes, elk met eigen straal).
5. **Vakman-referral**: vakman nodigt collega uit; na goedgekeurde registratie (KvK-check) krijgen beiden 2 gratis leads.
6. **Voortgang naar Goud** als checklist in het portaal (logo, omschrijving, 3 projectfoto's, minimaal 3 reviews, gemiddelde 8+), zoals Homedeal "Top Pro" doet.
7. **Tegoed vooraf** (bijv. € 250 / € 500 met 10/15% extra tegoed) naast betalen per lead, met overzicht van verbruik en facturen.

Op de vakmanpagina het verkoopargument expliciet maken: "Geen abonnement — Homedeal Select kost € 1.000 per maand".

Commit en push.
