# Opdracht: mailadressen op de site controleren

**Gemaakt:** 15 november 2026 (chat "Mailadres info@labelomhoog.nl werkt niet"), op 17 november in de repo gezet.
Aanleiding: info@labelomhoog.nl stond op de site maar had geen mailbox. Daniël wil dat bij alle sites nagelopen wordt: "dit is echt slordig".

Adressen die in deze repo staan: **vakman@, klant@budomatch.nl en **info@budomatch.pl****

Extra: een Nederlandse site hoort geen .pl-adres te tonen. info@budomatch.pl staat in de voorwaarden en als verkopersadres. Zet het om naar het Nederlandse adres als budomatch.nl MX heeft, en anders naar montage@creditline.nl.

Te doen:
1. Controleer per domein of het mail kan ontvangen: `nslookup -type=MX <domein>` (of `dig MX`). Geen MX-record betekent dat dat adres geen mail ontvangt.
2. **Zichtbare contactadressen zonder MX:** vervang ze door `montage@creditline.nl`. Daar komen ook de aanvragen binnen.
3. **noreply@ en afzenderadressen:** die hebben geen mailbox nodig, maar het domein moet wel geverifieerd zijn in Resend. Controleer dat en meld het als het niet zo is.
4. Testadressen (proef, demo, toets, voorbeeld.nl, .test, .example) overslaan.
5. Lever een lijstje op: adres → MX ja/nee → Resend ja/nee → wat je hebt aangepast. Commit en push.
