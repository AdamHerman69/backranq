# Extractor / Practice v4 — pracovní checkpoint

Uživatel 2026-09-06 výslovně obnovil práci pokynem „můžeš pokračovat“.
Implementace a finální ověření nyní pokračují. Všechny změny jsou lokální a necommitnuté na
`feature/extractor-practice-v4`, základ `e3c408a96392448ed41eeca0e43e94df4d0c0a1f`.
Nic nebylo pushnuto, mergnuto ani nasazeno. Preexistující `artifacts/` nestagovat plošně.

## Nové výslovné pravidlo

Backward compatibility ani zachování současných databázových dat nejsou požadavek.
Uživatel výslovně dovoluje při dokončení kompletně resetovat databázi. Teď se žádný
reset nespouští. Při navázání nezavádět kompatibilní readers, backfills ani další
práci jen kvůli uchování pre-user dat. Přesný cílový reset zůstává kontrolovanou
součástí integrace/release; produkce se stále nasazuje pouze z `main`.

## Co je na disku

- Kanonický v4 kontrakt a společná quality policy, oddělené tier/original relation,
  evidence pool, skutečné engine snapshoty a potvrzení využité pro přípravu odpovědí.
- Společný FULL_GAME/FIRST_PUZZLE, omezené doplnění neznámých tahů, lokální runtime,
  homepage engine handoff, RECORD/ENRICH a offline kauzalita, persistence/Progress.
- Čisté v4 schema a lokální migrace 47. Starý v3 runtime byl odstraněn.
- Review opravy: reference drift a jeho budget, změněné snapshoty stejné depth,
  immutable refinement IDs, USER continuation context/index, historické metriky
  z připnuté revision, diagnostické receipts bez pravomoci archivovat moment.
- Výsledek extrakce má kumulativní `engineWork`, per-game receipt verze 2 vlastní
  náklady; pool/checkpoint jsou verze 2. Ledger přežívá evikci kontextu.
- Migrace odstraňuje i staré odvozené game analysis/counts/CTA. Zatím implementované
  zachování zdrojů není nutné dále rozšiřovat vzhledem k novému pokynu výše.

## Stav po obnovení práce

- Poslední celé `pnpm check` prošlo: lint, TypeScript, 1 567 pass / 39 skip,
  produkční build a bundle budgets (homepage 144.7 KiB, Practice 196.2 KiB).
  Následné integrační CR ještě našlo slabší scope validaci referenčního budgetu
  a chybějící invalidaci ostatních hodnocení při singleton counterevidence proti
  referenci. Tyto opravy vyžadují nové focused a finální široké ověření.
- Reálný browser Stockfish smoke, Queue bundle i skutečné spuštění enginu
  compiled Queue callbackem prošly. Audit produkčních dependencies bez nálezu.
- Fresh47/46→47/RLS/schema/shadow a izolovaný Progress 100k prošly. Nová
  producer→API→DB regrese reanalýzy prokázala archivaci stejného momentu při
  kanonickém vyvrácení, nulový nový Practice count a nezměněný historický pokus.
- První plné DB E2E: 59 pass / 14 fail. Opraveny skutečné chyby pokračování,
  předčasné odhalení větve, review kontext a exposure při souběžném smazání.
  Druhý běh: 70 pass / 3 fail / 5 skip. Zbýval performance gate pod zátěží
  a dva mate/refinement scénáře. Izolovaný public unknown prošel; nový RULE
  fast path odstraňuje zbytečný engine startup pro přímo dokazatelný mat.
- Malý browser benchmark po paint opravě: jedna pozice, deset voleb v každém
  režimu. Pending paint p95 ~17ms desktop i CDP4×, unknown support desktop
  ~379/556ms p50/p95, emulace ~1751/2570ms. Není to šedesátipoziční release gate.
- Nezávislé CR našlo a opravuje: novější protichůdné bounds, coverage proof
  vybraný jen ze starých observations, obrácený MATE drift, producer/persistence
  propojení kanonického vyvrácení. Bounds se nyní přenášejí také z obou reálných
  adaptérů jako nekompletní counterevidence, nikdy jako exact point.
- Širší audit zatím poskytl 60 validních přímých pozic a několik úplných
  all-legal porovnání bez neshody. Po CR změnách byly procesy zastaveny; tato
  data jsou discovery, nikoli finální gate. Nový audit umí importovat původní
  zaplacené manifesty skutečně extrahovaných momentů a přidat pravidlové okraje.
- Z původního main je uložen kontrolní běh stejných prvních tří partií/profilu:
  531 fyzických searches, 103.3M požadovaných nodes. Nová varianta potřebuje
  konečné srovnání a rozdělení času extrakce vs auditní validace. Profiler našel
  opakovanou normalizaci kontextů v poolu; omezená cache úplného kontextu je
  implementovaná, nezávisle zreviewovaná a má regresi proti záměně požadavků.
- Capture `practice-v4-release-extraction` poskytla 49 validních pozitivních
  momentů ze 16 partií, tedy nesplnila cíl 60. Nový audit umí výslovně analyzovat
  i skutečného soupeře v každé partii; obě perspektivy zachovávají původní PGN.
  Silnější quality lab byl zastaven před dokončením po dalším nálezu v policy.
- Poslední přestavěné E2E stále 70 pass / 3 fail / 5 skip. Přímý RULE test měl
  zastaralý požadavek na vytvoření enginu; homepage handoff se došetřuje. Izolovaný
  Practice document paint p75 ~563ms nesplnil 500ms gate, homepage→Practice ~149ms.
  Tento performance bod zůstává otevřený, limit nebyl zvýšen.

## Navázání

### Aktuální stav 2026-09-07 po dalším pokračování

- Broad check prošel s 1575 pass / 39 skip, následná úzká quality-recovery
  oprava má 18 focused pass + clean CR. Rebuilt E2E 73 pass / 5 skip, offline
  19 pass / 1 skip. Homepage handoff a RULE jsou opravené; Practice document
  paint p75 304.5ms, pod 500ms. Offline config nyní binduje hostname z baseURL.
- Fresh capture `practice-v4-sept7-extraction`: 60 momentů po 18 perspektivách
  ze 16 skutečných partií, 1518 searches / 228500632 nodes. Structural valid
  není důkaz správnosti jednotlivých odpovědí.
- All-legal `practice-v4-sept7-alllegal` zastaven na 29 pozicích/792 tazích:
  14 falseGOOD + 8 falseBELOW, 14 runtimeUNKNOWN, 123 comparatorUNKNOWN,
  0 invalidpatches / node-budgetviolations. Všechny 3 procesy skončily;
  `superseded-discovery.json` uchovává neshody. Quality lab též zastaven.
- Potvrzené příčiny: early local support už při 10–601 nodes a staré
  alternativy ze snapshots4/5/6, které zmizely z finálního root10/11/12.
  V4 agent implementuje novou maturity policy: latest point reference i tahu
  musí mít observation.nodes i search.reportedNodes >=25000, každý pozitivní
  proof move musí být v posledním validním kompletním bundle téhož search.
  Immature counters stále veto, RULE beze změn. Nové policy ID/snapshot/schema,
  žádná kompatibilita ani změna cp/WDL kvalitativních prahů.
- Engine agent implementuje omezenou cache čistých šachových faktů podle
  celého obsahu (4096 entries / 1M retained chars) a sdílení assess+drift
  validačního kontextu. Profil skutečného localgrade index44/a1a2: 6.46s wall,
  5.41s user CPU, validObservation 5.51s. Snapshot projekce dosud revalidují
  stejné PV dvakrát. V4 vlastní policy/contract, engine nový utility+localwiring,
  integrate_core dělá read-only CR včetně legitimacy comparator reference.
- Vercel CLI OAuth se úspěšně obnovil přes cached CLI58.5.1 `whoami`; helper
  `/tmp/backranq-integration-20260906/vercel-api.mjs` znovu funguje. Prod main
  e3c408a, DB46 migrations, všechny completed SQL checksums shodné (2 historické
  rolledback pokusy zvlášť), 0 activejobs/1game/11oldmoments. Žádné externí změny.
  POZOR `gitProviderOptions.createDeployments` řídí GitHub deployment metadata,
  není doložené vypnutí Vercel Git builds; nepoužívat ho za takovou ochranu.

Aktuální priorita: maturity+CPU opravy → nezávislé CR → targeted real repro →
fresh capture/comparator a izolovaný ≥60-moment browser benchmark. Production
release pořád čeká na skutečně splněné kvalitativní/performance gates.

1. Znovu zkontrolovat dirty diff a převzít poslední handoff agentů `engine_pool`,
   `integrate_core`, `v4_contract`; nevytvářet paralelní editory stejných souborů.
2. Dokončit a zreviewovat performance opravy, spustit focused regressions,
   následně celý lint/typecheck/test/build/client-bundle-budget.
3. Zopakovat izolovaný browser smoke na stejných datech; měřit pending paint
   a unknown support odděleně. Žádná souběžná CPU zátěž během měření.
4. Dokončit all-legal comparator + 60 pozic / 10 každého strata a browser benchmark;
   vysvětlit neshody. Neměnit kvalitativní hranice jen pro zelený benchmark.
5. DB-backed E2E přes připravený loopback wrapper, potom finální nezávislé CR.
   Rozhodnout o nejjednodušším čistém resetu místo případné zbytečné datové migrace.
6. Až po gates normální integrace do main a nasazení přesného main SHA.

Lokální nástroje: `scripts/run-practice-v4-audit.mjs`,
`scripts/run-practice-v4-position-audit.mjs`, `scripts/benchmark-practice-feedback.mjs`.
DB/E2E wrapper: `/tmp/backranq-v4-db/run.py` a `e2e-private.py`; credentials pouze
v paměti/env, výstup redigovaný. E2E cíl je výhradně disposable loopback DB,
nikoli sdílené prostředí. Běžící databázový kontejner není nutné kvůli pauze mazat.

## Další ověření 2026-09-07 — paired maturity a MATE

- První maturity check prošel1600tests/247files+39skip/build/lint/typecheck/budgets.
  Log `/tmp/backranq-v4-check-maturity2.log`; practice197.1KiBgzip.
- DB4/4currentproducer/attempttests pass; native/browser/parity/FIRSTrealpass.
- FullE2E72pass5skip1fail: realWASM Qe7 nevyhodnocen. Izolovanýrerunpotvrdil
  MATEstarvation: rootmate1maxdepth245/6373nodes; alternative mate2/736nodes.
  V4přidává úzkou MATEpair výjimku znodefloor (stále ENGINE, žádnáfakeRULE).
- Freshcapture`artifacts/practice-v4-mature-extraction`65moments/18perspectives,
  1565searches/243220936requestednodes completed. Diagnosticnextpolicy.
- Targeted12oldfailurechoices:10corrected1UNKNOWN1stillfalseGOOD(index27g1f2).
  Fresh5.6McomparatorlossE.3685; lokálníGOODmáanchor3187nodes/latest39528.
  V4přidává BOTH25kconvergenceanchors. Bounded ladder25/50/100/200/400k
  withdrewGOODat100k andstableBELOWat200k. Artefacts`practice-v4-maturity-targeted`.
- Fullquality`practice-v4-mature-quality`rootPID20202stoppedSIGINTbeforecompletion,
  smoke`practice-v4-mature-smoke`completedonlydiagnostic. Noalllegalstarted.
- engine_poolownstestdiagnosticattachment+policyCR, v4ownspolicy/fixtures;
  integrate_corefinalcross-laneCRclean. Rootownsdocs/harness/release. Noengines
  left except any explicitagentfocusedwork. Noexternalwrites/deploy/mainchanges.
- Afterfreeze: targetedindex27fresh/rederiveddiagnostic + realWASME2E first,
  thenfreshcapture/alllegal/fullquality/DBE2Eoffline + isolatedbrowserbenchmark.

## Paired freeze a plný diagnostický audit — historický průběh

- Aktuální paired policy + MATE + OPPONENT bound veto CR čisté. `pnpm check`
 1607 tests /248files +39skip prošel; log `/tmp/backranq-v4-check-paired2.log`.
- Rebuilt E2E73pass5skip (`/tmp/backranq-v4-db/e2e-paired.log`), offline19pass1skip,
 focusedDBproducer/attempt4pass, FIRSTrealpass, compiledQueuebundle/callbackpass.
 Native/browserprotocol/parity beze změny adaptérů z předchozího úspěšného běhu.
- `practice-v4-paired-extraction`:63moments/17perspectives completed.
 Import `practice-v4-paired-alllegal`:63actual+10RULE=73positions completed.
- All-legal compare nyní běží tři disjunktní rozsahy:0..24(session61785,PID25385),
 25..49(55345,25386),50..72(93251,25387). Logs `/tmp/backranq-v4-paired-alllegal-{a,b,c}.log`.
 Parent nechává celý audit doběhnout kvůli kalibraci, i přes známou neshodu.
- Fullqualitylab paired ještě běží session18402/PID23106, product16/16hotovo,
 reference průběžně; log `/tmp/backranq-v4-paired-quality.log`.
- Targeted fresh g1f2 už bezfalseGOOD, ale UNKNOWN po1.125Mrequested/8jobs.
 - Game0/ply72 se s paired evidence ZNOVU EMITUJE. Staré tvrzení o jeho vynechání
 je historické. d2b1 má stále potvrzenéfalseGOOD:localdepth11..13/36424..41083nodes
 -54cp;freshstrongref-33/actualmove-142/lossE.4655. c3b3správněBELOW;d2f1strongUNKNOWN.
 Broadaudit první13pozic/407moves:1falseGOOD(d2b1),0falseBELOW,30runtimeUNKNOWN,
 72comparatorUNKNOWN,0invalidpatches. Nenípassingreleasegate.
- V4 diagnostická kalibrace bez změn produktu: asymmetricprior25k/latest50k,100k,200k
 versus oba50/100k a nodeincrement25k/ratio2; data `practice-v4-paired-targeted/calibrate-work.md`.
 Vyššílatestfloor blokujezachycenýfalseGOOD; oba100k často starvují kvůlilast3window.
 Čekat na širší výsledek před volbou policy. d2f1diagnostika měla warmTTpo d2b1,
 nesmí se vydávat za nezávislý coldTT důkaz.
- engine_pool řeší read-only dvě harness/performance otázky: parse/patch validace
 opakujePVfacts mezivalidateEvidence acreateAssessmentEvaluator (300–850ms/patch);
 a INDEPENDENT_ANSWERS resetujepool aleTT stejnýengine mezihypotetickýmiodpověďmi.
 Nesmí měnit source fingerprint za běhu; navrhnout čistý minimalfix/poctivýprotokol.
- integrate_core ověřil read-only main-only release cestu:mainnechráněný,e3c408a;
 lokálnímerge+pushpouzemain, dočasněautoAssignCustomDomainsfalse,cronsfalse,projectpause,
 drainoldworkers →productionREADYexactmain+CI →migration47 →promote →unpausehealth →restore.
 ŽÁDNÉ externí zápisy ani main/commit/push/deploy dosudneprovedeny.

## Aktuální stav: asymetrická konvergence, 7. září

- Předchozí all-legal běh byl zastaven. Dokončil 27 pozic / 824 tahů,
  s jedním potvrzeným false GOOD. Jeho engine sdílel transpoziční tabulku mezi
  hypotetickými odpověďmi, a proto nejde o nezávislé první odpovědi. Stav je
  výslovně zaznamenán v `practice-v4-paired-alllegal/discovery-status.json`.
- Harness v6 vytváří pro každou neznámou odpověď nový fyzický engine a session.
  Inicializaci měří zvlášť; do času výsledku zahrnuje validaci výsledného patch.
  Comparator bez podložené reference zůstává UNKNOWN. Nejde o přesný oracle.
- Aktuální policy `practice-v4-2026-09-07-asymmetric` vyžaduje pro CP/WDL
  starší bod s alespoň 25 tisíci a poslední bod se 100 tisíci skutečných uzlů.
  Stejné pravidlo platí pro pokračování; úzká výjimka pro konzistentní mat zůstává.
  Prahy kvality ani celkové rozpočty se nemění. Lokální kroky jsou 100/200/400k.
- Skutečné čerstvé první odpovědi d2b1 a d2f1 prokázaly chybnou ranou GOOD
  předchozí policy. Nové regresní fixtures tuto fázi hodnotí UNKNOWN a pozdější
  podložený výsledek BELOW_STANDARD. Policy a scheduler mají čisté vzájemné CR,
  125 + 24 cílených testů a lint prošly.
- Parser sdílí omezenou cache úplných šachových vstupů v jedné validaci;
  kontrola identity, scope, nákladů a důkazů zůstává aktivní. Diagnostický patch
  zrychlil ze 650 na 143 ms. To není finální browser latency gate.
- Coverage přeskočí CP/WDL hledání, pokud jeho povolený rozpočet nemůže dosáhnout
  nového posledního bodu. Tři cílené testy prošly; nezávislé CR bylo vyžádáno.
- Paired quality lab dokončil všech 16 + 16 her: 57 produktových a 53 silnějších
  momentů, 49 společných. Tři produktové momenty označil silnější běh za původně
  dobrý tah; tento rozdíl je potřeba doložit a vyřešit, není to passing gate.
- Nový `pnpm check` běží do `/tmp/backranq-v4-check-asymmetric.log`; čerstvý
  producer capture do `artifacts/practice-v4-asymmetric-extraction`, log
  `/tmp/backranq-v4-asymmetric-capture.log`. Následuje skutečný first-choice audit,
  izolovaný browser benchmark a aktuální DB/E2E ověření.
- Dosud žádný commit, push, merge, externí zápis ani deployment. Produkce zůstává
  na původním main SHA. Nasazení čeká na ověření správnosti a výkonu.

## Navazující integrované review a dokončovaný audit

- Finální CR opravilo tři skutečné závady: pozdní výsledek nyní zachová zvolený
  review pohled; změna GOOD přes neutrální stav na BELOW zobrazí opravu i na
  homepage; REVEAL nemůže předběhnout dřívější RECORD/ENRICH stejného pokusu.
  Nezávislé CR všech oprav je čisté. `pnpm check` znovu prošel: 1 631 testů,
  251 souborů, 39 opt-in skip; build/lint/types/budgets zelené. Log
  `/tmp/backranq-v4-check-final-review.log`. Devět dotčených DB-backed E2E
  scénářů prošlo nad tímto buildem, log `/tmp/backranq-v4-db/e2e-final-review-focused.log`.
- Asymmetric capture dokončil 66 momentů / 18 perspektiv. All-legal v6 běží
  nad 76 pozicemi (66 skutečných + 10 RULE) ve třech rozmezích 0–25, 26–51,
  52–75. Sessions 83436, 90322, 47359; logy
  `/tmp/backranq-v4-asymmetric-alllegal-{a,b,c}.log`. NEZASTAVOVAT při první
  neshodě; potřebujeme dokončený kalibrační vzorek.
- Při 66 dokončených pozicích / 2 060 tazích: dvě false GOOD (index18 e1d1,
  e1e2), tři false BELOW (index37 d5e4; index64 f7f6, h7h6), 110 lokálních
  UNKNOWN, 275 comparator UNKNOWN, žádný nevalidní patch. Všechny neshody jsou
  dodatečné lokální odpovědi, nikoli okamžité předpočtené odpovědi. Není to pass.
- V4 agent diagnostikuje úplné průchody místo časného ukončení při supportu.
  Pro první tři false BELOW dokončený následný 200k průchod odstranil chybný
  verdikt (na UNKNOWN); 400k/800k později našel GOOD se stejnou zaplacenou
  referencí. Další dva false GOOD zatím diagnostikuje. Žádná další změna policy
  či gradingu dosud nebyla provedena.
- Full asymmetric quality lab dokončil 16+16 her: 51 product / 53 reference,
  47 společných, 4 product-only / 6 reference-only. Tři product-only má reference
  UNRESOLVED, Kqm8tLd3 ply35 však znovu explicitně ORIGINAL_MOVE_QUALITY_CONFIRMED.
  Ten zůstává otevřený problém výběru; fresh izolované párové 4.8M adjudication
  bylo UNKNOWN a tento opačný důkaz neruší. Výsledky
  `artifacts/extraction-quality-lab/practice-v4-asymmetric-quality/full.json`.
- Read-only ověřena výkonnostní mezera: server/browser mají totožné JS/WASM,
  NNUE a nastavení, ale `analysisEngineFingerprint` zahrnuje provenance `source`.
  Browser proto opakuje referenci serverového momentu. Je potřeba čistě oddělit
  identitu výpočtu (artefakt/NNUE/options/WDL) od původu fyzického hledání.
  Návrh zatím není implementován; nechceme pouhou kompatibilitní alias normalizaci.
- UI/pořadí zápisů mění soubory mimo skutečné závislosti grading auditu.
  `bundled-inputs-before-ui-fixes.json` uchovává 23 esbuild závislostí a hashe;
  po opravách všechny zůstaly shodné. Původní širší fingerprint/raw reports
  se nepřepisují. `attemptWriteOrder.ts` není závislost auditu; původní soubor
  je uchován v `/tmp/backranq-asymmetric-audited-attemptWriteOrder.ts.txt`.
- Kategorie narrow má původní přísné pravidlo UNKNOWN=0. Nezávislé review
  schválilo doplňující konzervativní certifikát: GOOD≥1 a GOOD+UNKNOWN≤3, při
  úplném výčtu legálních tahů a validní finální referenci. Ostatní tahy jsou
  podloženě BELOW, takže nejvýše tři mohou být dobré. Uchovat původní gate,
  UNKNOWN a denominátory; doplněk nesmí předstírat přesný počet dobrých tahů.
- Žádné externí zápisy/main/commit/push/deploy. Browser latency gate zůstává
  až po dokončení a opravách výpočetních auditů, bez souběžné engine zátěže.

## Corroboration follow-up — 2026-09-07

- Předchozí asymmetric all-legal audit je DOKONČEN: 76 pozic, 2 395 tahů,
  333 immediate, 125 runtime UNKNOWN, 308 comparator UNKNOWN, 2 062 vzájemně
  rozhodnutých porovnání. Dvě false GOOD a čtyři false BELOW, nula nevalidních
  patchů / známých tahů se search / překročení requested-node budgetu. Šestý
  případ je předpočtený a5c7, index49; nešlo tedy jen o lokální early stop.
  Původní artefakty zůstávají beze změny; tento výsledek NENÍ pass.
- Implementuje se společná policy `practice-v4-2026-09-07-corroborated`: dvě
  nejnovější po sobě jdoucí relevantní dokončené fyzické search skupiny musí
  každá podložit konečný CP verdikt proti stejné referenci. MATE/RULE a
  reference sama si zachovávají své dosavadní podmínky. Neměníme hranice
  přijatelnosti ani 1.5M/8s lokální rozpočet; poslední pass může využít 800k
  pouze pokud zbývá rozpočet. Skutečný dopad na coverage/latenci je ještě nutno změřit.
- Současně čistá výpočetní identita obsahuje povinný hash JS/WASM, NNUE a
  nastavení; SERVER/CLIENT je provenance. Stejné server/browser bajty tak
  nevyžadují novou referenci jen kvůli místu spuštění. Build ověřuje hashe,
  worker bridge-v8. Chybějící stará identita se nepřijímá jako kompatibilní.
- Nezávisle nalezen mergePracticeEvidence bug: pořadí dictionary keys
  přepisovalo immutable search.sequence. Engine lane zachovává první store
  a připojuje nové search skupiny podle explicitní sequence.
- Native audit v7 získá pro KAŽDÝ legální tah vlastní dvě dokončené silné
  singleton úrovně 800k + 1.6M. Nestačí staré jednoměření promítnout novou
  policy a ztratit comparator denominátor. Nové skutečné audity zatím neběžely.
- První typecheck odhalil dvě chybějící identity a jeden testovací JSON cast; opravy jsou v příslušných lanes. Dřívější pnpm check / E2E
  jsou historický baseline, nikoli nový finální gate. Žádné externí zápisy.

- Krátce spuštěný capture `practice-v4-corroborated-extraction` byl zastaven
  před dokončením kvůli nalezené chybějící RULE identity. Nepoužívat jako
  finální gate; další capture musí použít nový adresář/fingerprint.

### Active empirical gates after source freeze

- Production source frozen; only test fixtures/docs changed since fresh capture.
- `pnpm check` passed 1,674 tests +39opt-in skips; 255files. Later root test-only
  coverage assertion passed3tests and focusedlint/typecheck passed.
- DB E2E73pass/5skip; offline19pass/1skip after explicit mockedartifactidentity
  fix. Native/browserparity5positions, browserprotocolsmoke, FIRST1, DBproducer
  attempts4, compiledQueuecallback allpassed.
- Capture `practice-v4-corroborated-final-extraction`:63validmoments, fingerprint
  ebf1fbd933df2c052fe19b5179c5256f666673cebba9521ba28cbc97b4534c13.
- Alllegal `practice-v4-corroborated-alllegal`:73validcaptures, v7.
  Sessions26493(range0–24),86595(range25–48),34705(range49–72).
  Logs `/tmp/backranq-v4-corroborated-alllegal-{a,b,c}.log`. Complete all ranges;
  don't change source under active comparison. At15positions339moves:0wrong,
  0invalidpatches,35runtimeUNKNOWN/50comparatorUNKNOWN. Not a finalpass.
- Wholegamequality session34527, log `/tmp/backranq-v4-corroborated-quality.log`,
  output `artifacts/extraction-quality-lab/practice-v4-corroborated-quality`.
- Prepared all73canonical manifests for later isolatedbrowserbenchmark at
  `artifacts/practice-v4-corroborated-alllegal/browser-input-manifests.json`.
  Run only once alltaskenginejobsfinish. No latencyclaim from loadednativeaudit.
- No commits/push/main/sharedDB/hostedwrites/deploy. Releasegates stillopen.

### Reference failures discovered in the continuing v7 run

- At59completed positions/1,789moves: nine disagreements,0invalidpatches,
  161runtimeUNKNOWN/255comparatorUNKNOWN. Source stillfrozen, runcontinues.
- Index59 c7c6 PRECOMPUTED selfreferenceGOOD fromone200kroot, actualstrong
  Kb8−35/c6−135; deeperc6line losesqueenfortwoknights. No missingbound bug.
- Index11 seven falseBELOW (a4a5immediateoriginal; b3c2,b3c4,b3d1,c5c4,h2h3,h2h4
  local): sharedoptimistic f4f5 +90/E.673; strongsamef4f5+49/E.517. Allmoves
  drawishCP0–43, so labelsflipviaWDLalone. PaidSCAN100141 androot200126 BOTH
  alreadyqualify2fullroot groups; simple2rootrequirement DOESNOTfix.
- Index16 originalc4d5 PRECOMPUTED falseBELOW. Paidd3d5−60/E.459 vsoriginal
  −140/E.040; strongboth−122/E~.104. AgainSCAN100081 +root200023 already
  2maturefullrootgroups; originalroot+singleton200 arevalid2groups.
- V4 wrote UNAPPLIED proposal artifacts/practice-v4-reference-corroboration-proposal.
  It addsfullrootreferencecorroboration; experiments SHOW IT IS INSUFFICIENT.
  Do NOT blindlyapplythatpatch. It alsoinsufficientlypropagatescurrentreference
  singletoncounterstotheranswers; ALLcomparisonsneedcompletecurrentreference readiness.
- Completedboundedfreshisolatedexperiments8Mrequested/8,004,069actual,4sequential
  enginesstopped, artifacts/practice-v4-reference-experiment. Not FULL_GAME TTreplay.
  11root200/400 staysoptimistic103/95cp,800drops66. Selectedbest200detects
  drop81/E.609,400→70,800→48; afterfurtherroot400+800 prior7wrongbecome4GOOD/3UNKNOWN.
  59root200+400switchespreferredKb8butcanstillclassifyc6GOOD. Selectedc6
  200stillwrongdrawish;400discovers−164,800−142. Root400afterproberecoversKb8,
  c6UNKNOWN. A single200kprobe isnotsufficient either.
- V4 CURRENT boundedfollowup: case16 selectedbest200/400/800 thenroot400/800
  max4Mrequested, plus proposal for explicit completed400kbest-verification,
  reusepaidproof, bidirectionalvaluecounter→rootrefresh, globallysharedrefreadiness.
  NOproductionchangesauthorizeduntilthiswholeauditendsanddatareviewed.
- integrate_core CURRENT owns only scripts/extraction-quality-lab.ts +newhelper/test
  fixingreporttruth: PARTIALunknownmustnotcountasincompatiblebest; rootindexonly
  notcontinuationassessments, tri-statecompatibilitywithresolveddenominators.
  Newreportversion2; existingrawreportsimmutable. Noengine.
- Wholegamecorroboratedquality FINISHED:48product/48reference,44shared,4eachonly.
  Oldreport72.7%bestcompatibilityisbiasedbyUNKNOWN-as-false; do NOTcallitactual
  provenincompatibility. Artifact full.json remainsunchanged.
- Allbroadsuite/E2E/queuegatesabovearegreenfortheCURRENTcorroboratedsource;
  future referencefixwillneednewverification. No browserlatencygate yet, no release.

### Chosen-reference verification design, still before source changes

- The ongoing audit has reached 69/73 positions and 2,200 legal moves: 10
  disagreements (2 false GOOD, 8 false BELOW), 207 runtime UNKNOWN, 339
  comparator UNKNOWN, no invalid patches. Ranges 0–24 and 49–72 exited 0;
  range 25–48 remains active. These counts are provisional, not a pass.
- Fourth failing position: index20 d6d7 is precomputed self GOOD from a single
  mature 200k root (+134cp/E.9155). Strong d6d7 +108/E.799 versus h5e2
  +159/E.972 makes it BELOW. Earlier scan chose h5e2; its retained LOWER+154
  is only20cp above the paid reference, below the existing40cp drift guard.
- Case16 experiment finished with 2.8M requested /2,800,990 actual nodes.
  Selected400k still misses the strong value but fails ordinary self interval
  coherence (.1105 worst expected-score loss >.10), independently of root count.
- Final unapplied design: artifacts/practice-v4-verify-reference-proposal/README.md.
  Current full-root choice plus a completed >=400k actual-node singleton probe;
  one shared complete reference readiness predicate gates all finite assessments.
  Reuse paid proof, refresh root on incompatible value evidence in either
  direction, preserve budgets and exact/mate exceptions. The older two-full-root
  proposal is superseded. Independent design review is underway.
- Quality report v2 helper and seven focused tests are independently reviewed.
  Existing full.json cannot be reprojected: all96 snapshots lack the canonical
  root-scoped GOOD/BELOW/UNKNOWN evidence. New compatibility-v2.json explicitly
  reports NOT_RECONSTRUCTABLE and compatibility null. Input SHA256
  2882ede8e253f2069be39fe9ae141fdb2fbfc26a8e9cfe89871097c210820dec; original
  full.json/full.md remain unchanged. A fresh quality run is required.
- No release writes. Production source remains frozen until the running audit
  completes; reference verification is a next experiment, not a proven fix.

### Completed corroborated v7 baseline; reference implementation started

- All three audit ranges exited0. Final report at2026-09-07T13:07:10Z:
  artifacts/practice-v4-corroborated-alllegal/comparison-summary.json.
  Fingerprint f6720cc89b21e2ed8141a2e659d25b171f1ca2f4a1fc813cb7925a970e5ec913.
- 73positions /2,341legal moves,63actual emitted moments +10RULE. 179immediate;
  219runtimeUNKNOWN,350comparatorUNKNOWN,1,922mutuallyresolved.
  2falseGOOD +8falseBELOW across11/16/20/59, noadditional late failures.
  Zero invalidpatches, knownsearchviolations and requestednodebudgetviolations.
- Strict categories: narrow6,broad20,boundary42,tactical26,saturated10,exactRule10.
  The ten-per-stratum gate is INCOMPLETE. Native loaded timings are diagnostic
  only; isolated browser paint/mobile measurement remains unrun.
- Source freeze released after the final run completed. V4 now owns shared
  reference readiness/policy/schema/fixture/spec; engine_pool owns local planner;
  integrate_core owns bounded extractor scheduling. No external release writes.

- Root added explicit whole-game audit selection to scripts/practice-v4-audit.ts:
  optional --game-indices=1,2,3,18 (after both-players). Selection is validated,
  recorded and fingerprinted; unchanged PGNs and complete source replay remain.
  Focused lint passed. Future targeted command, NOT RUN yet:
  node scripts/run-practice-v4-audit.mjs artifacts/practice-v4-reference-targeted 4 999 both-players --game-indices=1,2,3,18
  Baseline requested work for those four perspectives:29.7M/28.9M/18.2M/23.1M;
  trainable counts6/5/5/5. New run may truthfully omit unresolved decisions.
- integrate_core ownership extended to extractionReceipt.ts +receipt tests for
  clean AdaptiveConfirmationEvidencev2: actual dependency request order can be
  root200/probe400/original200, so old monotonically increasing passes cannot
  represent it. No legacy reader. engine_pool owns the small reasonForSearch
  bridge to preserve VERIFY_REFERENCE telemetry in practiceEvidence.ts.

### Reference implementation interface update

- Shared API: assessPracticeReferenceReadiness({frame,trainingSide,referenceMoveUci,
  policy?,evidence},facts?) and evaluator.referenceReadiness without evidence.
  Returns status READY/MISSING_ROOT/MISSING_REFERENCE_PROBE/REFERENCE_VALUE_DRIFT/
  UNRESOLVED_REFERENCE plus requiredWork ROOT/REFERENCE_PROBE/null, current
  rootSearchId/probeSearchId, evidenceIds/counterEvidenceIds.
- Explicit next dependency fixes a recovery loop: oldroot30/probe30, answer100,
  refreshedroot100 requires a new probe, not more roots. Incompatible probe older
  than current root -> probe; newer incompatible probe -> root. Readiness remains
  blocked until evidence agrees. Separate root/answer ladders and all limits stay.
- Latest eligible mature400k proof is positive witness. Later coherent cheap or
  STOPPED metadata alone cannot erase it, but current contradictory points/bounds
  or unresolved intervals must veto it. Nonself two-consecutive-search requirement
  remains unchanged. Same physical ID cannot serve both roles for a single legal move.
- Current policy ID practice-v4-2026-09-07-verified-reference. Mandatory
  minimumReferenceProbeNodes400000 and strict SearchReason VERIFY_REFERENCE.
- Receipt v2 transport outcome corrected to RETURNED/UNATTRIBUTED (not an invented
  physical completion assertion); canonical evidence supplies actual proof.
- No new actual engine runs yet. Other lanes wait on canonical synthetic fixture
  probe to run focused suites while V4 completes policy/OPPONENT regressions.

### Integrated reference fix and regression migration

- integrate_core core+receipt+route+coverage75/75 focused tests passed at
  /tmp/backranq-verify-reference-extractor-final.log; independent readiness CR
  clean, final retention delta still pending. Non-node profiles use their exact
  depth/movetime limits for a reference probe, no400k-node override, <=2newjobs
  and unchanged wall ceiling. Actual400k eligibility still applies.
- engine_pool66/66 owned tests passed /tmp/backranq-reference-owned-tests.log;
  local planner/guard/telemetry and native/browser scripted snapshot fixtures.
  V4 reviewed local planner clean. engine_pool reviewing extractor/receipt now.
- Root hook now passes analysisRef.current into immediate known lookup and does
  not RECORD stale initial coverage when known was withdrawn. Actual hook in
  Chromium passed1/1 /tmp/backranq-v4-reference-hook.log, scopedlintclean.
- Root first full unit suite:58fail/1638pass/39skip, mostly fixture assumptions
  every observation has3lines (new singleton has1), physicalsequence collisions
  and missing scripted probes. Root migrated six pure-policy fixture suites;
  88/88 passed /tmp/backranq-v4-reference-fixtures2.log. New full suite pending.
- V4 fixed contract/warmup fixtures and practice-position typing. Do not treat
  initial fixture failures as still-unexplained production failures.
- Newly approved shared refinement rule, implementation in progress: two adjacent
  completed mature positive groups remain mandatory, but a later unfinished/
  immature suffix can retain that quality when EVERY retained tail point/bound
  and full interval agrees against CURRENT ready reference. Eligibility is not
  quality-filtered; cannot skip an intervening bad/stopped group to join votes.
  New answers without2proofgroups stayUNKNOWN. This avoids withdrawing a known
  alternative merely because optional tier analysis has started. V4 owns delta,
  integrate_core will independently review. No local alternative grader.
- No new actual engine audits, no production writes. Targeted whole-game capture
  waits for final policy/helper freeze and focused green verification.

### Verified-reference final verification wave

- Complete pnpm check passed: 1722 tests, 39 opt-in skips, 259 test files; lint,
  types, build and bundle budgets passed. Practice199.7KiB/250. Log
  /tmp/backranq-v4-verified-reference-check2.log. This preceded the presentation
  projection-only patch, which separately passed49affected tests and lint.
- Shared retained-proof change and extractor/local/hook CR are clean. Presentation
  projection now uses the cited root baseline; captured case16 displays
  -61→-141 with80cp loss instead of mixing the -58 singleton score.
- Targeted real-game run completed: artifacts/practice-v4-reference-targeted,
  indices1/2/3/18,16valid moments versus21before,131.6Mrequested versus99.9M.
  Old case11 now explicitly NOT_A_MISTAKE; case20 changes preferred to h5e2;
  case59 c7c6 no longer precomputed GOOD. Do not imply their fresh alllegal runtime
  audit has completed.
- Case16 old comparator GOOD is not reliable current-policy ground: its own
  reference was unverified/inconsistent. Fresh bounded adjudication27.2M plus
  continuation16M remained UNKNOWN/REFERENCE_VALUE_DRIFT. Qf4 root-47/probe-121;
  subsequent Rd5 root-57/probe-82 with E difference.0915. Both originalQxd5 and
  servedRd5 remain diagnostically unresolved. No claim of a proven remaining
  false label or a proven fix. All adjudication engines terminated; immutable
  artifacts and sessions: artifacts/practice-v4-reference-adjudication/README.md.
- Final actual producer running: node scripts/run-practice-v4-audit.mjs
  artifacts/practice-v4-verified-final-extraction 32 60 both-players;
  /tmp/backranq-v4-verified-final-extraction.log, session33281.
- Independent full quality lab running /tmp/backranq-v4-verified-quality.log.
  Alllegal harness being updated to current readiness dependency (root or focused
  reference probe), explicit stronger bounded budgets, honest unresolved ground.
  It must be reviewed before the final alllegal run. Browser latency remains unrun.
- No commits/push/main/production/database-host writes/deployments.

- Final projection-source E2E rebuild:73passed/5opt-in skips
  (/tmp/backranq-v4-db/e2e-verified.log); offline19passed/1opt-in skip
  (/tmp/backranq-v4-db/e2e-offline-verified.log). Both exit0.
- Current DB4/4producer+causalattempt tests passed after synthetic correction
  fixture gained its own newpreferred d4referenceprobe. IndependentCRclean.
  Log /tmp/backranq-v4-db/verified-producer-attempt3.log; scopedlint0.
- RealFIRST1/1, browserStockfishprotocol/cancellation, compiledQueuebundle and
  realcompiledcallbackpassed again, logs /tmp/backranq-v4-verified-{first,
  browser-smoke,queue-bundle,queue-callback}.log. Productiondependency audit0
  knownvulnerabilities; currentPracticebundle199.7KiB/250.
- origin/main refreshed and stille3c408a96392448ed41eeca0e43e94df4d0c0a1f.
- Sidecar prepared withoutengines: artifacts/practice-v4-narrow-candidates/
  selected10.json,10nontrivialrealPGNcontexts/23legalanswers,2–3legalmoves each.
  Fullhistory/PGN/sourcehash/rulesvalidated. No claim thatnarrowgatepassed until
  independentcapture+alllegalclassification. Engine_pool owns harnessreadiness
  andinputsidecar integration; V4review mustbe triggeredviafollowup_task.

### Frozen v8 final audits started

- Actual finalproducer completed63validmoments/21perspectives, targetReachedtrue,
  2026-09-07T14:06:15.314Z. fingerprint
  4ae69f29af6ec15a4dbb43d6df2c548c47fb2d385bb2cdd3a8a7c4299848250b.
  First16games40moments/342.5Mrequested vs prior48/272.7M (+25.6%nodes).
- Finalcapture83/83valid:63EXTRACTOR_EMITTED +10CURATED_RULE_EDGE +10REAL_SOURCE_POSITION.
  artifacts/practice-v4-verified-alllegal fingerprint
  b4486dbbbb1f125d5adb675a5eee67d9fcd7f8e09c4e1bbf8eed00db675b49c6.
- Harnessv8 boundedsharedreadiness ROOT/PROBE scheduler independentlyreviewedclean;
 24helpertests+lint+buildpassed. Bothpositive andcounter/UNKNOWNground preserved.
  Rootladder1.6/3.2/6.4M andprobeladder1.6/3.2/6.4M (22.4Mcombinedmaximumreference)
  plus800k/1.6MforEVERYlegalanswer;120s/search. Sidecarcapture2.8M/30s/search.
- ComparisonA0..27 engine_pool90716;B28..55 V4 69479;C56..82 root36798.
  Logs /tmp/backranq-v4-verified-alllegal-{a,b,c}.log. Allrunning, loadednative
  timingsNOTbrowserUXgate. Do notalterfingerprintedsource untilallcomplete.
- Finalpnpmcheck51047running /tmp/backranq-v4-verified-final-check.log.
  Fullqualitylab94754running strongerreferenceprofile. Browserlatencyawaits
  completionofallengine/buildjobs toavoidtask-inducedcontention.

- Finalfrozen pnpmcheck complete1746passed/39opt-in skips,261testfiles, lint/types/
  build/budgetsallgreen; session51047exit0, /tmp/backranq-v4-verified-final-check.log.
  No product sourcechangesafterthisgate.
- Browsercorpus prepared (NOtimingrunyet):
  artifacts/practice-v4-verified-browser/input-manifests.json,83capturedmanifests,
  10,074,909bytes, bundlebuildonly272009bytes. It preserves sourceKind and
  auditfingerprint; don'tcollectmutablecomparisonprogress asbenchmarkinput.
- Auditcount inventory: rangeA934legalanswers, B873, C488
  (C193emitted +272RULE +23nontrivialsmalllegal). Total2295answers.
- At14:15UTC initial7completedpositions/220moves:0disagreements,0invalidpatches,
  27runtimeUNKNOWN,24groundUNKNOWN,7readyreferences. This is PARTIALONLY.

### New bounded stale-counter finding during frozen audit

- V4confirmed P2 atcurrentcomparison30: shallowe1g1 point fromcompleted3.2Mroot
  (depth5/7504nodes,-57cp/E.4225) outlives its own finalcompletebundle membership
  andnew6.4Mroot, incorrectlyvetoing reference d5e4(-71/E.379). Older1.6M
  singleton e1g1(-232/E.003) exists. This starvesreadiness;46groundrowsUNKNOWN,
  notaprovenwronglabel. EntirecurrentauditcontinuesUNCHANGED.
- Proposed4lineguard in preparedReferenceDrift: ignoreUNBOUNDEDsample only when
  itsownsearchCOMPLETED and existingprepared.currentPoint(sample)false, before
  latest-per-move mapoverwrite. Do notdropbounds/STOPPED/incomplete/currentpoints
  orpriorstrongsingleton merelyfromadifferentroot'stopNabsence.
- Artifacts/practice-v4-stale-reference-drift holds exactfixture, proposal,
  patchtext, current/proposedesbuildonLoadprojection(no liveedits). Sameexact
  evidence becomesreferenceREADY; independentintegrate_coredesignCRclean.
  V4prepares8regressiontests outside livefingerprint andfull46groundreprojection
  tolookforpreviouslymaskedfalseverdicts. Noactualguardappliedyet.
- Followupvalidationproposal(readonly,notimplemented): finalfreshproducer+runtime
  afterguardfix, reuseimmutablealreadycompletedstrongrawEvidenceStore on exact
  source+enginebinding, recomputeALLlabels/readiness underCURRENTpolicy; READY
  needs0strongqueries, new/unreadyfallbackfreshboundedstrong. Neverreuseold
  qualitylabels ormutateoldreport. Engine_poolfeasibilitypositive; integrate_core
  reviewsprovenancerequirements. This canavoidthrowingawayunchangedstrongsearches.
- Fullqualitylabverified completedexit0: product40/reference46/shared37;36compatible,
  0incompatible,1UNKNOWN. All12exclusive selections haveotherprofileUNRESOLVED,
  zero positiveNOT_A_MISTAKE contradictions. artifacts/extraction-quality-lab/
  practice-v4-verified-quality/verification.json hasprovenance/rawreportSHA
  a1900e02aace65712de0818b377f4fcd6ab482e0d9c5c816576cfd092604943f.
  No qualitylabengines remain.

### Audit rebalance and post-guard preparation

- C56..82 finished exit0 session36798. To shorten wall time, after completed
  position boundaries A original90716 and B original69479 were deliberately
  terminated (exit130), only their ownedprocess trees. Completedrecords kept.
  A2session56195 resumes0..20, /tmp/backranq-v4-verified-alllegal-a2.log.
  B2session4157 resumed28..44 and alreadycompletedexit0, 17positions/539moves,
  no errors/contradictions. Droot58941 runs45..55, log-d; Eintegrate_core19217
  runs21..27, log-e. All disjoint, unchangedfingerprint. No orphanedengines
  fromstoppedA/B; little/no abandonednext-position work.
- Atlatestinspection76/83positions/2027moves:0disagreements,0invalidpatches,
  strictnarrow8. B2strictnarrow42. Additional selected16.json isready (16nontrivial
  cases/38legalchoices; first10unchanged). V4preparingselected20 including4
  explicitonelegalcontrols for finalcoverage/physical-witnessalias cases.
- Currentreferencefullyunready cases13,30,38. Only30isexpiredcounterbug.
  13ispreviouscase16 context: latest6.4M rootc4d5−115/−94/−85 andactiveUPPER−131,
  selected3.2M probe−113/−134/−134 =>realincoherence.
  38rootd8a5 E.8915/.859/.859 vsprobe.902/.902/.8865+LOWER131 hasintervalgap
  .043>.04; boundedreference ladder exhausted, honestUNKNOWN. Do noterasebounds
  orweakenpolicytoforceeitherresolved.
- Proposedguard index30 pureall46ground regrade:33resolved/13UNKNOWN,0new
  disagreements versuscapturedruntime. Noofficialreportrewritten.
- V4 has8passingartifact-only regressions; transposingnewVitest/minimalrealfixture
  OUTSIDE livefingerprint now. ActualsourceguardstillNOTapplied.
- engine_pool prepared87lineaudit-onlyrawgroundprojection helper+13passing
  artifactchecks under artifacts/practice-v4-comparator-reuse-proposal. RootCR
  clean. Buildsnewcanonicalmanifest andparservalidatesentirerawstore, recomputes
  allassessments/readiness; nodework0/retainedcost separate. Actual0/1/2matchold
  labelsusingcurrentunchangedpolicy,13staysunready.
- Afterauditcomplete: V4appliesguard+tests, engine_pool transposesonlyreprojection
  helper+tests into scripts/lib; rootowns --reuse-comparator cache reader/main
  harnessoption+fingerprint. Expectedidentity mustderivecurrentruntime, verify
  basecaptureHash/reportfingerprint+legalrowbijection+v8boundedprotocol+allbasefile
  SHAs. Preservewholeoldledger separately, nooldlabelreuse. Freshproducer AND
  per-answer runtimerun required; same-source READYstrong datareuse0queries,
  new/unreadyfallbackfreshboundedstrong. NeednewCR/gates/isolatedbrowserbenchmark
  thenauthorized main-only production workflow.

### Final source freeze, checks and v9 audit (2026-09-07T15:30Z+)

- Final producer complete:66validmoments/21perspectives, finalinput under
  artifacts/practice-v4-final-extraction. Presentation-only wrapper difference
  proven old/new identical on66manifests; no engine rerun needed.
- Current pnpmcheck fullygreen1779/39skip; test-only migrationgrandchildstartup
  flakefixedwithout changingtimeout or productioncode. FinalDBE2E73/5skip,
  offline19/1skip. IndependentlastUI/reference/cache reviewsallclean.
- V9capture96/96 fingerprinta883523083276d5f8957156a6cbbf2f4fa5e1ffc134cb9b16b9e303131097b26.
  Options onALL capture/compare: --input-manifests=artifacts/practice-v4-final-extraction/input-manifests.json
  --input-sources=artifacts/practice-v4-narrow-candidates/selected20.json
  --reuse-comparator=artifacts/practice-v4-verified-alllegal. Outputfinal-alllegal.
- A0..29 engine_pool session23731. B30..44 V4 session77524 (old61334terminated
  after37safe;30..37skip). C60..95integrate_core DONE36positions/468moves/0opposition,
  11strictnarrow+4forcedexcluded. D45..59integrate_core session8811 active.
- Zero observeddisagreements/invalidpatches. New13 staysunreadyafter136Mfresh
  fallback; new40(old38) now29resolved/4UNKNOWNafter92Mfreshfallback,0opposition.
- Finalbrowserinput96manifests prepared artifacts/practice-v4-final-browser/input-manifests.json.
  Build272130bytes; actualdesktop/mobilebenchmarkNOTRUN untilallengine/buildjobsstop.
- Live readonlyrefresh:prodmain e3c408a,configuredproductionBranchmain,46migrations,
  0activejobs/0outbox/11oldmoments/1sourcegame. No commits/push/hostedwrites/deploy.


## Final pre-integration checkpoint (2026-09-07 UTC)

All implementation and independent CR complete. Application check1780green,
full DB E2E73/5skip+offline19/1skip, final Practice E2E4/4, migration regressions3/3,
fresh/upgrade/RLS/schema/shadow/type/lint green. Final all-legal96/2419 with1965
mutuallyresolved and0supporteddisagreements. Final desktop/mobile96/802each:
paintp95 16.7/16.9ms, unknownfirstsupportedp95 1664.2/2282ms,0supported
disagreements,61UNKNOWNeach, mobile1boundedtimeout. Final gates artifact:
`artifacts/practice-v4-release/final-gates.json`. Empty-pool performance fix and
MasterPipelineRun migration cleanup are included; see verification document for
precise provenance and limits. Next: reviewed commit, main integration, CI,
coordinated migration/deployment and actual production queue/public health.
No v4 production write has occurred at this checkpoint.
