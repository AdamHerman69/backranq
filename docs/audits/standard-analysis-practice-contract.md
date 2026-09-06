# Audit standardní analýzy: import, kanonický kontrakt a běžný Practice

Datum: 2026-09-05. Výchozí SHA: `873912414c5498fa1c94e575ed9847884cad190b`, detached HEAD, permanentní worktree `/Users/adam/.codex/worktrees/5790/backranq`. Při zahájení této větve auditu byl worktree čistý. Souběžné změny ostatních auditních větví nejsou součástí této zprávy. Dodržen `AGENTS.md` a `.agents/skills/backranq-orchestrator/SKILL.md`; pouze lokální dokumentace a izolované auditní testy, žádná produkční data, commity ani deployment.

Tato zpráva pokrývá kontrakt a runtime Practice. Šachové prahy/frontier a výkon engine mají vlastní paralelní zprávy. Nejde o živý produkční ani browserový E2E audit. Reprodukce používají skutečný extractor, API handler a persistence funkci s izolovaným fixture enginem nebo mockovanou transakcí.

## Nejdůležitější výsledky

| ID | Priorita / jistota | Závěr | Důsledek |
| --- | --- | --- | --- |
| PC-1 | P1, reprodukovaná chyba | Extractor emituje `configSnapshot.version=3`, browser persistence API vyžaduje `version=2`. | Dokončená browserová analýza se neuloží, včetně jejích Practice momentů. Platí pro jednotlivou hru i background manager. |
| PC-2 | P1, reprodukovaná chyba | Při reanalýze se změna engine skóre o 1 cp zamítá jako změna identity rozhodnutí. | Opakovaný/nový silnější výpočet stejné pozice může selhat před vytvořením nové solution revision; chyba je ve společném úložišti. |
| PC-3 | P2, reprodukovaná chyba | Browser API odvozuje příslušnost ply k barvě z pevné parity místo startovní FEN. | Korektní PGN začínající tahem černého je po odstranění PC-1 odmítnuto 400. |
| PC-4 | P2, reprodukovaná chyba | Extractor znovu parsuje startovní FEN užším regexem než `chess.js`. | Importem přijaté odsazené nebo malé `[fen]` vede k replay ze základního postavení a neúplné analýze. |
| PC-5 | P1 k vyjasnění kontraktu; ověřené chování | Běžný Practice důvěřuje uloženým tierům; mimo uzavřený accepted set odmítá bez engine přezkumu. | Negativní hranice extractoru je konečná. Existence dynamického graderu neznamená, že běžný Practice umí opravit falešné zamítnutí. |
| PC-6 | P2, ověřená ztráta kontraktu, dopad hypotéza | `positionKey` včetně historie se ukládá, ale z DTO vypadává; lookup používá pouze FEN + decisionIndex + tah. | Dvě větve se stejnou FEN a různou historií nelze v Practice jednoznačně rozlišit. Nebyl zde doložen reálný generovaný příklad nesprávného verdiktu. |

P1 zde neznamená bezpečnostní incident. PC-1 má velký funkční dopad na celou browserovou cestu; PC-2 je podmíněn skutečnou změnou skóre při reanalýze. Není doložena četnost PC-2 v produkci.

## Mapa toku a zachovávaných významů

1. **Import a perspektiva.** `src/lib/games/importedPgn.ts:112` parsuje každou partii přes `chess.js`, zachová původní PGN a oddělí canonical serialization pro duplicate identity. `resolveImportedGameSide` (`:182`) vyžaduje explicitní stranu nebo právě jednu shodu hráče. `src/lib/games/analysisProvenance.ts:21` a `:45` používají zmrazené importní `username/userSide` a znovu kontrolují shodu se jménem příslušné strany; aktuální profil uživatele nepřepisuje historickou perspektivu. `src/lib/services/gameImport.ts:157` a `:374` chrání konzistenci již importované perspektivy.
2. **PGN → decision.** Extractor načte verbose history (`src/lib/analysis/extractTrainingMoments.ts:2701`), řeší importní stranu (`:2721`), replayuje od startovní FEN (`:2735`). `decisionPly` je **index tahu v movetextu od nuly**, nikoli absolutní ply od začátku standardní partie. Správné určení uživatelova tahu používá side-to-move z replay FEN (`:2829–2837`); historie je `move.before` předchozích tahů (`:2839`). Setup PGN může začínat např. `37...`, přesto první rozhodnutí má index 0.
3. **Zdroj vs. měřená evidence.** Kandidát (`extractTrainingMoments.ts:2540–2563`) nese sourceGameId, hash přesného zdrojového PGN, provider/time, decisionPly, přesnou FEN včetně hodin, posledních 256 předchozích FEN, původní UCI a `originalDecision` skóre/loss. Solution nese vlastní potvrzené `scoreAtStart`, playedMoveScore, accepted set/frontier, policy, tree, jednotlivé assessmenty, verifier a metadata engine (`:2499–2525`). Scan skóre původního rozhodnutí a potvrzené solution skóre nejsou totožné fáze měření.
4. **Validace a persistence.** Browser route kontroluje owner, kvalitu/config hash, frozen perspective, zdrojový PGN a kompletní manifest (`src/app/api/games/[id]/analysis/route.ts:268–493`). `trainingMomentCandidatesMatchSource` (`src/lib/training/candidateValidation.ts:1079–1123`) porovnává přesný zdrojový tah/FEN/historii/hash a config hash. `sourcePgnPositionFens` (`src/lib/chess/pgn.ts:39`) správně používá parserem vzniklé `Move.before`, včetně clocks. Persistence vyžaduje kompletní manifest a odpovídající RUNNING AnalysisRun (`src/lib/training/persistence.ts:488–528`); až potom upsertuje momenty, appenduje/reuseuje revision a archivuje chybějící momenty (`:587–668`). Nedokončený scan tedy nesmí nahrazovat kompletní analýzu.
5. **Read a serializace.** Read vybere pouze ACTIVE, trainable, VERIFIED, STABLE (`src/lib/training/readService.ts:449–474`). Mapper ověřuje shodu best/accepted/frontier/tier a kompletní USER strom (`src/lib/training/apiMappers.ts:102–128`, `:157–209`). Kořenové `positionHistory`, originalMove, originalScoreAfter, policy, frontier, tree a verified assessments přecházejí do manifestu (`:136–146`). DB uchovává rozsáhlé solution evidence (`persistence.ts:333`); DTO záměrně nabízí grading evidence a přehled, ne celý verifier report. **To není samo o sobě důkaz ztráty potřebné evidence; konkrétní ztrátou identity je PC-6.**
6. **Zobrazení a tah.** `TrainingPromptDto` (`src/lib/training/api.ts:53–107`) obsahuje samotnou pozici a grading manifest. `src/lib/hooks/usePuzzleSession.ts:465–513` po legálním tahu nejprve volá known grader a teprve při `null` dynamický engine. Known grader nalezne assessment podle FEN/index/tahu (`localGrading.ts:76–89`), důvěřuje uloženému grade (`:203–214`) a pro neznámý tah v kompletním stromu vrací `DIFFERENT_MISTAKE` (`:169–192`). Původní tah je vždy `REPEATED_MISTAKE` (`:148–155`, `:203–208`), takže správný předpoklad generátoru musí být, že původní tah skutečně nepatří mezi kvalitní odpovědi.
7. **Pokračování a zápis pokusu.** `localContinuationForMove` (`localGrading.ts:609`) sleduje vybranou canonical odpověď soupeře a další USER uzel, ne náhodné soupeřovy varianty. Server replayuje legální tahy a role, znovu volá stejný known grader, porovnává grade a vyžaduje canonical soupeřovu odpověď (`src/lib/training/attemptService.ts:425–539`). Dynamicky hodnocené pokusy odmítá (`:493–500`). Server tak brání rozdílu klient/server u existujícího kontraktu, ale neověřuje šachovou správnost chybného frontiera nezávislým enginem.

## PC-1 — extractor a příjemce se neshodnou na verzi

**Důkaz:** extractor vytváří verzi 3 na `src/lib/analysis/extractTrainingMoments.ts:2653–2657`. Oba browser call sites odesílají přímo tento objekt: `src/lib/analysis/backgroundAnalysisManager.ts:678–686` a `src/components/games/GameActions.tsx:257–266`. API vrací false už na `value.version !== 2` (`src/app/api/games/[id]/analysis/route.ts:221`), následně 400 `Analysis quality does not match configSnapshot` (`:362–366`). Nezávisí to na nalezení momentu, konkrétní FEN ani ratingu.

**Reprodukce:** `tests/api/standard-analysis-setup-audit.test.ts` zavolá skutečný extractor se standardními preferences, potom skutečný PUT handler se skutečnými `analysis`, manifest, configSnapshot a hash. Výsledek je uvedená 400; data jsou izolovaná přes route mocks. Nejde o HTTP/browser E2E měření, ale exercise stejného producer→consumer kontraktu. Existující API testy mají ručně vytvořené `version: 2` (`tests/api/games-analysis-route.test.ts:46`), proto chybu nezachytí.

**Server odlišení:** `src/lib/services/serverAnalysis.ts:179` vloží enqueue run.configHash; completion (`:219`) jde přímo přes společnou persistence službu, ne browser PUT. Server si vytváří vlastní v2 enqueue envelope (`src/lib/services/analysisJobs.ts:711`). PC-1 proto nelze rozšířit na tvrzení, že nefunguje veškerá backend analýza.

**Návrh:** jeden typ/validator/hash constructor pro obsah analýzy a explicitně oddělený execution envelope pro browser/server. Čistý aktuální kontrakt, žádné přidání tolerantní legacy větve `2 || 3`. Akceptační test musí používat skutečný producer output.

## PC-2 — měření je chybně součástí neměnnosti rozhodnutí

Kanonický moment key je source game + source PGN hash + decisionPly (`src/lib/training/contractHashes.server.ts:19–35`). Naopak `persistence.ts:558–580` vyžaduje rovnost i `scoreBefore`/`scoreAfter` mezi existujícím momentem a aktuálním výpočtem. Jde o měřené engine hodnoty: extractor je přenáší z aktuálních evaluations (`extractTrainingMoments.ts:2555–2557`), nikoli neměnný fakt z PGN. Nová solution revision se vytváří až později (`persistence.ts:623`).

**Reprodukce:** `tests/lib/standard-analysis-contract-audit.test.ts` používá izolovanou mock transakci a legální zdrojovou PGN `1. d4`, počáteční FEN, původní `d2d4`, alternativu `e2e4` a minimální legální strom. Legalita a původ FEN se v testu explicitně kontrolují. Stejný source hash, ply, FEN, historie, strana a původní tah; scan před tahem a odpovídající solution score se změní 80→81 cp. Recomputed solution hash je validní. Persistence vyhodí `Stored training moment does not match its canonical identity`; nevytvoří revision ani neupsertuje moment. Fixture není určena k měření šachové kvality, pouze k testu data contractu.

Navíc create ukládá cpLoss/winChanceLoss/confidence/phase (`persistence.ts:600–605`), update je neaktualizuje (`:612–619`). Pokud se změní pouze WDL/loss nebo confidence při stejných scores, zůstává stará evidence v momentu. Tento sekundární důsledek je doložen staticky; samostatný DB běh zde nebyl spuštěn.

**Návrh:** immutable `SourceDecision` obsahuje jen zdrojové skutečnosti. Scan a potvrzené původní/best výsledky, loss, confidence, engine/profil a provenance patří do `DecisionAssessmentRevision`; solution/attempt odkazuje na konkrétní revision. Nový výpočet nesmí vyžadovat numerickou rovnost s minulým výpočtem. Nedoporučuji pouze odstranit guard a potichu přepsat historické významy pokusů.

## PC-3 a PC-4 — setup PGN a správný decision ply

**PC-3:** API `expectedDecisionParity` (`src/app/api/games/[id]/analysis/route.ts:439–445`) je 0 pro White a 1 pro Black. V PGN s black-start FEN je to naopak. Auditní PGN začíná `37... Nf6 38. Nc3`, source side Black. Extractor vrátí complete manifest a správný black receipt `ply: 0`. K izolaci druhé chyby test nahradí **pouze testovací config envelope verzi** za API přijímanou v2 a přepočítá hash; teprve pak dostane 400 `Analysis perspective does not match stored game`. Toto není návrh compatibility opravy. Správná validace má určit barvu pomocí `sourcePgnPositionFens[ply]` nebo `Move.color`, stejně jako extractor.

**PC-4:** `chess.js` přijme `[FEN ...]`, ` [FEN ...]` i `[fen ...]` při `strict: false` a verbose history v testu má správnou startovní FEN. `extractStartFenFromPgn` uvnitř extractoru má ale regex `^\[FEN...` bez odsazení/case-insensitivity (`extractTrainingMoments.ts:316–319`), takže pro další dvě varianty replayuje standardní počáteční pozici (`:2735–2741`). Test vrací `SOURCE_REPLAY_STOPPED`, incomplete manifest. To je parser/orchestration bug, ne slabina Stockfishe. Řešení: startovat z parserem ověřené `movesVerbose[0].before` / parser headers; nesnažit se dodatečně rozšiřovat vlastní PGN regex.

## PC-5 — co běžný Practice skutečně ověřuje

Všechny canonical USER uzly musí mít `alternativesComplete=true` (mapper `:166`), jinak se prompt vůbec nevydá. Proto `gradeKnownLocalMove` pro libovolný legální tah buď nalezne uložené hodnocení/původní tah, nebo vrátí konečné odmítnutí mimo set. Jeho `null` větev, která by spustila `gradeUnknownLocalMove`, není pro validní běžný prompt dosažitelná. Stejný session hook slouží i jiným puzzle kontextům; nelze tedy globálně smazat dynamický grader jako „mrtvý kód“.

Dynamický grader má párované root/submitted 70k a 140k nodes (`localGrading.ts:24–26`, `:463–485`), explicitní terminální výsledky a stability test. V běžném Practice to ale není opravný přezkum frontier hranice. Ani server tuto cestu nepřijímá: `attemptService.ts:493–500` zamítne DYNAMIC.

**Sporná produktová volba:** uzavřený accepted set je legitimní požadavek na offline známé odpovědi. Sám o sobě neznamená, že každý tah za hranicí zaslouží konkrétní nálepku „different mistake“. U nepředpočítaného zlepšení lze v tomto kontraktu prokázat nanejvýš nečlenství v accepted set, nikoli velikost loss/recovery. Běžný Practice proto fakticky obvykle nemůže nabídnout jemné `IMPROVED` pro takový tah, přesto má tuto kategorii UI (`src/lib/training/trainerState.ts:76–90`). Je třeba zvolit, zda je cílem uzavřený puzzle, praktický osobní trénink, nebo oba produkty s explicitně rozdílnými požadavky na pokrytí.

**Konflikt pravidel:** known grader používá `assessment.grade` bez vyhodnocení `preservesOutcome` či prahů (`localGrading.ts:203–214`). Assessment grade generátor bere primárně z cp frontiera (`extractTrainingMoments.ts:1988–1999`), zatímco uložená evidence může obsahovat jiný outcome (`:2001–2009`). Candidate validator kontroluje `preservesOutcome` pouze jako boolean/null (`candidateValidation.ts:630–633`), nikoli jako podmínku GOOD; nemá semantic grader check. Samostatný `gradeTrainingMove` používá preserveOutcome a preferuje chance loss (`src/lib/training/grader.ts:45–50`, `:138–160`). Paralelní šachová zpráva/testy dokládají konkrétní rozpor cp frontier vs chance/outcome. Správným řešením není v Practice slepě přepočítat stored grade novými pravidly; generator, validator a runtime potřebují stejnou explicitní assessment policy/revision.

## PC-6 — ztráta historie assessmentu při serializaci

Extractor vytvoří pro každý assessment `assessmentPositionKey(node.fen, positionHistory)` (`extractTrainingMoments.ts:1976–1982`). Key obsahuje prvních pět FEN polí a fingerprint bounded historie (`src/lib/training/assessmentIdentity.ts:49–53`). DB uniqueness rozlišuje revision + decisionIndex + positionKey + move (`prisma/schema.prisma:1269`).

Read selection ale `positionKey` nevybírá (`src/lib/training/readService.ts:275–283`), DTO jej nemá (`src/lib/training/api.ts:81–89`) a known lookup vezme první shodu FEN/index/move (`localGrading.ts:76–89`). Ani USER node nemá path identity. Browser candidate validator už předtím indexuje strom jen přes FEN/index (`candidateValidation.ts:361–364`, `:487–505`): druhá transponovaná větev přepíše key první a assessmenty první větve pak mohou být odmítnuty (`:565–572`). To je další projev stejného zúžení identity; bez konkrétního fixture nelze slibovat, že chybná větev vůbec dospěje až do UI. Pro dvě transponované větve v témže decisionIndex může existovat stejná plná FEN a jiná předchozí historie, tedy různá repetition evidence. Index a FEN nejsou úplnou náhradou původního klíče.

**Jistota:** ztráta rozlišovacího údaje je ověřená; špatně ohodnocená reálná generovaná větvená pozice v tomto auditu doložena nebyla. Ověřit cíleným fixture stromem se stejnou FEN/ply na dvou paths a rozdílnou historií, poté reálnou opakovací pozicí. Cílový prompt má nést `decisionContextId` na uzlu i assessmentu a runtime jej musí používat. Pouhé přidání key do payloadu bez změny lookup nestačí.

## Cache, stale revize a retry

- Prompt/feed requesty používají `cache: no-store` a ověřují owner (`src/lib/training/client.ts:57–64`, `:115`, `:133`). Není zde doloženo přimíchávání feedu jiné identity.
- Offline outbox je per owner (`src/lib/training/offlineQueue.ts:57–58`), zapisuje se před I/O (`src/lib/hooks/usePracticeFeed.ts:1114`). Flush má merge ochranu proti nově přidaným záznamům (`offlineQueue.ts:168–176`).
- Server porovnává `solutionRevisionId` s aktuální revision a vrací `STALE_REVISION` 409 (`attemptService.ts:674–683`). `clientAttemptId` plus payload hash zajišťuje idempotenci (`:603–625`, `:639–655`). Neověřená nebo změněná revision se nepřehodnotí mlčky.
- 409 se v outbox klasifikuje jako NEEDS_ATTENTION (`offlineQueue.ts:117–132`). Produktová otázka: má být offline pokus proti stále existující, ale už neaktuální immutable revision uchován jako historický? Nyní se nepřijme. Není to bez dalšího bug a není oprávnění obejít stale guard.
- Po opravě PC-2 je potřeba tento stale/offline případ testovat, protože reanalýzy skutečně začnou vytvářet nové revisions. Runtime/engine checkpoint audit je v samostatné zprávě.

## Čistý cílový kontrakt a pořadí práce

1. **Opravit blokující producer→consumer handoff PC-1.** Společný current config schema/validator/hash; browser a server mají vlastní provozní budgets/envelope, explicitně zaznamenají scan scope `FULL_GAME | TARGETED_DECISION | SCOUT`. Full completion jediný smí nahradit kompletní uloženou analýzu.
2. **Oddělit source identity od měření (PC-2).** `SourceDecision {gameId, sourcePgnHash, decisionPly, fen, history/context, trainingSide, playedMove}`; vedle `DecisionAssessmentRevision {engine identity, budgets, actual evidence, best, played, cpLoss, expectedScoreLoss, verdict, stability}`. Termín win chance pro `win+draw/2` zpřesnit na expected score, pokud to odpovídá zvolené metrice.
3. **Jeden canonical decision parser a context identity (PC-3/4/6).** Parse PGN právě jednou; stejný původ FEN/ply/history pro extractor, server validator, prompt a assessment lookup. Setup s černým a opakování musí projít roundtripem.
4. **Oddělit tři otázky:** existuje chyba/promarněná příležitost; je její hodnocení dostatečně doložené; je užitečným cvičením. Nezahazovat auditní důkaz chyby pouze proto, že není k dispozici uzavřený puzzle strom. Evidence status a exercise eligibility jsou oddělené výsledky.
5. **Sjednotit grading semantics před změnou filtrů.** `MoveAssessment {contextId, uci, score, matched comparison, evidence status, tier, policyId}`. Přijaté odpovědi jsou výsledkem téže funkce jako runtime, nebo musí být výslovně pojmenováno a zdůvodněno odlišné membership pravidlo. `Unknown` není automaticky synonymem „jiná chyba“. Homepage může hledat jen první vhodnou pozici s menším rozpočtem, ale nesmí vydávat scout evidence za full nebo změnit význam BEST/GOOD.
6. **Až potom produktově rozhodnout o otevřených pozicích.** Bez tohoto rozhodnutí nelze doporučit jen zvýšení limitu MultiPV či uvolnění všech hranic jako „opravu kvality“. Varianty: osobní single-decision cvičení se spolehlivým graded root; offline closed-set puzzle; online unknown-move verification. Každá má explicitní eligibility a chování při nedostatku evidence.

## Reprodukce a testovací mezery

Spuštěno:

```sh
pnpm test tests/lib/standard-analysis-contract-audit.test.ts tests/api/standard-analysis-setup-audit.test.ts
pnpm test tests/api/games-analysis-route.test.ts tests/lib/imported-pgn.test.ts tests/lib/game-import.test.ts tests/lib/training-persistence.test.ts tests/lib/training-api.test.ts tests/lib/training-contracts.test.ts tests/lib/training-local-grading.test.ts tests/lib/training-attempt-service.test.ts tests/lib/training-offline-queue.test.ts tests/lib/standard-analysis-contract-audit.test.ts tests/api/standard-analysis-setup-audit.test.ts
pnpm exec eslint tests/lib/standard-analysis-contract-audit.test.ts tests/api/standard-analysis-setup-audit.test.ts
```

Po nezávislé kontrole byl persistence fixture zpřesněn na legální tahy a skutečný hash PGN; jeho samostatný rerun a ESLint znovu passed. Výsledky: cílené auditní testy **4/4 passed**; širší relevantní sada **101/101 passed** v 11 souborech (2.99 s wall-clock Vitest); ESLint passed. Auditní testy jsou **pozorovací**: jejich zelená znamená reprodukci aktuální chyby, ne splnění budoucího správného chování. První iterace route testu očekávala parity error a skončila na dřívějším PC-1; následná verze obě chyby izoluje.

Před implementací přijmout skutečné regresní/akceptační testy:

- skutečný extractor output → browser PUT → izolovaná DB → Practice prompt → pokus, White i Black, nula i více nalezených momentů;
- dvakrát stejný PGN, měřené scores o 1 cp i výrazně jiné; stable source identity a nová immutable assessment revision bez ztráty historických pokusů;
- canonical i parserem přijaté varianty setup headerů; black-start FEN, fullmove 37; přesná FEN/clocks/history a decision index po roundtripu;
- shodný MoveAssessment → shodný grade při generování, read DTO, známém tahu v UI a server canonicalization; WDL/cp/preserveOutcome konflikty a mate/tablebase;
- případy mimo accepted set: dobrý tah, zlepšení oproti partii, skutečná chyba a nestabilní evidence; očekávání určit produktovým kontraktem, ne aktuální implementací;
- dvě cesty do stejné FEN se stejným decisionIndex, ale různou repetition historií; DTO nesmí ztratit rozlišení;
- offline attempt během reanalýzy/revision change s výslovně určeným historickým výsledkem.

V této větvi nebyl spuštěn skutečný browser, připojena DB, upraven sdílený modul ani vytvořen umělý claim o kompletním E2E ověření. Typecheck/broad build náleží koordinátorovi integrovaného auditu; zde se netvrdí, že proběhly.


## Nezávislá kontrola auditní instrumentace

Na žádost koordinátora byly read-only zkontrolovány `scripts/extraction-quality-audit.ts`, `scripts/summarize-extraction-audit.mjs` a integration diff `scripts/extraction-quality-lab.ts`. První review požadovalo změny:

- zaznamenat extraction wall-time před JSON serializací, synchronním zápisem a git/provenance lookup; původní pořadí `audit.write` → elapsed tyto náklady započítávalo;
- přejmenovat „solution-opponent-continuation“, protože ne-kořenové MultiPV zahrnuje i další USER rozhodnutí;
- sloupec „Confirmed cp loss“ přejmenovat na original-decision cp loss, protože čte právě `moment.originalDecision.cpLoss`;
- zabránit smíchání různých SHA/corpus/run při porovnání product/reference souborů.

Koordinátor tyto změny zapracoval a opětovná inspekce diffu je pro nynější **sekvenční lokální lab běh clean**: elapsed je zachycen před writerem; raw total před provenance I/O; sloupec a fáze jsou pojmenovány přesněji; vzniká auditRunId a oddělený adresář dalšího běhu; summarizer hlídá shodu head/corpus/run. Ověřen byl i malý vzorek skutečných uložených caller stacks (308 calls jedné product partie): `confirmCandidate`, `evaluatePlayedMoveLoss` a `build` se v tomto bundlu identifikují, takže nejde pouze o předpoklad názvů funkcí. Žádný další engine benchmark během této kontroly neběžel.

**Hranice interpretace:** už rozběhnutý původní bundle používá staré měření wall-time; jeho report musí výslovně uvést writer overhead. Žádný opravný odhad zpětně neodečítat bez měření. `reportedNodes` je maximum hlášené UCI hodnoty jedné search, nikoli součet MultiPV slots ani přesný odečet při zastavení. Opakovaný stejný request není automaticky zbytečný: může být potvrzení, hash/history závislost či cache hit. Fázové rozdělení podle stacků je diagnostické, ne stabilní produkční telemetry contract. `activeCall` předpokládá sériové volání stejného wrapperu, které odpovídá současnému extractoru; při budoucím paralelním klientovi by vyžadovalo explicitní request IDs. Corpus hash identifikuje aktuální verzovaný corpus, nikoli automaticky každý případný budoucí alternativní zdroj.
