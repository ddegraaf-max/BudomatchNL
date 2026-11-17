# Opdracht: SEO-pagina's per dienst × stad en kostenpagina's (prioriteit 2)

**Gemaakt:** 17 november 2026. Homedeal haalt het meeste verkeer uit dit soort pagina's.

1. Server-side gerenderde pagina's `/<dienst>/<stad>` (bijv. `/dakkapel/utrecht`) voor de 41 diensten × de 40 grootste gemeenten. Unieke inhoud per pagina: intro (dienst + stad), aanvraagformulier met dienst en plaats al ingevuld, prijsindicatie, FAQ, interne links naar buursteden en verwante diensten. Geen dunne kopieën: liever minder pagina's met echte inhoud.
2. Kostenpagina's `/kosten/<dienst>` ("Wat kost een dakkapel in 2026?") met prijsranges per m²/stuk. Prijsdata in één JSON-bestand `data/prijzen.json` dat Daniël zelf kan bijwerken (hij levert de bedragen uit zijn offertes; zet er voorlopig placeholders in met `TODO` en toon die pagina's pas als er een bedrag staat).
3. JSON-LD (Service, FAQPage, BreadcrumbList), canonical, opnemen in `sitemap.xml`.
4. Op de homepage onder "Onze diensten" linken naar de kostenpagina's.

Commit en push. Meld welke prijzen Daniël nog moet aanleveren.
