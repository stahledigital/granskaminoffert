# D16-R2 – äkta testkedja på samma Worker (adminspärrad Stripe-testorder)

Status: kod + offline-tester (UTFÖRT); riktiga leverantörsanrop EJ gjorda av Donatello. Ersätter lokala runnern (D16-R1) som primär väg; R1 finns kvar som fallback.

## Flöde (allt på samma Worker, CompareOrders och FreeBudget – gemensam bokföring i TOTAL 20 USD)
1. `POST /compare/admin/test-order` (Bearer COMPARE_ADMIN_TOKEN) → `{orderId, token}`; flagga `test:true`. Max 2 per 48 h; kräver pott-kapacitet.
2. Offerter laddas upp via ordinarie `PUT /compare/orders/:id/docs/:i` (token) → RIKTIG Anthropic-avläsning, reservation i den riktiga potten.
3. `POST /compare/admin/test-order/:id/checkout` `{token}` (Bearer) → Stripe TEST-session (testnyckel, livemode=false); kontaktmejl tvingas till hej@stahledigital.se. Användarpublik checkout nekas för testorder.
4. Människa betalar testkassan (4242 4242 4242 4242).
5. Stripe TEST-destination → `POST /compare/webhook-test` (egen hemlighet, äkta Stripe-signatur) → `/paid` (viaTestHook). Live-webhooken kan inte betala testordern (DO nekar).
6. Avtalsbekräftelse via RIKTIG Resend → befintlig Resend-webhook `/compare/mail-events` (äkta Svix-signerad `email.delivered`, samma provider-ID) öppnar startgrinden → riktig rapport → rapportmejl (endast hej@).
7. Inkorgsobservation: människans tidsstämplade bekräftelse (delivered ≠ inkorg).

## Exakta mänskliga/konfigurationsgrindar (inga nya konton; EN ny providerresurs: Stripe TEST-destination)
- Krypterade Cloudflare-secrets: `STRIPE_TEST_SECRET_KEY` (befintlig test-sandbox acct_1UGOlW4n2fO8Eusf, sk_/rk_test_), `STRIPE_TEST_WEBHOOK_SECRET` (whsec_ från test-destination).
- Stripe TEST-destination → `https://<worker>/compare/webhook-test`, events: `checkout.session.completed`, `checkout.session.expired` (+ valfritt `async_payment_succeeded/failed`).
- Vars (endast testfönstret): `COMPARE_TEST_CHAIN=1`, `COMPARE_TEST_CHAIN_UNTIL=<ISO ≤48 h>`. Efter testet: ta bort vars och de två secrets (och test-destinationen). `COMPARE_ADMIN_TOKEN` finns redan.
- Live-secrets, FREE-pilot, 49 kr/P/enruta, publik checkout: orörda.

## Spärrar i koden
`testChain()` AV som standard och stänger själv efter UNTIL; testnyckel måste vara test-prefix; mejltransport måste vara riktig HTTP; DO nekar korsning test↔skarp i båda riktningar; testorder kan bara få kontaktmejl hej@; test-order-tak 2/48 h; kapacitetskontroll mot potten vid skapande och checkout.

## Bevisar / bevisar inte
Offline bevisat (dubbel): rutter, guards, nyckelval, mottagarspärr, ledger-flagga. EJ bevisat: faktisk Stripe-test-webhook mot Cloudflare, riktig Resend-leverans/inkorg, Anthropic-rapport, Cloudflare-drift – bevisas först vid rootens körning med mänskliga steg.
Export: ordinarie bokföringsexport utesluter testordrar; `GET /compare/admin/ledger?month=…&test=only` är explicit testdiagnostik (CSV får kolumn `test`). Testordrar avstäms/återbetalas alltid mot Stripe TEST (saknad testnyckel ⇒ neka, aldrig live).
