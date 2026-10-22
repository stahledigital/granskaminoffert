// F7 S7a (Förkontroll i MR PRO): versionen av GMO:s regelkod, som MR:s hashlåsta kopia jämför mot.
// REGLER_SHA256 = sha256 över byten i rules.js, amounts.js och money.js, sammanfogade i den ordningen utan avgränsare.
//   cat rules.js amounts.js money.js | shasum -a 256
// test/referens.test.mjs räknar om summan och larmar vid olikhet. Den som ändrar reglerna uppdaterar konstanten
// (och MR:s kopia, source/GMO_REGLER, med dess synka.mjs). Konstanten skickas i GET /pro/referens.
export const REGLER_FILER = ["rules.js", "amounts.js", "money.js"];
export const REGLER_SHA256 = "f8fbc459dae255a210f4c687872e119ca0726a8e9a4f979994ae64ca1ec423ab";
