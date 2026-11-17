# Opdracht: Budomatch volledig door AI laten draaien — geen accountmanagers, lagere leadprijs

**Gemaakt:** 17 november 2026. Daniël: "Ik wil alles AI laten doen en geen mensen, zodat de prijs goedkoper is." Homedeal werkt met accountmanagers en een abonnement (Select € 1.000/mnd); Budomatch moet zonder personeel draaien en dat voordeel in de leadprijs doorgeven. Gebruik de bestaande `ANTHROPIC_API_KEY`. Alles wat AI doet wordt gelogd (wat, waarom, welk model) en is in admin terug te zien.

1. **Lead verrijken door AI**: na het plaatsen leest de AI de aanvraag. Ontbreekt er iets wezenlijks (maten, aantal kozijnen, foto, bouwjaar), dan krijgt de klant automatisch één bericht (e-mail, later WhatsApp) met 1–3 gerichte vragen en een link om aan te vullen. De AI maakt daarna een nette samenvatting voor de vakman, schat de omvang van de klus (S/M/L) en een prijsrange (op basis van `data/prijzen.json`).
2. **Kwaliteitscontrole**: AI + regels markeren nep/spam/dubbel/onzin (en sms-verificatie als die er is). Verdachte leads gaan niet naar vakmensen maar naar een lijst in admin.
3. **Leadprijs automatisch** uit de score (omvang, koopintentie, verificatie, compleetheid), binnen een min/max per categorie in config. Uitgangspunt: duidelijk onder de markt; Daniël stelt de bedragen zelf in. Geen abonnement.
4. **Reclamatie automatisch**: vakman dient binnen 10 dagen in met reden; de AI beoordeelt op basis van de platformgegevens (contactpogingen via het platform, geverifieerd nummer, chatgeschiedenis) en crediteert direct of wijst af met uitleg. Altijd een knop "Bezwaar" die per mail naar Daniël gaat (verplicht bij geautomatiseerde besluiten over eenmanszaken/AVG art. 22).
5. **Onboarding vakman zonder mens**: KvK-check (bestaat al), daarna maakt de AI een conceptprofiel uit de KvK-gegevens en de eigen website van het bedrijf (omschrijving, diensten, werkgebied-voorstel); vakman keurt goed.
6. **Helpdesk = AI-assistent** in het portaal (bestaat al als vakman-assistent): uitbreiden met de helpdesk-FAQ en accountgegevens (tegoed, facturen, leads). Escalatie alleen per mail naar Daniël.
7. **Automatische opvolging**: herinnering aan de vakman na 8 uur zonder statuswijziging; reviewverzoek automatisch als de status "Project afgerond" wordt; klant krijgt na 3 dagen de vraag of er contact is geweest (dat voedt de reclamatie-beoordeling en de vakmanscore).
8. **Teksten leadsites**: per domein unieke teksten door AI gegenereerd uit de config + prijsdata, één keer gegenereerd en opgeslagen (niet per bezoek), Daniël kan ze in admin aanpassen.
9. **Facturen** automatisch na betaling (bestaande Stripe-flow), zonder handwerk.

Commit en push. Meld wat Daniël zelf moet instellen (prijsgrenzen per categorie).
