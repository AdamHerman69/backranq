# Extractor economics: runnable blitz study

**Studie byla spuštěna.** Příprava kódu byla ověřena bez živého benchmarku;
následné spuštění a stažení archivů uživatel výslovně schválil.
The runnable configuration is `blitz.json`.
The old `study.json` below remains a historical design document, not runner input.

## Spuštění

Z kořene Backranq použij Node 24 a pnpm podle `package.json`. Závislosti jsou
v tomto checkoutu již přítomné; na jiném stroji nejprve `pnpm install --frozen-lockfile`.
Test běží lokálně, nepoužívá produkční databázi ani cloud credentials.

```bash
# Pouze vypíše konfiguraci. Žádný HTTP požadavek ani engine.
pnpm extractor-study plan

# Kompletní development workflow bez další interakce:
# stáhne corpus, změří 8 rodin + reference + odpovědi B0/B2/E0/E3 a vytvoří report.
pnpm extractor-study all
```

Totéž po oddělených krocích:

```bash
pnpm extractor-study prepare
pnpm extractor-study run
pnpm extractor-study answers --profiles B0,B2,E0,E3
pnpm extractor-study report
```

`prepare` opravdu provádí síťové požadavky a `run`/`answers` opravdu spouštějí
Stockfish. Výchozí `all` je široký experiment, nikoli desetisekundová analýza;
čas bez prvního měření neslibujeme. Průběh se vypisuje po každé úloze, engine
logy jsou v `logs/`. Pro několik prvních úloh lze použít `run --max-jobs 2`.
Spuštění stejného příkazu pokračuje přeskočením už dokončených úloh.

Výstupní adresář určuje `outputDirectory` v [blitz.json](blitz.json).
Obsahuje `VYSLEDKY.md`, `summary.json`, `per-game.csv`, `corpus.json`,
`runtime.freeze.json`, výsledky jednotlivých úloh a detailní `evidence/`.
Pro první rozbor stačí report/summary/CSV; pro úplný rozbor předej celý adresář.
Výpočet nezávisí na otevřeném Codex tasku; po dokončení stačí sdělit cestu.

Aktuální běh používá `artifacts/extractor-study/blitz-v2`. Na přání uživatele
byla vynechána skupina pod 1200; původní nedokončený výběr zůstává v `blitz-v1`.
Stažené archivy a dosavadní počet HTTP požadavků jsou převzaty do nového běhu.

## Výběr účtů a ratingy

Default: srpen 2026, rated standard **blitz**, 20–120 půltahů.
Konfigurace této studie dovoluje maximálně 256 půltahů a MultiPV 16, aby
uložená historie i počet variant odpovídaly možnostem použitého enginu a gradingu. Tři ratingové
skupiny 1200–1599, 1600–1999, >=2000; cílem jsou 4 účty/skupina a
8 partií/účet, napůl obě barvy. Development je jeden účet/skupina (24 partií),
holdout tři další (72 partií). Samotné stažení holdout PGN není jejich analýza.

Randomizace je seedovaný výběr z omezené **sítě soupeřů** nalezených ve veřejných
měsíčních archivech. Výchozí vstupy jsou adam1a4 a annacramling. Neznamená to,
že budou nutně vybráni do finálního náhodného vzorku, ani rovnoměrný výběr všech
Chess.com hráčů. Skupina se určí mediánem ratingů účtu v eligible měsíčních blitz
partiích; jednotlivé game ratingy jsou zachované. Není to FIDE rating.

Nejdříve se objeví omezený pool, potom se seedem vyberou účty a partie, bez
znalosti accuracy či výsledku enginu. Globální deduplikace a vyloučení partie
proti účtu v opačném splitu zabraňují sdílení téže partie mezi splity.
Při nedostatku hráčů/her vznikne `corpus-shortfall.json` a skript zastaví;
nepřidává tiše jiný rating nebo rapid. Před dalším pokusem uprav discovery
seeds/limity **a nový outputDirectory**, protože konfigurace už byla zmrazena.
Síťové requesty jsou sériové, s cache, časovým limitem, omezenými retries a
trvalým request counterem. Timeouty včetně čtení těla odpovědi, chyby spojení
a HTTP 408/429/5xx mají nejvýše šest pokusů, 30s timeout a prodlevy
2/4/8/16/30s (případně delší podle Retry-After, maximálně pět minut).
Každý pokus se započítává do původního limitu HTTP požadavků. Viz [oficiální popis PubAPI](https://support.chess.com/en/articles/9650547-what-is-the-pubapi-and-how-do-i-use-it).

## Co se skutečně měří

| ID | Strategie |
|---|---|
| B0 | Aktuální Thorough |
| B1 | Aktuální Standard |
| B2 | Single, jedno podpůrné hledání |
| E0 | Přijetí podle aktuálního scanu, bez potvrzení |
| E1 | Bodové přijetí, nejvýše doplnění 100k root + 100k původní tah |
| E2 | Totéž s 200k + 200k |
| E3 | Bodové přijetí, adaptivní doplnění 100k a případně 200k |
| E4 | Stejná adaptace, ale shoda dvou posledních úplných pozorování |

Konfigurace mění scan, MultiPV doplnění, párované rozpočty, strategii přijetí,
game/candidate limity a sílu reference. Hranice kvality a výběrové signály jsou
v tomto rodinném porovnání pevné podle dosavadní policy. Neznámé klíče konfigurace
jsou chyba, ne ignorovaný přepínač. Scan MultiPV je v tomto runneru pevně 1.

B0–B2 volají skutečný produkční extractor. E0–E4 provádějí skutečná hledání
přes tentýž engine adaptér, ale vracejí **experimentální odhady přijetí**, nikoli
produkční v4 momenty s podvrženým SUPPORTED. Produkční kontrakt ani UI se nemění.
Proto report odděluje přijaté odhady a validované produkční momenty; samotný počet
E0–E4 neprokazuje jejich připravenost k nasazení. Toto je implementovaná admission
ablation, nikoli kompletní dříve navržená migrace kontraktu.

Referenční běh udělá silnější scan každé partie, pak seedovaný vzorek ze tří
vrstev: alespoň jednou přijaté, ostatní kandidátní a ostatní hráčovy pozice.
Výchozí nejvýše 2 pozice/vrstva mají silnější root, původní a referenční tah.
Report uchovává velikost vrstvy a pravděpodobnost výběru. Silný bodový odhad
a současný strict verdikt jsou oddělené; UNKNOWN se nepočítá jako shoda.
Nejde o exhaustive řešení všech tahů nebo neomylné šachové rozhodnutí.

`answers` použije nejvýše 64 development / 32 holdout auditních pozic a šest
odlišných legálních tahů na pozici: původní, preferovaný, další auditně dobrý,
špatný/neznámý, hash-random a případné zbývající auditní alternativy. Nejde o
reálnou distribuci hráčových odpovědí ani o automatický benchmark „hranice“.
Každá dvojice profil/pozice/tah má čerstvý engine proces a znovu načtenou původní
zaplacenou evidenci. Volá skutečný `gradeUnknownLocalMove` se společnou strict
policy, 2M node cap a 5s interním grading watchdogem. Vnější job limit zahrnuje
i startup. Všechny odpovědi tedy nezačínají s teplou cache po předchozím testu.
Report rozlišuje společnou testovací sadu a tahy v momentech, které daný profil
skutečně přijal. Náklad je lokální proxy následného gradingu; není to měření
React UI, telefonu, skutečného cloud billing tarifu ani lifetime cost forecast.

## Limity, přerušení a opakovatelnost

Výchozí 50 miliard rezervovaných uzlů / 24 CPU hodin platí pro všechny fáze
v adresáři, včetně reference, odpovědí a neúspěšných pokusů. Limity se kontrolují
před dispatch a průběžně; další job musí mít celou rezervaci. Jeden job má
strop 200M uzlů / 600s, odpověď nejvýše 2M uzlů. Hledání může node limit
nepatrně překročit; reported nodes se uchovají vedle rezervací.

CPU se měří v čerstvém worker procesu **i jeho skutečném Stockfish podprocesu**.
Studijní IPC preload pouze posílá CPU telemetry; samotný engine a produkční
process entry zůstávají stejné. CPU a elapsed time nejsou billing jednotky.
Paměťové číslo je součet maxim procesů, horní odhad obálky, ne současný peak RSS.
Po násilném pádu se chybějící CPU konzervativně doúčtuje do allowance; report
ukazuje failed attempts. U takového běhu nejde o přesně změřenou spotřebu.

```bash
pnpm extractor-study status
pnpm extractor-study run --retry-failed
pnpm extractor-study answers --profiles B0,B2,E0,E3 --retry-failed
```

Ctrl-C ukončí vlastněné procesy. Pokud koordinátor zanikne, IPC disconnect
ukončí workera a engine; živý předchozí worker brání duplicitnímu dispatch.
Žádný cizí proces skript neukončuje. Failed/censored jobs se bez explicitního
`--retry-failed` znovu nepočítají. Dokončené úlohy se neopakují. Změna corpus,
config, bundlu, engine souborů, Node verze nebo modelu CPU vyžaduje nový adresář.
Změna hardwaru tedy nepřimíchá nové časy do starého měření.

## Holdout až po výběru

`all` záměrně spouští pouze development. Po rozboru lze vybrat profil, doplnit
jeho odpovědi a zamknout ho (příklad E3):

```bash
pnpm extractor-study answers --profiles B0,B2,E3
pnpm extractor-study freeze --winner E3
pnpm extractor-study run --split holdout
pnpm extractor-study answers --split holdout --profiles B0,B2,E3
pnpm extractor-study report
```

Freeze vyžaduje dokončené development běhy/reference a odpovědi baseline/vítěze.
Neznamená automatický průchod kvalitativními prahy. Vítěze v adresáři nelze
později změnit. Holdout spustí jen B0, B2 a zamknutý profil.

## Ověření přípravy

Bez sítě a bez Stockfishe:

```bash
pnpm extractor-study:check
pnpm extractor-study plan
```

Testy používají lokální PGN/API fixtures, náhradní engine a drobný Node IPC
proces pro kontrolu CPU telemetry. Žádný benchmark se v nich automaticky
nespouští. Širší `pnpm typecheck` v aktuálním checkoutu blokují starší untracked
skripty v artifacts/confirmation-live-ablation; studijní tsconfig je neobsahuje.
Živá dostupnost vybraných účtů ani reálné engine výsledky při přípravě ověřeny
nebyly. První skutečný běh je až tebou spuštěný příkaz.

## Starší širší návrh

`study.json` is a machine-readable **draft experiment specification**, not a
configuration understood by the current extractor. It has no launcher and
`executionAllowed` is false. It must not be passed to the existing live runner.
No corpus download, engine process, replay, cloud job or benchmark is scheduled.

The detailed Czech specification and implementation dependencies are in
[`docs/extractor-parameter-study.md`](../../docs/extractor-parameter-study.md).

Prepared here:

- Three observed baseline profiles and five proposed admission strategies.
- A catalog of tunable parameters, explicitly not a Cartesian-product job list.
- Account-disjoint development/holdout design, phased run counts and ceilings.
- Reference sampling, answer workload and proposed decision criteria.
- Explicit unresolved host/corpus/artifact fields so preparation cannot be
  mistaken for a frozen, executable or completed experiment.

Required implementation before measurements: separate quality semantics,
admission and grading support; implement scheduling and cumulative budgets;
introduce the clean moment contract and all producer/consumer validators; extend
the existing quality lab with manifest validation, accounting and reporting.

Configuration interpretation for the future resolver:

1. Reject unknown keys, missing required fields and unsupported strategy values.
2. B0–B2 do not inherit `experimentalDefaults`. Preserve their current behavior
   and source policy snapshot; save the normalized complete snapshot in every run.
3. E0–E4 merge `experimentalDefaults` with the explicit profile override.
   `pairedSearchNodes` gives the per-search budget for root and original in each
   round. Thus `[100000, 200000]` costs at most 600000 nodes before evidence reuse.
4. Admission support differs by profile. All comparative answer workloads use
   `commonAnswerGradingSupport`, including B2, so grading policy is not a hidden
   second treatment. Keep historical B2 metrics separately identifiable.
5. `null` means unresolved/not applicable, never zero cost or unlimited allowance.
   Execution preflight requires resolved corpus/runtime fields; hosted-only
   fields remain inapplicable for a purely local study.
6. Phase maxima are slots, not promised completed runs. Materialize exact profile
   hashes and source IDs before dispatch. All subsidiary work consumes the same
   global experiment ceiling. A run censored by a watchdog is not a cheap success.

The frozen source baseline records what was inspected, not what will execute
after implementation. Capture the actual implementation commit, bundle, engine,
policy, corpus and resolved-profile hashes anew before any measurement.

## Cílené ověření T0 (2026-09-09)

`targeted.json` přidává experimentální strategii `POINT + TARGETED` vedle
nezměněných starších strategií. Produkční extractor ani hodnocení odpovědí se
nepřepíná. T0 má stejný scan 100k uzlů na pozici jako E0; doplňuje nejvýše jednu
root analýzu MultiPV 3 za 200k uzlů a původní tah za dalších 200k, pokud v root
výsledku chybí. Strop je 400k na pozici a 2M na partii.

Důvody doplnění jsou explicitní: přijatá chyba s rozdílem pod 75 cp a přes
10 procentních bodů očekávaného skóre; změna přijetí mezi posledními dvěma
platnými scan pozorováními; rozpor skóre nebo smíšené cp/mat. Samotná chybějící
starší pozorování nejsou důvodem k další práci. Číselné triggery jsou zatím
konstantami této testované strategie, rozpočty a MultiPV jsou v konfiguraci.

Jasné momenty se přijímají přímo ze scanu. Platný nový výsledek nahrazuje scan;
UNKNOWN není definitivní chyba. Při vyčerpání rozpočtu nebo neplatném doplnění
zůstává původní platný odhad se zaznamenaným stavem. Každé rozhodnutí má
`targetedVerification`: triggery, původní verdikt, výsledek doplnění, uzly a
identity použitých analýz. Žádný z těchto stavů neznamená, že jsme prokázali
špatnost všech neprozkoumaných uživatelských tahů.

```sh
pnpm extractor-study run --config experiments/extractor-economics/targeted.json
python3 artifacts/extractor-targeted-analysis/analyze.py
pnpm extractor-study audit-selected --config experiments/extractor-economics/targeted-audit.json --audit-plan artifacts/extractor-targeted-analysis/audit-plan.json
```

Tato konkrétní studie používá přesnou kopii dříve zmrazeného korpusu, znovu měří
E0 a T0 pouze na 24 development partiích. Staré výsledky zůstávají v blitz-v2;
jejich fingerprinty se nepřepisují. `audit-selected` kontroluje explicitní,
sourceHash vázaný seznam změněných pozic. Neprovádí znovu celý scan. Má stejné
účtování, rezervace, opakování a obnovu jako běžné úlohy. Nejvýše 64 pozic celkem,
12 na úlohu, pouze vlastní tahy development hráčů. Vybrané audity se nesměšují
s náhodným referenčním vzorkem ani s běžným testem odpovědí; jejich náklady se
vykazují samostatně i v celkovém účtu experimentu.

## Druhá cílená varianta T1

`targeted-v2.json` porovnává nezměněný T0 s `POINT + TARGETED_V2` (T1), se
stejným scanem a stejnými rozpočty. T1 neplatí za samotné záporné rozdíly,
rozšiřuje WDL trigger na případy uvnitř běžné cp tolerance a podporuje cp/mat
pomocí platných WDL odhadů. Neinterpretuje mate0 nebo nesoulad znaménka matu s
WDL jako jasný výsledek. Záporný WDL rozdíl zůstává nerozhodnutý.

```sh
pnpm extractor-study run --config experiments/extractor-economics/targeted-v2.json
python3 artifacts/extractor-targeted-v2-analysis/analyze.py
pnpm extractor-study audit-selected --config experiments/extractor-economics/targeted-audit-v2.json --audit-plan artifacts/extractor-targeted-v2-analysis/audit-plan.json
node artifacts/extractor-targeted-v2-analysis/project-reference.mjs
```

Skript porovnání odmítne nekompletní párovaný běh před zafixováním auditního
plánu. Poslední příkaz pouze čte již placenou silnou evidenci a přidává sekundární
V2 projekci vedle zachovaného starého referenčního verdiktu. Nespouští engine.
Předem vymezený rozsah je v `artifacts/extractor-targeted-v2-analysis/PLAN.md`.
T0 ani produkční extractor se automaticky nepřepínají na T1.

## T2: priorita hraničních přijetí

`priority-v1.json` porovnává T1 a `POINT + TARGETED_PRIORITY` (T2). T2 mění
pouze pořadí kandidátů: nejdřív počátečně přijaté momenty, potom vzdálenost
E ztráty od 0,10 vzestupně a shody podle ply. Chybějící/nečíselná ztráta jde
na konec své skupiny. Prahy kvality, triggery, scan, limity i reuse zůstávají
stejné jako T1. Výstupní rozhodnutí zachovávají původní pořadí partie.

```sh
pnpm extractor-study run --config experiments/extractor-economics/priority-v1.json
python3 artifacts/extractor-priority-analysis/analyze.py
pnpm extractor-study audit-selected --config experiments/extractor-economics/priority-audit-v1.json --audit-plan artifacts/extractor-priority-analysis/audit-plan.json
node artifacts/extractor-targeted-v2-analysis/project-reference.mjs artifacts/extractor-study/priority-audit-v1 artifacts/extractor-priority-analysis/reference-projection.json
```

Malý oddělený test full-root/singleton versus společný omezený pár je uložen
v `artifacts/extractor-priority-analysis/joint-diagnostic`. Nemění implementaci
T2. Jde o záměrně vybrané problematické pozice, ne odhad populační přesnosti.
