# Mätkontrakt (D19)

Gäller `POST /event` (klienthändelser) och serverdatapunkter från ordermotorn. Allt skrivs till Analytics Engine-datasetet
`granska_handelser` (bindning `GRANSKA_H`). Koden finns i `src/measure.js`; testerna i `test/d19_matning.test.mjs`
(fientlig payloadmatris genom riktiga `/event`-vägen + sekvens i riktig workerd med SQLite-backade Durable Objects).

## Principer

- Fasta, slutna enum. Ingen fritext, ingen URL/query/hash/referrer/UTM/fbclid, inga id:n, åtkomsttoken, dokument, belopp, filnamn,
  e-post, IP eller modell-/undantagstext. Fält som inte hör till händelsen ignoreras och lagras aldrig.
- Klienthändelser får alltid namnprefixet `klient_` och kan därför aldrig förväxlas med serverbekräftade händelser.
  Klienten kan inte skapa `betalning_verifierad`, `leverans_klar` eller andra servernamn: okända namn avvisas tyst (204).
- Gamla händelser (`rapport_klar`, `export`, `kontakt_cta`) är oförändrade: samma namn, samma detaljer, samma tre blobbar.
- Body högst 1024 **byte** (inte tecken), Origin måste vara tillåten (annars 403). `/event` svarar alltid 204 för tillåten Origin:
  mätfel, saknad bindning, `EVENT_RL`-gräns eller ogiltig kropp blockerar aldrig sidan.
- Analytics Engine är best-effort: **ingen exakt-en-gång-garanti**, ingen outbox, ingen ny resurs eller migration.
  Beständig order/ledger och Stripe är facit för köp och återbetalning; datapunkterna är volymsignaler.
- Ingen ny entry-/mätmetadata på ordern eller i den fleråriga ledgern. Serverprodukt härleds ur orderns befintliga `kind`
  (`check`, annars `compare`); test ur orderns befintliga betrodda serverklassning (`o.test`). Publik klient-QA ger aldrig
  Stripe-testmandat eller gör en verklig betalning till test.
- Klientens `entry` (`root|jamfor|forkontroll`) är en anonym ingångsvolym per sidladdning. Den får jämföras med serverutfall per
  produkt och tidsperiod men inte joinas till order, person eller annons. Ingen unikpersonkonvertering utlovas:
  rapportera steg-/försöksvolymer, inte `betalda / landningar` som exakt konverteringsgrad.

## Klienthändelser (`type:"client"`)

`index = [lage]` där `lage = "test"` om `test:true` i kroppen eller headern `X-SD-Test: 1`, annars `skarp`.
Nya händelser skriver alltid 13 blobbar (`""` där fältet inte hör till händelsen):

| # | blob | innehåll |
|---|------|----------|
| 1 | namn | `klient_<event>` |
| 2 | detalj | reserverad för gamla händelser (`""` för nya) |
| 3 | roll | `mottagare`, `hantverkare` eller `okand` |
| 4 | product | `none` (endast `landing`), `free`, `compare`, `check` |
| 5 | entry | `root`, `jamfor`, `forkontroll` |
| 6 | method | `file`, `camera`, `text`, `handoff`, `unknown` |
| 7 | stage | `input`, `config`, `submit`, `checkout`, `result` |
| 8 | reason | `history` (view_return) eller fel: `empty`, `format`, `size`, `read`, `network`, `timeout`, `server`, `config` |
| 9 | mode | `new`, `resume`, `readonly` |
| 10 | from | `none`, `free`, `compare`, `check` |
| 11 | to | `free`, `compare`, `check` |
| 12 | demo | `demo` / `eget` (bara händelser som bär demoflaggan, annars `""`) |
| 13 | seen | `sett_exempel` om exemplet visats lokalt före egen inmatning (annars `""`) |

| Händelse | Obligatoriska fält | Valfria | Exakt trigger (klienten) |
|---|---|---|---|
| `landing` | `entry`, `product`, `mode` | | En gång per dokument (kall laddning). `product=none` på rotsidan före uppgiftsval (inte gratisavsikt). `pushState`/`popstate`/BFCache/återmontering ger ingen ny landning. |
| `task_change` | `from`, `to` (olika) | | Bara när kunden aktivt väljer en annan uppgift. Samma uppgift, omrendering och rollbyte ger inget. |
| `view_return` | `product`, `reason=history` | | Historiknavigering till en vy; inget nytt produktval, ingen ny granskningsstart. |
| `input_choose` | `product`, `method` | | Aktivt val av fil/kamera/text (avsikt, inte att väljaren öppnats eller fil valts). |
| `input_ready` | `product`, `method` | `demo` | Modellens faktiska övergång till ett giltigt, aktuellt underlag; aldrig komponent-mount, aldrig inaktuell sen läsning. `handoff` = överfört underlag. |
| `inputs_ready` | `product=compare` | | Alla 2–4 **aktiva** underlag klara (dolda tredje/fjärde ingår inte). |
| `example_view` | `product` | | Exemplet faktiskt visat. Aldrig granskningsstart eller gratisrapport. |
| `submit` | `product`, `method` | `demo`, `seen` | Ett accepterat submitförsök efter klientvalidering. Blockerad dubbelklick ger ingen extra. |
| `client_error` | `product`, `stage`, `reason` | | Sluten orsak; aldrig verklig feltext eller `exception.message`. |
| `result_view` | `product` | `demo`, `seen` | Resultatet visat. Inte serverklar granskning; återmontering ger högst detta. |
| `checkout_open` | `product` (`compare`/`check`) | | Öppningsförsök av kassa. Inte betalning. |

Gamla: `rapport_klar` (inga detaljer), `export` (`email|sms|copy`), `kontakt_cta` (`hemsida|materialraknaren|epost`).
En gammal delningsbeacon `{type:"share", channel}` räknas som `export` precis som tidigare.

## Serverhändelser (ordermotorn, `CompareOrders`)

Blobbar: `[namn, produkt, detalj]`, `index = [lage]` (`test` om `o.test`). Skrivs **efter** att respektive beständiga beslut lyckats.

| Namn | Skrivs när | Detalj | Skrivs inte vid |
|---|---|---|---|
| `order_skapad` | Första lyckade beständiga create | | Återupptagen/befintlig order, avvisad create (409) |
| `underlag_mottaget` | Godkänd manifest-commit i `/doc` | `ny` / `ersatt` | Avvisad PUT (dubblett, för stor, fel status), samma fil igen (idempotent omsändning) |
| `underlag_kompletta` | Manifestet går från ofullständigt till fullständigt | antal underlag | Ersättning i redan fullständigt manifest; `awaiting_payment→ready` efter utgången kassa |
| `checkout_skapad` | Ny beständigt knuten Stripe-session | `forsta` / `ny` (försök > 1) | Återanvänd session, samtidig skapare (första vinner), `checkout-begin` |
| `betalning_verifierad` | Första verifierade betalningsbeslutet, efter atomisk commit av order + ledger | | Dubblett/replay (samma eller annat event-ID), kassaklick, redirect, polling, återöppnad rapport |
| `leverans_klar` | Första commit som fryser leveransen | | Polling, rapporthämtning, återmontering, reviderad förkontrollsrapport |
| `order_fel` | Terminalt orderfel | `samtycke`, `bekraftelse`, `avlasning`, `underlag`, `budget`, `konfiguration`, `for_manga_forsok`, `internt`, `annat` | Retry |
| `aterbetalning_bekraftad` | Leverantören bekräftar återbetalningen (`done`) | `auto` / `manuell` | Begärd/pending/action_required/misslyckad |

Befintliga serverhändelser från `/review` (`uppladdning_start` = mottaget granskningsförsök, `granskning_klar`, `granskning_fel`)
och `anrop_kostnad` är oförändrade.

## Dataliv och rättsliga gränser

Mätningen ändrar inga priser, villkor, samtyckeshashar, kvoter, pilot, konton eller lagringstider. Analytics Engines faktiska
retention är en plattformsinställning som inte är verifierad här; produkttexten får därför inte lova att mätdata raderas efter
24 timmar. Dokumentretention (24 h), leverantörshantering, analytics och bokföring hålls åtskilda.

## Driftordning

Worker med utökad `/event`-validering och serverdatapunkter släpps **före** frontenden och är kompatibel med nuvarande frontend
(gamla händelser oförändrade). Rollback av Workern lämnar nya klienthändelser ignorerade (204) och påverkar inga ordrar.


## Frontendens faktiska utlösare i D19-kandidaten (gmo-v23-d19)

Klientmodulerna `gmo-core.js` (`G.measure`), `gmo-free.js`, `gmo-pay.js` och `gmo-app.js` skickar bara fält som står i tabellen ovan; övrigt ignoreras av servern.

- `landing` (gmo-app): en gång per dokument; `mode=new|resume|readonly` ur adressens grova form.
- `input_choose` (alla tre): aktivt filval (ändringshändelse med fil) respektive första inmatning i textfältet; kameraval i gratis. Ett nekat val (för stor fil) ger `client_error`, ingen `input_ready`.
- `input_ready`: bara vid övergång från inget till giltigt aktuellt underlag per plats (`handoff` när underlaget följt med); `inputs_ready` (bara `compare`) när alla aktiva 2–4 platser är klara. Dolda platser räknas inte.
- `submit`: efter klientvalidering och startlås, med `method` (`handoff` > `file` > `text`). Ett blockerat dubbelklick ger ingen extra händelse.
- `client_error`: `stage` ∈ input|config|submit|checkout, `reason` ur den slutna listan (t.ex. `size` för 8/20 MB, `network`/`timeout`/`server`/`read`/`format`/`config`). Aldrig feltext.
- `result_view`: när resultatet visas, högst en gång per order och dokument (`gmo-pay.js`) respektive per körning (`gmo-free.js`).
- `checkout_open`: vid öppningsförsök av kassa (jämför och förkontroll), inte vid betalning.
- Demoflaggan följer bara med händelser som sker i exempelläget; `seen` skickas som `true` och normaliseras av servern till `sett_exempel`.

Kontrollerat i `tests/ui/d19_pay.test.mjs` och `tests/ui/d19_resultat.test.mjs`: varje klienthändelse i gratis-, jämför- och förkontrollflödena accepteras av `normalizeClientEvent`, är högst 1024 byte och saknar innehåll/ID.
