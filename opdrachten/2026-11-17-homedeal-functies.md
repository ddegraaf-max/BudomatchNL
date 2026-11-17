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

## Aanvulling na volledige doorloop van Homedeal (17-11, later die avond)

8. **Pijplijn per ontgrendelde lead** (mini-CRM) met statussen: Gecontacteerd, Geen antwoord, Afspraak ingepland, Offerte gestuurd, Offerte geaccepteerd, Offerte niet geaccepteerd, Project begonnen, Project afgerond, Project met review. Filter op status in het tabblad Ontgrendeld.
9. **Gesloten reviewsysteem**: de knop "Vraag review aan" verschijnt pas als de status "Project afgerond" is; de klant krijgt een reviewmail met eenmalige link. Review met drie deelscores: Kwaliteit, Service, Prijs/kwaliteit (gemiddelde = eindcijfer). Geen reviews van buiten het platform.
10. **Reclamatie**: binnen 10 dagen na ontgrendelen een lead terugvragen met een reden (verkeerd nummer, klant onbereikbaar na 3 pogingen, dubbele aanvraag, buiten werkgebied, nep). Admin beoordeelt; bij goedkeuring gratis lead terug of creditering.
11. **Aanvraagformulier in stappen**, één vraag per scherm, beginnend met postcode + huisnummer (adres automatisch aanvullen), daarna type klus, uitvoerdatum, **koopintentie** ("ik wil een vakman inhuren" / "ik oriënteer me"), omschrijving, foto's, contactgegevens. Onder het formulier alleen ECHTE cijfers tonen ("laatste aanvraag x minuten geleden", "x aanvragen vandaag") en ze verbergen zolang de aantallen laag zijn.
12. **Leadweergave vóór ontgrendelen**: naam als "Dhr./Mevr. <achternaam>", plaats en regio zichtbaar; adres, postcode, telefoon en e-mail gemaskeerd. Toon koopintentie, uitvoerdatum, bron en aantal vakmensen dat hem al heeft. Tip in beeld: "Reageer binnen 8 uur" + herinneringsmail na 8 uur als de status nog op "Offerteaanvraag" staat.
13. **Werkgebied per vakgebied**: per categorie eigen subtypes (bijv. Kozijnen: kunststof/hout/aluminium) en eigen postcode + straal, met de optie "heel Nederland".
14. **Aparte e-mailadressen** per bedrijf: voor aanvragen, voor facturen en algemeen.
15. **Profiel**: "lid sinds" en oprichtingsjaar (uit KvK), rechtsvorm, aantal medewerkers, een sectie Vraag & Antwoord, en een deelbare profiellink voor buiten het platform.

Wat Budomatch beter heeft en zo moet blijven: 2FA, AI-reactie, collega-klussen, geen abonnement.

Op de vakmanpagina het verkoopargument "Geen abonnement, je betaalt alleen per lead" duidelijker maken. Noem geen concurrent of prijzen van een concurrent zonder dat Daniël dat goedkeurt.

Commit en push.
