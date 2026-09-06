# Audit standardní analýzy: runtime, parita a výkon

Dokument zachovává původní audit před implementací. Aktuální stav a závěrečné
ověření jsou v oddílu „Finální plná browser/server parita po implementaci“:
20 momentů, všech 366 search výsledků a všech 20 solution hashes přesně
shodných mezi runtime; všech 40 skutečných výstupů prošlo předáním do Practice.

Auditovaná revize: `873912414c5498fa1c94e575ed9847884cad190b`, detached HEAD v permanentním `/Users/adam/.codex/worktrees/5790/backranq`. Při prvním čtení čisté. Ostatní auditní soubory vznikají souběžně; tato větev auditu mění pouze tento dokument, `scripts/audit-runtime-parity.mjs`, `scripts/audit-browser-extraction.mjs` a `tests/lib/audit-runtime-parity.test.ts`. Žádná produkční data, import z providerů ani deployment. Pokyny AGENTS a backranq-orchestrator přečteny; tato samostatná auditní část běží v solo režimu.

Odkazy na řádky produkčního kódu platí pro uvedenou revizi. Lab mezitím dostává oddělenou auditní instrumentaci od koordinátora; tvrzení o původních možnostech labu se vztahují k `git show 8739124:scripts/extraction-quality-lab.ts`.

## Zjištění podle dopadu a jistoty

| Priorita | Druh | Závěr a evidence | Praktický dopad |
|---|---|---|---|
| P1/P2 | Ověřená chyba browser orchestrace snapshotů | Browser bridge vybere nejhlubší bucket jen podle počtu slotů (`backranq-engine.worker.js:256–269`); skutečný cold search úvodní šachové pozice 100k/MultiPV 5 vrátil depth 10 s duplicitním `e2e3` ve slotech 3 a 5. Server ve stejné pozici vybral validní depth 9, protože kontroluje strukturální úplnost už při výběru (`serverStockfishClient.ts:625–641`). | Browser zahodí dřívější použitelný exact bundle a vrací incomplete duplicate-root výsledek. Navíc jej cachuje. Následná shared validace správně odmítá chybný bundle, ale browser zbytečně ztrácí existující důkaz; nejde o problém samotné šachové pozice. Skutečný dopad na počet osobních trainable momentů není z tohoto samotného úvodního FEN určen. |
| P2 | Ověřená chyba kontraktu adapterů | `isStructurallyCompleteMultiPvBundle` vrací true pouze při přesném počtu požadovaných řádků (`stockfishClient.ts:127–155`). Browser použije helper na výstup (`:656`); server na výběr kompletního depth bucketu (`serverStockfishClient.ts:625–672`). `acceptanceFrontier.ts:167–169` ale uzná vyčerpání legálních tahů pouze při `alternativesComplete===true` **a menším** počtu řádků. | Větev „všechny legální tahy byly prozkoumány“ je přes skutečné adaptery nedosažitelná. Pozice se 2 legálními tahy a požadavkem MultiPV 5 zůstane bez této možnosti uzavření. Pokud jsou všechny legální kořenové tahy přijatelné, je přijatelný i původně hraný tah a osobní mistake exercise správně nevznikne. Oprava důkazu tedy sama nezaručuje zvýšení užitečného recall; význam roste v delších continuations. |
| P1/P2 | Ověřená rozdílnost důkazů; dopad na konkrétní hranice se měří | Browser cache vrací stejný výsledek pro stejný FEN, nodes/depth/time, MultiPV a roots (`stockfishClient.ts:364–368,428–434`); server každý požadavek znovu spouští (`serverStockfishClient.ts:231–243`). | Není pravda, že stejné profily vždy vykonají stejné potvrzení nebo mají stejný výpočetní rozpočet. Candidate confirmation 200k/MultiPV 5 (`extractTrainingMoments.ts:1508`) může být později vrácena z browser cache pro potvrzení frontier na 200k/MultiPV 5 (`continuationVerifier.ts:984–989`), zatímco server udělá další warm-hash search. Dva odlišné budgety stále poskytují dva výsledky; **cache hit sám není důkaz nesprávného tahu ani automaticky zbytečného potvrzení**. Potřebujeme explicitní význam reuse versus fresh confirmation. |
| P2 | Ověřená rozdílnost runtime chyb | Browser přijme `done` s prázdnými exact lines jako úspěšný `score:null,pv:[]` a cachuje ho (`stockfishClient.ts:624–637,399–400`). Server odmítne bez exact PV (`serverStockfishClient.ts:642–645`), s úzkou výjimkou pravidlově dokázaného matu prvním tahem (`:47–78`). | Stejný UCI průběh může v browseru pokračovat neúplnou extrakcí, na serveru skončit chybou/retry. Terminální kořen nemá být maskován jako běžné selhání PV; musí mít samostatný pravidlový výsledek. |
| P2 | Ověřená chyba API životního cyklu; produkční dopad neprokázán | Server kontroluje cancellation generation před vstupem do `runAnalysis` (`:234–239`), ale po await startup/readiness už pouze AbortSignal (`:363–413`). `cancelAll()` v době čekání na runtime, kdy `active===null`, generaci zvýší a vrátí se (`:246–250`). | Rozpracovaný požadavek může po cancelAll stále odeslat `go` a úspěšně se dokončit. Izolovaný mock to reprodukuje. Standardní job služba nevystavuje tuto přesnou cestu uživatelskému cancel tlačítku; není doložená chybná produkční persistence. |
| P2 | Ověřená mezera původního benchmarku | Původní `CountingEngine` zaznamenává volání a **požadované** nodes (`scripts/extraction-quality-lab.ts:308–343`), pouze celkové per-game wall time (`:375–408`). Nepředává tablebase (`:383–398`), přestože browser i server v produktu ano. | Původní čísla nejsou skutečné nodes, čisté engine time, phase breakdown ani browser baseline; výsledky pro endgame nejsou plná produkční parita. Novou instrumentaci a měření uvádí hlavní audit. |
| P3 | Ověřený zastaralý text dokumentace | Lab docs ř.65–68 popisují 800k jako produkční cap a 1.6m jako kandidáta; `quality.ts:17,23–41` už má default THOROUGH s 1.6m, STANDARD s 800k. | `full` stále odpovídá STANDARD budgetům, nikoli implicitnímu defaultu uživatele. Starší experiment nelze interpretovat jako nasazení nové quality politiky. |

## Co je skutečně společné

Obě produkční cesty sdílí `analysisDefaultsToExtractOptions` (`preferences.ts:343–367`) a `extractTrainingMomentsFromGames`; nikoli dvě nezávislé implementace detekce. Browser volá extractor v `backgroundAnalysisManager.ts:636–649`; server v `services/serverAnalysis.ts:171–185`. STANDARD a THOROUGH mají shodný scan 100k, první confirmation 200k, verification 100k; liší se maximem adaptive confirmation 800k/1.6m. Verifier následně potvrzuje kořen na dvojnásobku verification budgetu (`continuationVerifier.ts:231–241`). STANDARD není „levnější engine“.

Základ je shodný npm `stockfish@18.0.8`, `stockfish-18-lite-single.js/.wasm`, Threads 1, Hash 64 MiB, UCI_ShowWDL true. Server child process importuje tento soubor (`serverStockfishProcess.mjs:1`) a dostává explicitní WASM cestu (`serverStockfishRuntime.ts:11–17,40–47`). Browser bridge používá nested Worker a stejný artefakt (`public/vendor/stockfish/backranq-engine.worker.js:28–42`); Hash/Threads/WDL nastaví při startupu (`:167–175`). `next.config.ts` obsahuje výslovný tracing engine souborů a externí `stockfish`; izolace chrání Next/Queue proces před Emscripten globálními efekty.

Oba parsery odmítají lowerbound/upperbound jako exact score (`serverStockfishClient.ts:118–126`, browser bridge `:206–221`). Browser vybírá nejhlubší bucket s požadovaným počtem slotů; server vybírá nejhlubší **strukturálně validní** kompletní bucket (`server:625–641`, bridge `:256–269`). Browser strukturálně kontroluje až vybraný bucket. Rozdíl se skutečně reprodukoval na úvodní pozici: v rámci jednoho depth Stockfish aktualizoval slot 5, takže Map držela dva výskyty stejného root tahu. Nejde o důkaz chybného legálního tahu generovaného Stockfishem; skládání jeho průběžných zpráv vytvořilo chybný společný snapshot.

Obě cesty posílají `position fen`, nikoli celou historii tahů (server `:448`, bridge `:403`). UCI engine tedy nezná historii před zadaným FEN; uchovaná hash tabulka není historie pravidel. Extractor a continuation verifier mají vlastní sledování opakování a pravidlové draw zásahy. Pravidlovou správnost těchto zásahů řeší šachová část auditu; nelze předpokládat, že ji za nás automaticky zajistí engine.

## Výkon a cache: nejprve význam, potom optimalizace

| Fáze | Aktuální chování | Co musí měření oddělit |
|---|---|---|
| Download/startup | Browser vnější+nested Worker, JS/WASM síť nebo HTTP/SW cache. Server spawn Node a lokální WASM. | Download bytes/cache, kompilace WASM, UCI handshake; `getIdentity()` browseru může odpovědět na `uciok` před dokončením readiness (`bridge:130–132`), server čeká plnou readiness (`serverStockfishClient.ts:201–206,303`). |
| Scan | Na každý ply eval před a po tahu (`extractTrainingMoments.ts:2857–2866,2918–2931`). Výsledek po tahu je při dalším ply znovu požadován. | Browser obvykle cache hit; server znovu prohledává s warm hash. Je to příležitost pro sdílené explicitní reuse scan evidence; neopravovat naslepo veškeré opakované cally. |
| Candidate confirmation | Více before/after/root hledání na 200k, pak případně 400k/800k/1.6m (`:1496–1555,1663–1733`). Precomputed MultiPV se předává do accepted-move výpočtu (`:2195,2203–2210`). | Request count versus fyzická hledání; rozdílné budgety; rozpor loss a změna best move; vztah k už existujícímu důkazu. |
| Verifikace/continuation | MultiPV 5 → 10 → 16 na uživatelských uzlech, soupeř MultiPV 1; stable frontier se potvrzuje na 2× budgetu (`continuationVerifier.ts:905–989`). Standard extractor používá max 2 plies, max 32 positions (`extractTrainingMoments.ts:1156–1164`). | MultiPV budget je limit celého hledání, nikoli nodes na každý alternativní tah. Širší MultiPV pod stejným node limitem snižuje práci dostupnou jednotlivým alternativám. |
| Opakovaná příčina stejného momentu | Extractor deduplikuje continuation verification přes sourcePgnHash+decisionPly+FEN v lokální Promise mapě (`:2295–2336`). | Užitečné sdílení výsledku pro tentýž kanonický decision ply, nikoli z principu chyba nebo chybějící potvrzení. |
| Tablebase | ≤7 figur, TTL 30min, negative TTL 15 s, 2k LRU, 600 ms mezi požadavky, 5 s timeout (`tablebase.ts:241–259`). | Síťové čekání/cache oddělit od engine; výpadek je chybějící důkaz, ne automaticky DRAW. |
| Předání | Browser čeká game GET a save PUT, server čte job/checkpoint a provádí transakční dokončení/settlement. | Per-game extraction wall time nezahrnuje plný import/persistence/queue/user-visible čas. Kritickou browser v3/v2 save chybu reprodukuje kontraktová část auditu. |

Engine session zachovává transposition table přes úspěšná hledání v obou cestách (`serverStockfishClient.ts:298–304,399–410`, bridge `:393–401`). Po cancel/timeout je nový `ucinewgame` nebo nový runtime. Browser jedna engine instance přežívá celý batch (`backgroundAnalysisManager.ts:198–208,560–562`); server nový client pro každý game job a každý checkpoint slice (`serverAnalysis.ts:106,353`). Browser má navíc neomezené Map cache do terminate; server cache výsledků nemá. Warm historie a pořadí pozic jsou proto součástí experimentálních podmínek. Stejný node limit nezaručuje stejný výsledek po odlišné sekvenci hledání.

SW/HTTP cache je samostatná od eval cache. Browser metadata verzují všechny tři runtime URL a cache jméno (`stockfishMetadata.ts`); bridge má shodnou revizi v JS i WASM požadavku. `stockfishOfflineCache.ts:37–40` připravuje engine až po otevření Coach, aby obecná návštěva nepřenášela cca 7 MiB. Tato cesta není automaticky startup plné browser analýzy. Po změně runtime verze testy kontrolují koherenci URL/revize; žádný živý offline/browser reload audit celého produktu zde neproběhl.

## Cancel, retry a checkpoint

Browser manager má run generation i owner fencing a po změně identity či cancelu zahodí frontu, zavolá cancelAll+terminate a kontroluje vlastnictví po await (`backgroundAnalysisManager.ts:221–280,623–651,666–706`). Rozpracovanou hru necheckpointuje; po opětovném spuštění začne od začátku, již úspěšně uložené hry jsou samostatné výsledky. Tab close také ztratí rozpracovaný výpočet. Při selhání načtení preferencí manager použije defaulty a v tom catch může ztratit explicitní batch override (`:448–472`); samotný nesprávný provider response/race zde nebyl dynamicky reprodukován.

Server checkpoint je bezpečný bod mezi plies, po 180 s (`serverAnalysis.ts:45–46,170–184`, extractor `:2792–2819`). Ukládá ply cursor, dosavadní moments/analysis/receipts, source PGN hash, canonical source a config hash; replay znovu ověřuje source a konfiguraci (`:2670–2699,2744–2782`). Neukládá engine hash ani browser result cache. Semantická kontinuita zdroje je chráněna; bitově shodné evals po resume nejsou zaručeny. Celý rozpracovaný ply se musí dokončit před yield. Jeden složitý ply tedy může překročit 180 s a slice budget není tvrdý wall deadline; route má maxDuration300 (`app/api/queues/backranq-jobs/route.ts:11`). Praktický overrun nebyl naměřen.

Server drží frontu požadavků přes Promise chain; browser při konkurenčním startu superseduje active a dříve queued požadavky (`bridge:428–452`). Sdílený extractor je sekvenční, takže tato odlišnost sama nevysvětluje jeho běžné ztráty. Prohlásit rozhraní za obecně zaměnitelné pro paralelní volání by ale bylo chybné.

Server chyby runtime resetují process a waitery; stop watchdog čeká 2 s (`serverStockfishClient.ts:481–538`). Browser force-stop čeká 600 ms a zahodí nested Worker, aby starý bestmove nedokončil nový job (`bridge:293–328`). Raw worker crash po startupu pouze odešle error aktuálnímu jobu (`bridge:141–158`); explicitní reset enginePromise/activeJob v této větvi chybí. Následující požadavek může spustit recovery přes supersede watchdog; jde o kódem podložené riziko odlišného zotavení, ne důkaz trvalého zamrznutí produktu.

## Cílová hranice a akceptační ověření

1. Společný engine evidence adapter má vracet `terminalOutcome`, `exactLines`, `requestedRootCount`, `legalRootCount`, `returnedRootCount`, explicitní completeness, bestmove a identitu konkrétního hledání. `legalRootCount` se odvozuje z kanonického FEN; exact/mate/tablebase/rule důkazy se nemaskují jako cp.
2. Každý search request má důvod (`SCAN`, `LOSS_CONFIRM`, `FRONTIER`, `FRONTIER_CONFIRM`, `CONTINUATION`, `RUNTIME_GRADE`) a politiku reuse/fresh. Cache reuse vrací odkaz na původní evidence ID; netváří se jako nově vykonané potvrzení. Bez experimentu není důvod rušit užitečnou deduplikaci scanu nebo tvrdit, že cold-hash je jediná správná nezávislost.
3. Společná pravidla vyhodnocují loss, accepted moves a nejistotu z těchto důkazů. Orchestrace browser batch/server slices/homepage scout má vlastní limity, životnost a coverage manifest. Rychlý scout nesmí emitovat „complete standard analysis“.
4. Regrese: úplný seznam dvou legálních odpovědí pod MultiPV 5; terminal mate/stalemate bez PV; browser/server stejná skriptovaná UCI sekvence; cache hit označen jako reuse; fresh confirmation skutečně vyvolá druhé go; cancel během factory/UCI/ready/go vždy zabrání pozdějšímu úspěchu; resume zachová jediné receipt na každý user decision a správnou semantiku i s cold hash.
5. Výkonnostní akceptace: zopakovat totožný malý corpus s explicitní quality/tolerancí, cold/warm, fixed ordering a obráceným pořadím; měřit skutečná fyzická volání i reuse, UCI nodes (cumulative maximum per search, nikoli součet MultiPV řádků), startup, tablebase a persistence zvlášť. Referenční silnější Stockfish zůstává komparátorem.

## Lokální důkazy a stav ověření

`pnpm exec vitest run tests/lib/audit-runtime-parity.test.ts tests/lib/stockfish-client.test.ts tests/lib/analysis-quality.test.ts tests/lib/browser-game-analysis-run.test.ts tests/lib/background-analysis-lazy-failure.test.ts`: **5 souborů, 17 testů prošlo**, 2026-09-05, 1.44 s. Tři nové auditní testy dokazují stávající problematické chování; jejich zelený výsledek znamená úspěšnou reprodukci, nikoli opravený produkt. `node --check scripts/audit-runtime-parity.mjs` prošel. Žádný velký engine běh této části nesoupeří s lab baseline koordinátora.

Následné ověření: `pnpm exec vitest run tests/lib/server-stockfish-client.test.ts -t 'tears down|rejects an active|failed stop|poisoned|rule-exact|still rejects|partial MultiPV|reuses hash'`: **8 prošlo, 3 živé runtime testy záměrně přeskočeny**, 573 ms. Po přidání reprodukce skutečného duplicate-root bucketu `pnpm exec vitest run tests/lib/audit-runtime-parity.test.ts`: **4 prošly**, 383 ms. Focused eslint nových test/script souborů čistý.

### Skutečný browser/server experiment

`node scripts/audit-runtime-parity.mjs` dokončen úspěšně za 4.19 s. Prostředí: Apple M1 Pro, darwin 25.6.0 arm64, Node v24.16.0, Chromium 149.0.7827.55, revize 8739124. Plný lokální důkaz v [report.json](../../artifacts/extraction-quality-lab/runtime-parity/report.json). Žádná DB ani živý tablebase provider; lokální HTTP server servíruje přesné produkční engine assets. Každá pozice začíná novou engine instancí; HTTP cache browseru mezi pozicemi zůstává. Není to měření vzdálené sítě, mobile ani celého browser batchu.

| Pozice | Browser cold / cached / fresh warm ms | Server cold / warm / warm ms | Výsledek |
|---|---:|---:|---|
| Startovní FEN, 20 legálních,MultiPV 5 |152 /0 /114|111 /99 /97|Browser cold depth 10 duplicate `e2e3`, incomplete; server cold validní depth 9. Fresh warm browser i druhý server search validní depth 12, stejných 5 roots i skóre.|
| Golden mate root `7k/5Q2/6K1/8/8/8/8/8 w - - 0 1`, 26 legálních,MultiPV 5 |57 /0 /24|57 /27 /25|Cold bundle stejné 4 mate-in-one tahy plus mate-in-two. Pátá alternativa se při warm hledání změnila; vybraný depth 245 uvádí 32134 nodes.|
| `7k/8/5Q2/8/6K1/8/8/8 b - - 0 1`, 2 legální,MultiPV 5 |78 /0 /32|63 /34 /32|Oba vracejí přesně `h8g8`,`h8h7`, oba mate−4, oba neprokazují vyčerpání legálních alternativ (`alternativesComplete:false`).|
| Mat: `5Q1k/8/6K1/8/8/8/8/8 b - - 1 1` |20 /0 /1|2 /0 /1|Browser úspěšně vrací 0 lines, bestmove`(none)`; server vždy `ExactPvUnavailableError`.|
| Pat: `7k/5Q2/6K1/8/8/8/8/8 b - - 0 1` |18 /0 /1|2 /0 /0|Stejný rozdíl jako mat; pravidlově je výsledek DRAW, ne chybějící šachové poznání.|

Každý request používá 100k nodes; browser druhý request vrací cache a žádnou novou práci. Třetí request obchází memo přes explicitní unikátní cacheKey, zachovává však engine hash. Report uvádí 0 ms po zaokrouhlení, nikoli nulovou fyzikální latenci. Startup přes `getIdentity()` byl první browser 203 ms/server 339 ms, další pozice browser 144–157 ms/server 173–190 ms; browser handshake boundary je dřívější než server, proto je pro srovnání nutné přičíst první search a neinterpretovat samostatný údaj jako rozdíl celé inicializace.

Dokumentované `nodes` uvnitř jednotlivých returned lines jsou kumulativní hodnoty při dané zprávě, ne automaticky konečné nodes hledání: server cold úvodního FEN vrací depth 9 s42314 nodes, přesto požádal 100k a engine dokončoval novější depth. Pro přesné účetnictví je potřeba maximum všech UCI zpráv tohoto fyzického search; nesčítat nodes přes MultiPV řádky. Hlavní audit takové účetnictví přidává zvlášť.

### Plná extrakce stejných dvou her v browseru

`node scripts/audit-browser-extraction.mjs` dokončil oba plné PGN se STANDARD parametry, bez tablebase, DB nebo API save. Čerstvý engine na každou hru odpovídá server labu, **nikoli** běžnému browser batchi, kde stejná instance pokračuje mezi hrami. Browser HTTP cache zůstala teplá mezi hrami. Raw reports v [browser-extraction](../../artifacts/extraction-quality-lab/browser-extraction/summary.json) obsahují celé momenty/receipts, každý požadavek a oddělené fyzické `start` zprávy Workeru. Wrapper měří pouze asset requests k lokálnímu serveru a neroutuje žádnou produkční službu. `node --check` a focused eslint skriptu prošly.

| Hra / rozsah | Browser wall / server první wall | Browser method requests / fyzická hledání / cache hits | Fyzicky požadované browser nodes | Browser / server trainable decision plies |
|---|---:|---:|---:|---|
| Chess.com `0f8e42f0-8fda-11f1-b9f6-9dd41a01000f`, 94 plies |26.047 s /48.290 s|301 /195 /106|28.4M|46, 54, 76 /46, 54, 76|
| Lichess `bNDgiSuy`, 108 plies |35.449 s /83.624 s|315 /197 /118|32.8M|44 /44, 54|
| Celkem |61.496 s /cca 131.9 s|616 /392 /224|61.2M|4 /5|

Oba manifests jsou complete. Všechny 4 společné trainable momenty mají shodný bestmove i **přesně stejné accepted membership**, všechny singleton. Nejde pouze o shodu počtu. Receipt distributions se přesto liší: Chess.com browser SAVED 3 / below 37 / after-confirm-below 0 / unstable 7 versus server 3 /35 /1 /8; Lichess 1 /45 /1 /7 versus server 2 /44 /1 /7. Ambiguous candidate množiny a accepted alternatives se liší ještě více; např. Chess.com browser vytvoří ne-trainable ply 2, který v prvním server STANDARD není, zatímco server má navíc ne-trainable ply 66. Výsledek **není tvrzení, že browser je šachově lepší či horší**; jeho orchestrace vykonává jinou historii hledání i jinak vyhodnocuje snapshoty.

Doložené příčiny rozdílů:

- Browser opakuje 4 verifier confirmation požadavky 200k/MultiPV 5 z cache candidate confirmation, bez nového start; týká se právě všech 4 uložitelných momentů v tomto vzorku. Call stacky rozlišují `confirmCandidate` versus `build` na confirmation řádku. Scan 100k a candidate 200k jsou stále dva rozdílné důkazy; tvrdit čtyři chybné přijaté tahy by z toho neplynulo.
- Browser vrátil 7 MultiPV bundles s duplicitními roots (4 Chess.com, 3 Lichess), všechny zaznamenané v raw method výsledcích. Například Chess.com ply 8 na 100k/MultiPV 16 má opakované `d1f3` a `f1c4`; Lichess ply 54 confirmation 200k/MultiPV 16 má `e5d7` ve slotech 14 i 15. Toto je skutečná chyba sestavování snapshotů, ne pouhé přeřazení rovnocenných tahů opravované v 8739124.
- Lichess ply 54 (`2k5/pp2b3/2pq1p1p/3pN2R/3P4/P1P1P3/1P4K1/5R2 w - - 0 28`, hrané `e5f7`) má v server STANDARD VERIFIED accepted `{h5h6,e5g6,e5d3,e5g4,e5f3}`. Browser končí AMBIGUOUS/OPEN s `{h5h6,e5g6,e5d3}`, loss 166 cp/0.487 a původním tahem mimo set. Browser nejprve rozšíří 100k frontier na 16; confirmation 200k vrací zmíněnou duplicitu **i změněné accepted membership**. Diagnostics výslovně uvádějí obojí: `Accepted-move frontier changed during confirmation at ply 0`, `Duplicate MultiPV root move at ply 0`. Nelze tvrdit, že samotná oprava duplicate bucketu jistě zachrání tento moment; hranice se mění i šachovým hodnocením.

Časové srovnání má jeden běh browseru a první server baseline. Druhé stejné server STANDARD měření koordinátora mělo 105.091 s se shodnými solutionHashes a receipts, takže samotný rozdíl 131.9→105.1 s je přirozený rozdíl wall time prostředí při stabilních node výstupech. Browser61.496 s proto neprezentovat jako přesný univerzální speedup 2.15×. Startup browseru podle identity byl 205 ms a 149 ms; včetně prvního search přibližně 322 ms a 271 ms. Fyzické bridge snapshot nodes 61 237 398 jsou telemetrie od konečných bridge updates; mohou zaostat za úplným raw UCI součtem maxima. Požadované nodes 61.2M jsou přesná suma vydaných search budgetů, žádné přičítání za cache hity.

Změna maximální confirmation cap není izolace od ostatních výsledků celého game runu. Koordinátorův THOROUGH experiment se shodným 100k scan budgetem změnil i pozdější scan receipts a časnější candidate množinu, protože předchozí hledání změnila hash/history. Lze říci „jediná změněná konfigurace je cap“; nelze bez kontrolované evidence říci „změnily se pouze rozhodnutí v posledním confirmation passu“. Účelné další experimenty musí oddělit převzetí stejných uložených scan důkazů od nového přehrání celé game orchestrace.

Tento úspěšný browser **core extraction** benchmark neověřuje save/persistence ani Practice UI. Reálný browser save v aktuálním produktu zůstává blokovaný reprodukovaným config v3/v2 nesouladem popsaným v kontraktové části auditu.

Finální ověření této části: focused eslint všech tří nových test/script souborů čistý; opakovaný společný běh 5 vybraných testových souborů po poslední změně **18 testů prošlo** (520 ms). Poslední stav zachovává souběžnou práci dalších auditních částí; žádná změna produkčního TypeScriptu ani browser workeru není součástí tohoto návrhu.

## Implementační následné ověření — 2026-09-06

Předchozí oddíly jsou zachovaný audit původní revize; po následném výslovném
schválení implementace se runtime změnil. Browser i server nyní vyžadují
výslovné `REUSE_ALLOWED` pro cache; výchozí `FRESH_REQUIRED` provede nové
fyzické hledání. Oba mají stejný implicitní limit 100k nodes / MultiPV 1.
`SearchEvidence` uchovává ID, engine, přesný root scope, rekonstruovanou historii,
limit, účel, maximum hlášených nodes/time a reuse. Browser i server přijímají
validovaný allowlist všech legálních root tahů. Mat, pat a nedostatek materiálu
mají pravidlový výsledek bez UCI search. Platný starší unikátní snapshot přežije
novější neúplný či duplicitní bucket; úplnost zohledňuje skutečný počet legálních
tahů. Bounds zůstávají oddělené od exact lines. Cancel během server startupu
odmítne čekající požadavek a zabrání následnému `go`.

`BACKRANQ_RUNTIME_AUDIT_DIRECTORY=runtime-parity-fixed node
scripts/audit-runtime-parity.mjs` dokončil skutečný browser/server probe všech
pěti pozic. Po opravě oba vracejí validní počáteční snapshot, complete bundle
pro dvě legální odpovědi pod MultiPV 5 a explicitní mate/stalemate s nulovou
engine prací. Raw důkaz je v
[opraveném reportu](../../artifacts/extraction-quality-lab/runtime-parity-fixed/report.json).
Toto není opakovaný plný product quality benchmark ani ověření persistence.

Přesná canonical prefix cache omezuje opakovaný replay historie: na stejných
94/108-ply PGN klesl čistý čas validace postupných kontextů z 3 083/6 126 ms
na 153/239 ms. Toto izolované měření nezahrnuje engine. Nový přechod se stále
ověřuje jako legální; cache lze použít pouze pro shodný již ověřený prefix.

Samostatný `residualCoverage.ts` implementuje volitelný experiment nad fixním
seedem, nikoli výchozí extrakci. Hledá celé reziduum přes `searchmoves`, porovnává
novou referenci a reziduum ve dvou či více fresh párech a vrací pouze empirickou
CP mez s nejistotním odstupem. Nepřiřazuje WDL ani individuální grade. Per-move
UPPER bound lze použít jen u singleton rezidua; z dochované bound zprávy pro
jeden tah nelze odvodit maximum celého vícetahového scope. LOWER bound sám
pokrytí nepotvrzuje. Následný živý mikrobenchmark je uveden níže; cenový přínos
ani plošná převaha algoritmu prokázány nebyly.

Poslední focused běh: `pnpm exec vitest run tests/lib/residual-coverage.test.ts
tests/lib/audit-runtime-parity.test.ts tests/lib/server-stockfish-client.test.ts
tests/lib/stockfish-client.test.ts` — **33 testů ve 4 souborech prošlo**, 2.12 s.
Focused eslint runtime a nových testů prošel. Sdílený typecheck během souběžné
integrace hlásil chyby v rozpracovaném extractor/test-fixture kódu mimo runtime;
finální integrační ověření patří hlavnímu koordinátorovi.

Následný malý skutečný residual experiment je uložen v
[residual-fixed-seed/report.json](../../artifacts/extraction-quality-lab/residual-fixed-seed/report.json).
Dvě pozice, FEN-only, nová server engine instance pro každé rameno; obě ramena
začala přesně shodným 100k/MultiPV5 seedem (roots, cp i WDL). Residual rameno
po seedu vždy provedlo dva fresh reference/remainder páry 100k/200k, celkem
600k nodes; srovnávací rameno MultiPV10/100k a MultiPV16/200k, celkem 300k.
Jde o úmyslně různé pracovní rozpočty, nikoli důkaz zrychlení.

| Pozice | Residual enrichment | Výsledek residual | MultiPV enrichment |
|---|---:|---|---:|
| Startovní pozice |1.266 s /600k|PARTIAL, 0 pokrytých; gap 32→23 cp|0.356 s /300k; 10→16 individuálních roots|
| Lichess ply54 |0.854 s /600k|CP_BOUNDARY_SUPPORTED, 34/39 roots při 5 známých; gap 190→162 cp, konzervativní minimum po 40cp rezervě 122 cp|0.251 s /300k; 10→16 individuálních roots|

V žádném rameni residual se nezměnil nejlepší referenční tah proti seedu.
CP boundary nepřenáší na neprozkoumané tahy WDL ani přesnou závažnost. Živé
měření zde neprokázalo nižší cenu; pouze ukázalo odlišný dosažený rozsah evidence
v jedné taktické pozici. Experiment zůstává mimo výchozí extrakci.

### Finální plná browser/server parita po implementaci

Po opravě mixed cp/mate hodnocení a lossless odstranění duplicitní
`evidence.verifier.root` se zopakoval server STANDARD i browser STANDARD na
původních dvou PGN. Běhy byly postupné, bez souběžného engine/build měření,
bez DB, providerů a tablebase; každý game začíná novým enginem. SHA-256 snapshot
jedenácti klíčových zdrojových souborů zůstal během obou běhů shodný.

| Hra | Server / browser wall | Search requests = physical searches | Požadované nodes | Přijaté momenty |
|---|---:|---:|---:|---:|
| Chess.com, 94 plies |28.712 /27.809 s|170 /170|31.0M /31.0M|11 /11|
| Lichess, 108 plies |36.612 /34.959 s|196 /196|37.4M /37.4M|9 /9|
| Celkem |65.325 /62.767 s|366 /366|68.4M /68.4M|20 /20|

**Všech 366 request scope/history/budget/purpose a vrácených score, WDL,
PV/depth má přesnou shodu.** Shodných je všech 20 solution hashes, best moves,
accepted sets i jejich tiers, původních skóre a coverage. Oba runtime hlásily
stejné kumulativní maximum 68 305 334 UCI nodes. Všechny momenty mají PARTIAL
answer coverage, celkem 45 známých přijatých odpovědí (27 BEST, 8 STRONG,
10 GOOD); absence dalšího tahu tedy není negativní verdikt.

Přijaté decision plies: Chess.com 8,24,32,40,42,46,50,54,64,76,84;
Lichess 18,28,30,40,42,44,54,58,78. Stejné jsou i receipts: 20 potvrzených
chyb, 11 doložených NOT_A_MISTAKE, 70 UNRESOLVED (56 pod kandidátním signálem,
6 nejistých porovnání, 8 bez doložené praktické lekce), žádný engine-invalid
výsledek. Tyto přesné shody dokládají paritu tohoto vzorku, nikoli lidsky
potvrzenou kvalitu všech 20 lekcí ani obecnou převahu většího počtu momentů.

Runtime cache hitů bylo 0. To neznamená odstranění užitečné reuse: scan provedl
jen 95+109 = 204 fyzických evaluací pro 94+108 plies, tedy N+1 na hru;
orchestrace převzala 200 sousedních after/before evaluací. Nové potvrzení
naopak vždy vydalo fyzický fresh reference/original pár.

Všech 40 skutečně emitovaných momentů (20 pro každý runtime) prošlo
`validateTrainingMomentCandidates`, ověřením source PGN/history a konstrukcí
`toTrainingPromptDto` z reprezentace persistence. Tento test nevkládal data do
DB. Samotná serializovaná množina momentů měla přibližně 861 KB a 766 KB na
hru. Plné výsledky a důkazy:
[comparison.json](../../artifacts/extraction-quality-lab/analysis-fixed/comparison.json),
[handoff-validation.json](../../artifacts/extraction-quality-lab/analysis-fixed/handoff-validation.json),
[source snapshot](../../artifacts/extraction-quality-lab/analysis-fixed/source-snapshot.json),
[server STANDARD](../../artifacts/extraction-quality-lab/lab-fixed/full-product-only.json),
[browser summary](../../artifacts/extraction-quality-lab/browser-extraction-fixed/summary.json).

Použité příkazy: server `BACKRANQ_EXTRACTION_PRODUCT_ONLY=1
BACKRANQ_EXTRACTION_REPORT_DIRECTORY=lab-fixed
BACKRANQ_EXTRACTION_AUDIT_DIRECTORY=audit-fixed BACKRANQ_EXTRACTION_AUDIT=1
node scripts/run-extraction-quality-lab.mjs full --limit=2`; následně browser
`BACKRANQ_BROWSER_EXTRACTION_DIRECTORY=browser-extraction-fixed
BACKRANQ_BROWSER_COMPARISON_DIRECTORY=audit-fixed node
scripts/audit-browser-extraction.mjs`. Tyto environment přepínače řídí pouze
instrumentaci a cílové adresáře; STANDARD-only větev používá stejné parametry
jako STANDARD část běžného labu.

Předposlední plný STANDARD+4×reference běh je zachován odděleně v
`audit-pre-review` a `lab-pre-review`. Předcházel poslední mixed-score opravě;
reference 21 momentů/271.619 s/293.2M requested nodes se proto nesmí vydávat za
kontrolované srovnání s konečným algoritmem. Původní auditní baseline adresáře
zůstaly zachované. Jeden postupný běh na notebooku nezakládá obecný speedup ani
měření mobilní sítě, celého save flow či další ceny lokálního gradingu.

Poslední vlastní runtime focused ověření po přidání automatické 75-move a
fivefold draw politiky: **34 testů ve 4 souborech prošlo**, focused ESLint čistý.
50-move a threefold zůstávají pouze claimable; mat má přednost před automatickým
75-move draw. Celkové integrační checky a skutečné Practice E2E zaznamenává
hlavní koordinátor odděleně.
