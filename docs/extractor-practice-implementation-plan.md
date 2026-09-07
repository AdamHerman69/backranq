# Implementace společného extraktoru a Practice kontraktu v4

Datum: 2026-09-06. Stav: implementace probíhá na `feature/extractor-practice-v4`,
výchozí main `e3c408a96392448ed41eeca0e43e94df4d0c0a1f`.
Finální integrované ověření a nasazení dosud nejsou dokončené.
Normativní chování: [cílová specifikace](extractor-practice-target-spec.md).

## 1. Mandát a výchozí stav

Původní plán byl následně schválen k implementaci. Práce nyní zahrnuje
aplikaci, nový kontrakt, přesně omezenou migraci a ověření podle níže uvedených gates.
Před pozdější implementací obnovit stav main/worktree; neplánovat patch proti
neověřenému starému commitu. Inspekce tohoto plánu proběhla na
`e27f8324ed8350b9b156c4fe68c6ec05ef51ce3e`, větev
`fix/supabase-session-readiness`. Kanonický checkout má main
`e3c408a96392448ed41eeca0e43e94df4d0c0a1f`.

| Oblast | Ověřený dnešní stav | Potřebná změna |
| --- | --- | --- |
| Sdílená extrakce | FULL_GAME a FIRST_PUZZLE používají stejné jádro. | Zachovat, nesplitovat nové algoritmy podle runtime. |
| Scan | Explicitní sousední reuse a checkpointy. | Přidat omezený pool použitelných observations. |
| Confirmation → puzzle | Poslední MultiPV se předává přes seed; verifier root search přeskočí. | Rozšířit na výsledky všech relevantních průchodů a jejich konvergenci. |
| Engine session | Oba adaptéry drží TT mezi souvisejícími search. | Zachovat; doplnit jednotný snapshot/search evidence kontrakt. |
| Hodnocení | Pevný cp strop a WDL loss, tier a accepted v jednom výsledku. | Policy v4, quality/tier/original relation zvlášť. |
| Pokrytí | PARTIAL je podporované; residual experiment není zapojen. | Pravdivý AnswerIndex, levné omezené doplnění, žádný povinný residual algoritmus. |
| Lokální dopočet | Každý průchod může dělat best/submitted/original/canonical search. | Pool + plán chybějících důkazů, původní tah mimo blokující cestu. |
| Pokus | RECORD a ENRICH, revision evidence a offline outbox již existují. | Zachytit tah ještě v PENDING, oddělit quality od finálního detailu. |
| Practice a homepage | Sdílený runtime grading, generační ochrany. | Pending/live feedback a prioritizace bez regresí těchto ochran. |
| Quality lab | Corpus, reálné enginy, potvrzovací a runtime audity. | Změřit odezvu pro různé zahrané tahy a skutečnou úsporu reuse. |

## 2. Pořadí a vlastnictví změn

Závislosti: **A → B → C → D → E → F → G**. Testovací fixtures a měřicí
harness z G připravovat už u A; finální měření až nad integrovaným tokem.
Jde o reviewable lokální etapy jednoho cílového kontraktu. Mezistavy se
nenasazují a nevytvářejí runtime dual-read. Případní pracovníci musí mít
oddělené soubory/worktrees; sdílený kontrakt vlastní jeden integrátor.

### A — kvalitativní model, typy a executable fixtures

Soubory: `src/lib/training/contracts.ts`, `grader.ts`, `gradingEvidence.ts`,
`config.ts`, `acceptanceFrontier.ts`, `evidenceContract.ts`, sdílené hash/semantics
moduly; nové `assessmentPolicy.ts` a `answerIndex.ts` jen pokud oddělení
zjednoduší autoritu. Nevytvářet paralelní grader s jinou logikou.

- Zavést v4 entity ze specifikace a explicitní nullability/union varianty.
- Nahradit pevný success cp limit adaptivní policy; model a tolerance uložit
  do snapshotu/hash. Staré enumy míchající kvalitu a zlepšení odstranit.
- Implementovat čisté assessMove, podpůrné intervaly, lookup odpovědi,
  odvození readiness a validaci referenční uzavřenosti.
- Zrušit odvození chyby z acceptanceFrontier/top-N nebo jediného booleanu.
- Přidat fixtures pro přesné hraniční a outcome příklady, ne snapshoty
  odvozené pouze ze samotné implementace.

Hotovo: fixture klasifikace souhlasí s ručně napsanými očekáváními; quality
se nemění změnou original comparison ani pořadí téměř rovnocenných tahů.
Zmizí staré runtime závislosti na success/maxCpLoss a grade=IMPROVED.

### B — společný pool a engine observations

Soubory: `src/lib/analysis/stockfishClient.ts`, `serverStockfishClient.ts`,
`public/vendor/stockfish/backranq-engine.worker.js`, `extractionCheckpoint.ts`;
nové `positionAnalysisPool.ts` a `analysisWorkPlanner.ts`.

- Adaptéry nabídnou stejný callback dokončených snapshots a finální evidence.
  Sjednotit depth buckets, bounds, search ID, scopes a cancellation.
- Odrážet reálný ukončený scope. Rozlišit kompletní K-slot bundle od enumerace
  všech legálních odpovědí a od případné horní meze celého scope.
- Pool uloží používané observations a poslední tři kompletní snapshots;
  deduplikuje reference, nesčítá cache hits jako nová měření.
- Work planner vyžaduje reason a evidence dependency pro každé hledání.
  „Začala fáze coverage“ nesmí projít jako důvod k novému root search.
- Zachovat engine hash mezi souvisejícími úlohami. Checkpoint serializuje
  potřebný pool, ne native TT; resume obnoví data bez falešné session identity.

Hotovo: stejná instrumentovaná posloupnost v obou adaptérech vytváří stejnou
sémantiku; nekompletní/bounded/mixed-depth výsledky nezískají falešný support.
Cancellation nepoškodí novější job. Validní reuse má nulový počet nových search.

### C — extrakce a derivace root odpovědí

Soubory: `src/lib/analysis/extractTrainingMoments.ts`, `continuationVerifier.ts`,
`extractionReceipt.ts`, `extractionManifest.ts`, `analysisCompletion.ts`,
`extractionConfig.ts`; `residualCoverage.ts` zůstává experiment.

- Vložit scan a všechny potvrzovací výsledky do poolu; vyjmout společné
  decision assessment odvození ze současného navázání na legacy tier.
- Reference MultiPV a explicitní original vznikají jen při nedostatečné
  kompatibilní evidenci. Získat konvergenci z existujících snapshots před
  rozhodnutím o dalším celém průchodu.
- Sestavení root AnswerIndex je čistá funkce bez enginu.
- Emitovat moment po potvrzení; volitelná coverage podle přesných pravidel
  a součtového limitu specifikace. FIRST_PUZZLE má před emit extra budget nula.
- Odstranit automatický lesson gate; zachovat explicitní důvod nízké hodnoty
  při samotném saturovaném cp signálu. Nezaměňovat to s nedoloženou chybou.
- Oddělit explanation a připravené následné USER uzly. U každého dalšího
  rozhodnutí stejný grading kontrakt; selhání větve neruší root.
- Aktualizovat receipt a checkpoint: všechny důvody, skutečně provedená práce,
  completeness FULL_GAME proti časnému ukončení FIRST_PUZZLE.

Hotovo: potvrzovací data se neztrácí, baseline scan se neduplikuje, root
projekce dělá nula search. Široká sada dobrých tahů nevyvolá enumeraci do konce.
Původní tah musí být v dané revision podstandardní a aspoň jeden známý tah dobrý.

### D — persistence, API a idempotentní pokusy

Soubory: `prisma/schema.prisma`, nová přesně omezená migrace,
`src/lib/training/persistence.ts`, `candidateValidation.ts`, `api.ts`,
`apiValidation.ts`, `apiMappers.ts`, `readService.ts`, `attemptService.ts`,
`offlineQueue.ts`, `src/lib/api/trainingMomentPersistence.ts`, training routy,
Master candidate/publish payloady a progress/scheduler spotřebitelé.

- Uložit nový normalizovaný manifest/revision a oddělený slovník evidence;
  nezduplikovat solution graph v každém assessmentu.
- Odebrat redundantní closed-set sloupce a JSON autority. Ověřit všechny
  Prisma enumy a indexy, které dnes předpokládají legacy AttemptGrade.
- Typy, constructor, hash a validátor musí být jeden kontrakt; round-trip
  server i browser candidate → DB → feed → grade musí zachovat význam.
- Přidat PENDING move event; quality může vyřešit event bez hotového detailu.
  ENRICH je append-only se sequence a supersedes, idempotentní a revision-bound.
- Podporovat outbox RECORD→ENRICH, opakované requesty, starší příchozí výsledky
  a explicitní correction. Aktualizace agregátů/scheduleru započítá jeden tah jednou.
- Oddělit osobní client evidence od kanonické publikace. Validovat legalitu,
  strukturu a společně přepočítaný závěr, ne deklarovat engine attestation.

Migrace podle pre-user policy: žádný legacy reader, backfill ani dual-write.
Před návrhem SQL vypsat závislé tabulky; reset omezit na nekompatibilní training
revision/attempt/publication graph a odvozené agregáty. Zachovat zdrojové hry,
účty a nesouvisející data. Tento plán sám žádnou destruktivní operaci neprovádí.
Nově vznikající v4 historie se zachovává podle revision kontraktu.

Hotovo: izolovaná DB potvrdí transakce, foreign keys, ownership/RLS, retry,
migraci a shape parity. Podmínky osobního i Master consumeru neodmítají v4
kvůli starému implicitnímu COMPLETE požadavku ani nezměkčují publication gate.

### E — lokální plánování a prioritní dopočet

Soubory: `src/lib/training/localGrading.ts`, `src/lib/hooks/usePuzzleSession.ts`,
společný work planner/pool a engine lifecycle.

- Hydratovat známé assessmenty bez engine. Při aktivaci puzzle jeden prewarm
  a nejvýše jeden omezený background job.
- Implementovat priority/závislosti a součtový budget, včetně čekání, retry
  a případného restartu enginu. Stop optional work při skutečném tahu.
- Neznámý tah s kompatibilní referencí potřebuje jen vlastní search a případné
  zesílení podle důkazu. Neopakovat bezpodmínečně best/original/canonical v cyklu.
- Nekompatibilní server/browser model vytvoří lokální frame jednou. Reference
  drift invaliduje potřebné závěry, nikoli source moment či celé PGN.
- Emitovat immediate → live estimate → supported quality → optional detail.
  Při změně session zahodit pozdní callbacky; zachovat bezpečné předání na homepage.

Hotovo: trace běžného neznámého tahu s hotovou referencí neobsahuje original
ani nový unrestricted best search. Známý tah má nula search. Vyčerpaný budget
nevyvolá implicitní penalizaci ani nekonečné spinner čekání.

### F — odezva desky a spotřebitelé výsledků

Soubory: `src/components/training/TrainingTrainer.tsx`, `PuzzleBoard.tsx`,
`PostMoveStory.tsx`, `src/lib/training/trainerState.ts`, `boardPresentation.ts`,
`presentation.ts`, `postMoveStory.ts` a homepage integrace.

- GOOD, obecné SUBPAR a neutrální PENDING vykreslit jako rozdílné stavy.
  Spinner označuje konkrétně chybějící detail nebo kvalitu.
- Live cp vždy stejné POV, průběžné označení, throttle; nepřevádět každou info
  řádku na střídající se červenou/zelenou značku.
- Zlepšení proti partii ukázat samostatně, odměna za best není gate extrakce.
- Po podporované quality umožnit postup bez čekání na původní tah/explanation.
- Po timeoutu otevřít normální review bez falešného výsledku; korekce nesmí
  být skryté ani vytvořit nový pokus.
- Homepage zachová jednu desku a stejný engine/session. Offline a mobil mají
  stejné stavy i při nedostupném runtime.

Hotovo: browser test skutečně provede známý, neznámý a opravovaný tah, změnu
puzzle během výpočtu, offline retry a homepage přechod. Žádný pending závěr
se nezapočte jako špatná odpověď a žádný detail nezablokuje už známou kvalitu.

### G — benchmark, code review a integrace

Soubory: stávající training/Stockfish testy, `tests/fixtures/training-v2/`,
nové v4 policy fixtures, extraction lab scripts, runtime parity a E2E harness.
Výsledky patří do `artifacts/`, stručný reprodukovatelný závěr do docs.

Provést kontroly níže, vypořádat nálezy a až pak připravit release z main.
Ladění konstant se zapíše do policy/profile snapshotu a fixtures; historický
benchmark nesmí být přepsán tak, aby nebylo vidět změnu hranice.

## 3. Povinné scénáře a gates

### Správnost

| Scénář | Požadovaný výsledek |
| --- | --- |
| +20 cp vs −130 cp | BELOW_STANDARD, i když original byl ještě horší. |
| +320 vs +250, E 0.96 vs 0.93 | GOOD při podložených stabilních observations. |
| +400 vs +200, E 0.99 vs 0.97 | GOOD; další dvacítka takových odpovědí neblokuje root. |
| +400 vs −200 | BELOW_STANDARD, bez závislosti na přesném tieru chyby. |
| Stejné cp, ale zásadně horší kompatibilní WDL | Žádné obejití přes CP_ONLY. |
| Nejistý GOOD/STRONG tier | Podporované GOOD zůstává okamžitě dostupné. |
| Odpověď #6 je dobrá a předpočteno top5 | Pending → GOOD, žádná okamžitá falešná penalizace. |
| Všech top5 dobrých, 30 legálních tahů | Bez nepovinného rozšíření během extrakce. |
| Legálních 6, jednotlivě hodnoceno 5 | Nejvýše jeden budgetovaný doplňující search. |
| Cache hit stejného snapshotu | Nevytvoří nové potvrzení/stabilitu. |
| Lepší nový tah a záporná loss | Obnova reference; ne clamp na nulu. |
| Jiná historie stejné FEN | Žádný neplatný reuse. |
| Mate, stalemate, repetition, claim a TB | Výsledek podle skutečných pravidel/provenance, žádné falešné cp. |
| Partial/bounded/mixed-depth MultiPV | Neposkytuje nepodložený skupinový verdikt. |
| Pozdní completion starého puzzle | Nesmí změnit nové puzzle, attempt ani engine job. |
| Retry ENRICH, reordered delivery, offline | Jeden tah/jeden výsledek agregace, opravy dohledatelné. |
| Neznámý tah + nefunkční engine | Neutrální review, UNAVAILABLE uložené bez penalizace. |
| FULL_GAME a FIRST_PUZZLE | Stejná policy a kontrakt; pravdivé rozdílné completion receipts. |
| Alternativní dobrá větev | Vlastní continuation/review, žádná cizí PV. |

Fixture hodnoty pro support obsahují minimálně požadované dvě observations
a dostatečnou sílu. Samotný pár cp hodnot není důkaz konvergence. Vedle jednotkových
fixtures zahrnout skutečné Stockfish pozice; silnější engine je comparator,
ne neomylná ground truth.

### Náklady a odezva

Před změnou uložit baseline na stejném corpus SHA a profilech. Porovnávat
stejné vstupy a rozpočty, cold i warm odděleně, běhy bez souběžné zátěže.
Povinně vykázat p50/p95, počty i denominátory; prázdná množina není 100% úspěch.

Metriky:

- fyzické searches, requested/reported nodes a čas podle reason;
- přebrané výsledky, potvrzení využitá pro odpovědi, opakované reference/original;
- time-to-first-moment, known-lookup-to-paint, unknown-to-first-live,
  unknown-to-supported-quality, quality-to-final-detail;
- podíl okamžitých podporovaných závěrů, pending, timeout a následných oprav;
- náklady volitelného doplnění proti dosaženému zlepšení odezvy;
- velikost promptu/revision/evidence a serialized checkpointu;
- momenty vynechané/neprávem přijaté, false GOOD a false BELOW_STANDARD proti
  silnějšímu comparatoru, nejisté rozdíly a lidsky zkontrolované případy.

Tvrdé implementační gates:

1. 0 nových searches pro známou odpověď a confirmation→root projekci.
2. 0 bezdůvodných original/reference search při připraveném kompatibilním frame.
3. 0 falešných negativních značek z top-N absence v regresních scénářích.
4. 0 porušení součtových budgetů, duplicitních pokusů a cross-session writes.
5. Extra extraction nodes nejvýše limity specifikace; FIRST emit nečeká na enrichment.
6. Všechny klasifikační neshody na regression corpus jsou vysvětlené změnou
   explicitní policy nebo opravené. Nesmí zůstat nevysvětlený chybný podporovaný verdikt.

UX benchmark cíle pro první vydání: immediate feedback p95 <=100 ms včetně
paint; warm neznámý tah p50 <=1 s, p95 <=2 s na určeném referenčním desktopu,
mobilní p95 <=4 s. Cold start reportovat odděleně. Nejde o slib na všech
zařízeních. Překročení se vyšetří a rozpočet/runtime optimalizuje; není důvod
označit dosud neznámý tah za chybný. Pokud cíle nejdou splnit bez kvalitativní
regrese, výkonnostní část zůstává nedokončená. Před označením celé implementace
za hotovou je nutná další optimalizace nebo explicitní, důkazy podložená revize
cíle. Release report nesmí tvrdit plné splnění podle pouhého zeleného unit testu.

Reprezentativní test sada: alespoň 60 různých momentů, minimálně 10 z každé
kategorie: úzká odpověď, široká dobrá sada, hraniční evaluace, taktika, saturovaná
pozice, pravidlový/exact okraj. U každého testovat všechny legální tahy v offline
grading harnessu proti silnějšímu comparatoru; tento náklad patří do auditu,
ne do produkční extrakce. Překryvy kategorií reportovat, nenahradí 60 unikátních pozic.

Pro latenci zvolit předem stratifikovaný vzorek alespoň 10 legálních odpovědí
na moment, pokud tolik existuje: známá dobrá, původní chyba, jiné slabé,
hraniční a mimo známé jádro. Uvést konkrétní hardware, OS/browser, engine a
profil; fyzický mobil nebo jasně označená emulace. Neodvozovat četnost lidských
voleb z uniformního vzorku. Skutečná played-move distribuce zatím není známa.

### Code review a testy

Review provést odděleně od autorství implementace pro tři oblasti: engine/
šachová sémantika, kontrakt/persistence/idempotence, runtime/UI/performance.
Nálezy musí mít reprodukci a uzavřený regression test nebo doložené odůvodnění.
Závěrečné integrační review čte celý finální diff proti aktuálnímu main,
nejen jednotlivé etapy. Zero otevřených blokujících nálezů před releasem.

Při implementaci použít aktuální package scripts. Ověřený dnešní základ:

```bash
pnpm check
pnpm check:db-contract
pnpm check:schema-shape
pnpm test:e2e
pnpm test:e2e:coach-offline
pnpm smoke:stockfish-browser
pnpm quality:extract:smoke
pnpm quality:extract
node scripts/audit-runtime-parity.mjs
```

DB/live lanes vyžadují vlastní izolované prostředí a jejich skutečné opt-in
nastavení podle testů/CI. Skip není pass. Celé check neběží kvůli samotné
dokumentaci; tyto příkazy jsou budoucí validační plán, ne záznam provedení.
Změny snapshot protokolu vyžadují reálný server i browser Stockfish smoke,
schema změny čistou migraci i upgrade fixture a produkční build všech consumerů.

## 4. Integrace a budoucí produkční release

1. Před změnou založit implementační branch z aktuálního main, ověřit souběžné
   práce a rozsah; dokumentaci z tohoto worktree přenést bez cizích změn.
2. Dokončit A–G, code review, regression a quality/performance report.
3. Připravit přesné migrační SQL, seznam měněných/resetovaných tabulek,
   obnovu tréninkového obsahu ze zdrojů a plán zastavení starých jobs při cutover.
4. Při autorizovaném releasu integrovat změnu normálně do main, zkontrolovat
   finální SHA a že obsahuje celý cílový kontrakt.
5. Koordinovat migraci a nasazení tak, aby starý worker nepsal nový/nekompatibilní
   graph. Žádné kompatibilní mezischéma nebo dvojí zápisy; krátký koordinovaný
   pre-user cutover je přípustný.
6. Produkci postavit pouze z přesného main SHA. Ověřit provider production
   branch=main, deployed SHA před/po a migration state.
7. Health checks: homepage první puzzle, osobní full scan v obou runtime,
   persistence/feed, známý a neznámý tah, offline enrichment, queue resume,
   veřejný puzzle consumer. Zveřejnit skutečný výsledek a zbývající limity.

Aktuální plán neprovádí commit/push/merge ani nasazení. Při realizaci se
autorizace posoudí podle platného zadání; nevytváříme nový požadavek na
opakované schvalování již autorizovaných kroků.

## 5. Výstupy implementace

- Společný kontrakt v4 a jediná policy se zdokumentovanými kalibračními hodnotami.
- Pool evidence a auditovatelný planner, který eliminuje zbytečné nové výpočty.
- Extraktor emitující okamžitě použitelný root bez požadavku na úplnou sadu odpovědí.
- Rychlý lokální grading s pending/live/support/detail a správnou prioritou.
- Transakční persistence a jeden historicky vysvětlitelný pokus včetně oprav.
- Důkazy správnosti, reálné latence/náklady a nezávislé CR.
- Až při následném releasu ověřená produkce z main; samotný plán takovým důkazem není.
