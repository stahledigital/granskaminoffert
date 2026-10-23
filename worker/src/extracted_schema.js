// Schemat för `extracted` (strukturerade offertfält). Flyttat ur index.js oförändrat så att
// granskningen och jämförelsepaketet delar EN definition. Ingen ändring av innehållet.
// Strukturerade fält för prisregler (PRISUNDERLAG punkt 2). Fält som inte
// står i offerten är null — modellen får aldrig gissa. Reglerna räknas sedan
// i rules.js, deterministiskt.
export const NUM_OR_NULL = { type: ["number", "null"] };
export const EXTRACTED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "jobType", "trades", "hourlyRateSek", "hours", "laborSumSek", "materialSumSek",
    "travelSumSek", "travelVisits", "materialMarkupPct", "rotAmountSek", "rotRatePct", "rotPersons",
    "rotOnMaterialOrTravel", "priceType", "vatMode", "totalSumSek", "totalIncludesVat",
    "totalBeforeRotSek", "amountToPaySek", "totalVatBasis", "propertyType", "totalContract",
    "quoteDate", "plannedPaymentDate", "customerType", "workDescription", "county", "areaM2", "unitCount", "otherSumSek",
    "workNature", "workLocation", "advancePayment",
    "discountSek", "discountPct", "discountBase", "discountStage",
  ],
  properties: {
    jobType: { type: ["string", "null"], enum: ["badrum", "altan", "fonster", "tak", "malning", "fasad", "kakel", "bergvarme", "luftvarmepump", "elcentral", "kok", "annat", null],
      description: "Typ av jobb enligt listan, annars 'annat'. null om det inte framgår." },
    trades: { type: "array", items: { type: "string", enum: ["snickare", "elektriker", "vvs", "malare", "plattsattare", "annat"] },
      description: "Yrken vars timpris eller arbete förekommer i offerten. Tom lista om oklart." },
    hourlyRateSek: { ...NUM_OR_NULL, description: "Timpris i kr som det står i offerten (utan moms-omräkning). null om inget anges." },
    hours: { ...NUM_OR_NULL, description: "Antal arbetstimmar som anges. null om inget anges." },
    laborSumSek: { ...NUM_OR_NULL, description: "Arbetskostnad i kr som egen summa i offerten. null om arbete inte anges separat." },
    materialSumSek: { ...NUM_OR_NULL, description: "Materialkostnad i kr som egen summa. null om inte separat." },
    travelSumSek: { ...NUM_OR_NULL, description: "Resor/framkörning/servicebil i kr TOTALT för alla besök. Anges ett pris per besök och antal besök: multiplicera inte själv utan skriv summan om den står, annars null. null om inget anges." },
    travelVisits: { type: ["number", "null"], description: "Antal besök/resor som framkörningssumman gäller, bara om offerten uttryckligen anger det. null om det inte står." },
    materialMarkupPct: { ...NUM_OR_NULL, description: "Materialpåslag i procent om det anges uttryckligen. null annars." },
    rotAmountSek: { ...NUM_OR_NULL, description: "ROT-avdrag i kr som anges. null om inget ROT-avdrag anges." },
    rotRatePct: { ...NUM_OR_NULL, description: "ROT-sats i procent om den anges uttryckligen (30 eller 50). null annars." },
    rotPersons: { ...NUM_OR_NULL, description: "Antal personer som ROT-avdraget delas på, om det anges. null annars." },
    rotOnMaterialOrTravel: { type: ["boolean", "null"], description: "true bara om offerten uttryckligen räknar ROT på material, resor eller servicebil. null om det inte går att avgöra." },
    priceType: { type: ["string", "null"], enum: ["fast", "ungefarligt", "lopande", null], description: "Pristyp som offerten anger. null om det inte framgår." },
    vatMode: { type: "string", enum: ["inkl", "exkl", "blandat", "ej_angivet"], description: "Momsbasen för RADBELOPPEN (arbete, material, resor, övrigt, timpris) – INTE för totalsummorna (de har totalVatBasis). 'inkl' eller 'exkl' bara om offerten uttryckligen säger det för raderna. 'blandat' ENDAST om själva radbeloppen blandar inkl. och exkl. moms. Att raderna är exkl. medan totalen är inkl. är INTE 'blandat': sätt 'exkl' här och 'inkl' i totalVatBasis. 'ej_angivet' om raderna saknar momsangivelse. Räkna aldrig om mellan inkl. och exkl." },
    totalSumSek: { ...NUM_OR_NULL, description: "ENDAST en total som offerten inte tydligt märker som 'före ROT-avdrag' eller 'att betala'. null om totalen är tydligt märkt (använd då totalBeforeRotSek eller amountToPaySek) eller om ingen total anges. Gissa aldrig om den är före eller efter ROT." },
    totalBeforeRotSek: { ...NUM_OR_NULL, description: "ENDAST en summa som offerten uttryckligen märker som före ROT-avdrag/före avdrag (t.ex. 'summa före ROT-avdrag', 'pris före avdrag'). Ett omärkt 'totalt', 'summa' eller 'totalpris' är INTE uttryckligen före ROT: det hör till totalSumSek. null om offerten inte uttryckligen anger det." },
    amountToPaySek: { ...NUM_OR_NULL, description: "Summa som offerten uttryckligen anger att kunden ska betala efter eventuellt ROT-avdrag (t.ex. 'att betala', 'efter ROT'). null om offerten inte anger det." },
    totalVatBasis: { type: ["string", "null"], enum: ["inkl", "exkl", null], description: "Momsbasen för totalsummorna, bara om offerten uttryckligen anger den för just totalen ('inkl. moms' eller 'exkl. moms'). null om det inte står." },
    totalIncludesVat: { type: ["boolean", "null"], description: "true om totalen uttryckligen är inkl. moms, false om uttryckligen exkl., null om oklart." },
    totalContract: { type: ["string", "null"], enum: ["ja", "nej", null], description: "'ja' bara om offerten uttryckligen anger totalentreprenad (hela arbetet, t.ex. värmepump inklusive installation, till ett totalpris), 'nej' om den uttryckligen anger något annat. Fast pris och småhus räcker inte. null om det inte står." },
    propertyType: { type: ["string", "null"], enum: ["smahus", "bostadsratt", "flerbostadshus", "annat", null], description: "Bostadstyp om offerten eller beskrivningen anger den (villa/småhus, bostadsrätt, flerbostadshus). null om det inte framgår." },
    quoteDate: { type: ["string", "null"], description: "Offertens datum som ÅÅÅÅ-MM-DD. null om inget datum." },
    plannedPaymentDate: { type: ["string", "null"], description: "När betalning eller fakturering planeras, som ÅÅÅÅ-MM-DD. Anges bara månad eller \"vid slutfört arbete i februari 2026\": använd månadens första dag (2026-02-01). Anges bara år: ÅÅÅÅ-01-01. null om inget alls framgår." },
    customerType: { type: ["string", "null"], enum: ["privatperson", "foretag", null], description: "Om kunden är privatperson eller företag, när det framgår." },
    workDescription: { type: ["string", "null"], description: "Arbetet i högst 15 ord, med offertens egna ord. Inga namn, adresser eller företag." },
    county: { type: ["string", "null"], description: "Län om ort framgår (t.ex. 'Kronoberg'). null annars. Aldrig adress." },
    areaM2: { ...NUM_OR_NULL, description: "Yta i m² som arbetet avser, om den anges (badrum, tak, altan, målade väggar/tak, kakel, fasad). null annars." },
    unitCount: { ...NUM_OR_NULL, description: "Antal enheter om arbetet räknas per styck (t.ex. antal fönster). null annars." },
    otherSumSek: { ...NUM_OR_NULL, description: "Summa i kr för övriga rader som varken är arbete, material eller resor (t.ex. container, bortforsling, ställning, tillstånd). null om inga sådana rader." },
    // D19: tre nullable, icke-personliga sammanhangsfält. Bara uttryckligt stöd i dokumentet; annars null (aldrig en gissning).
    workNature: { type: ["string", "null"], enum: ["nybyggnad", "reparation", "underhall", "ombyggnad", "tillbyggnad", null],
      description: "Arbetets art, bara om offerten uttryckligen visar den: nybyggnad (bygga något helt nytt), reparation (laga eller återställa ett fel eller en skada), underhall (löpande underhåll av befintligt), ombyggnad (ändra befintligt), tillbyggnad (bygga till en befintlig byggnad). null om arbetet blandar flera arter, är otydligt eller bara kan gissas. Gissa aldrig utifrån jobbtyp, byggnadens ålder eller ordet nybyggd." },
    workLocation: { type: ["string", "null"], enum: ["invandigt", "utvandigt", "blandat", null],
      description: "Var arbetet utförs, bara om offerten uttryckligen anger det: invandigt (inomhus/insidan), utvandigt (utomhus/utsidan) eller blandat (båda uttryckligen). null om det inte står. Gissa aldrig utifrån jobbtyp (tak, fönster, dörr)." },
    advancePayment: { type: ["boolean", "null"],
      description: "true om offerten uttryckligen kräver betalning (hel eller del, t.ex. förskott, handpenning, delbetalning vid avtal eller start) innan arbetet är utfört. false BARA om offerten uttryckligen säger att ingen betalning sker före utfört arbete. null om offerten inte säger något om saken – en saknad uppgift är aldrig false." },
    // GMO-RABATT (2026-10-23): rabatt som egen avdragsrad. Utan de här fälten saknade reglerna en plats för rabatten och en korrekt
    // offert med rabatt fick "Summering: fel". Bara uttryckligt stöd i dokumentet; annars null.
    discountSek: { ...NUM_OR_NULL, description: "Rabatt i kr som offerten drar av som EGEN rad (t.ex. 'Rabatt −5 000 kr', 'Kundrabatt'), skrivet som ett POSITIVT belopp (5000). Flera rabattrader: summan av dem (radsummorna skrivs ändå brutto, som de står). Radsummorna (laborSumSek, materialSumSek, travelSumSek, otherSumSek) skrivs som de står på sina egna rader, före den här rabatten. Står bara en procentsats och inget belopp: null (räkna aldrig fram beloppet). Ingår rabatten redan i ett radbelopp utan egen avdragsrad: null. ROT-avdrag är aldrig rabatt. null om ingen rabatt anges." },
    discountPct: { ...NUM_OR_NULL, description: "Rabattens procentsats om offerten uttryckligen anger den (10 för 'Rabatt 10 %'). null annars." },
    discountBase: { type: ["string", "null"], enum: ["hela", "material", "arbete", "material_och_arbete", null],
      description: "Vad rabatten gäller, bara om offerten uttryckligen anger det: hela (hela offerten/totalen), material, arbete, material_och_arbete (t.ex. 'Kundrabatt på material och arbete'). null om det inte står eller om flera rabatter gäller olika underlag." },
    discountStage: { type: ["string", "null"], enum: ["fore_moms", "efter_moms", "efter_rot", null],
      description: "Var i uträkningen rabattraden dras av, enligt offertens ordning: fore_moms (före momsen, t.ex. rabatt före 'Summa exkl. moms' eller före momsraden), efter_moms (från en summa inklusive moms men före ROT-avdraget), efter_rot (efter ROT-avdraget, från summan att betala). null om det inte går att se eller om flera rabatter dras i olika steg." },
  },
};
