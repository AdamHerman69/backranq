# Parametrický experiment extractoru: cena, výběr momentů a odpovědi

Datum: 2026-09-08. Stav: **výzkumný runner připraven, experiment dosud nespuštěn**.
Spustitelná první etapa: [návod](../experiments/extractor-economics/README.md)
a [blitz.json](../experiments/extractor-economics/blitz.json). Obsahuje osm rodin
strategií, oddělený holdout, silnější referenční audit, reálný grading odpovědí
a měření výpočetních nákladů. Experimentální přijetí momentu je výzkumný záznam;
navrhovaná změna produkčního kontraktu a další etapy tohoto dokumentu nejsou
součástí této implementace. První matice mění rozpočty a strategii, prahy kvality
zatím drží stejné. Žádný corpus ani živé měření nebylo v rámci přípravy spuštěno.

Výchozí kód: `ea127c3f9e461297820c56dc070e4815a43b4bff`.
Strojově čitelný návrh: [study.json](../experiments/extractor-economics/study.json).
Tento dokument určuje příští experiment a nahrazuje konfliktní doporučení
v [předchozím ekonomickém plánu](extractor-economics-plan.md). Neoznačuje
navrhované chování za implementované nebo nasazené. Historická měření zůstávají
beze změny. Dřívější holdout, jehož výsledky už známe, je nyní vývojový materiál.

## 1. Zadání a hranice

Hlavní případ: automatická extrakce po synchronizaci partií platících uživatelů,
typicky na serveru. Uživatel nečeká na stránce; průběžné statistiky ani rychlý
game review nejsou požadavek. Cíl je nízký skutečný serverový náklad na partii
a užitečný připravený moment při přijatelné kvalitě Practice.

Homepage: tentýž extractor, jiný profil, samostatné měření času k prvnímu
osobnímu hratelnému momentu. Přibližně 10 sekund je orientační výkonnostní
ambice na určeném hardwaru, nikoli plošný deadline background úloh ani SLA.
Lokální extrakci hodnotíme samostatně podle výkonu zařízení a následného gradingu.

Uživatel potvrdil oddělení nižšího požadavku na jistotu při výběru momentu
od opatrnějšího definitivního hodnocení jeho odpovědi. Nejde o automatické
přijímání každého scan kandidáta nebo odmítání neprozkoumaných tahů.

V tomto kroku vzniká specifikace a datová matice. Neprobíhá refaktor aplikace,
načítání dalších účtů, engine výpočet, replay experimentů, benchmark, cron,
cloud job, migrace, commit, push ani nasazení. Další provedení potřebuje navazující
zadání; samotné limity v tomto návrhu nejsou povolení utrácet výpočetní rozpočet.

## 2. Ověřený současný stav

| Vrstva | Co existuje | Co pro experiment chybí |
|---|---|---|
| Parametry | Scan, potvrzovací rozpočty, MultiPV, kandidátní prahy a `gradingPolicy` | Samostatná admission policy, oddělené rozpočty přípravy a hodnocení odpovědí |
| Běh | `FULL_GAME` průběžně střídá scan a potvrzení; `FIRST_PUZZLE` nejprve scanuje, pak řadí kandidáty | Volitelný společný scan-first plán pro rozpočtované background zpracování |
| Evidence | `PositionAnalysisPool`, fyzická hledání, kontext, historie, receipt, checkpoint | Úplné důvody každého neprošlého admission gate a účtování všech nových fází |
| Moment | v4 propojuje rozhodnutí `CONFIRMED_MISTAKE`, selection a podporu gradingu | Přijatelný odhad chyby jako samostatný důvod přijetí, který nefalšuje grading |
| Lab | Celé běhy, frozen PGN, silnější analýza, uložené pooly, prefix replay | Obecný manifest, širší corpus, nezávislé reference a následná simulace odpovědí |
| Server | `ServerStockfishClient` používá Stockfish 18 Lite single-thread NNUE WASM, Hash 64 MB | Měření skutečného serverového CPU/billingu; nejde zatím o native Stockfish benchmark |

Relevantní soubory: `src/lib/analysis/extractTrainingMoments.ts`,
`positionAnalysisPool.ts`, `extractionReceipt.ts`, `quality.ts`,
`src/lib/training/assessmentPolicy.ts`, `practiceContract.ts`, `localGrading.ts`,
`src/lib/analysis/practiceMomentBuilder.ts`, `scripts/extraction-quality-lab.ts`,
`scripts/extraction-quality-comparison.ts` a nástroje v
`artifacts/confirmation-live-ablation/`.

Historický test 16 partií / 80 běhů: Thorough 633,7M uzlů / 45 momentů,
Standard 457,5M / 39, Single 403,2M / 41 a Light 323,8M / 38.
Single má stejné ostatní support gates jako Standard. Light ukázal konkrétní
nesprávné odmítnutí alternativní odpovědi vůči silnější cílené kontrole;
neprokazuje nutnost reference probe pro přijetí každého momentu.
Čísla nejsou serverové ceny ani reprezentativní odhad populace.

## 3. Pět nezávislých politik, jedno jádro

### 3.1 Význam kvality tahu (`qualityPolicy`)

Pro hlavní experiment neměnit hranici GOOD/BELOW_STANDARD ani tiery:
`toleranceCp(best) = clamp(0.6 * max(best, 0), 100, 300)`;
přijatelný finite tah má ztrátu nejvýše tuto toleranci a při dostupném
srovnatelném WDL nejvýše 0,10 očekávaného skóre. Změna pořadí rovnocenných
tahů není chyba. Vše z perspektivy trénovaného hráče.

WDL očekávané skóre je `(W + D/2)/(W+D+L)`. Chybějící nebo nesrovnatelné WDL
nenahrazovat vydávaným „skutečným WDL“ z cp. CP_ONLY je explicitní cesta.
Přesný pravidlový výsledek a engine odhad matu jsou odlišné druhy evidence.

### 3.2 Levné vyhledání (`candidatePolicy`)

Výchozí screening zachovává OR: ztráta >=30 cp NEBO >=0,03 očekávaného skóre,
případně relevantní změna matového hodnocení. Je to filtr pro další práci,
nikoli definice chyby. Hlavní rodinné porovnání jej nemění. Později lze
porovnat 30/60/100 cp a 0,03/0,05/0,08 E na stejných scan datech.
Když změna kandidátů změní pořadí či množství hledání, cena vyžaduje live běh.

### 3.3 Přijetí cvičení (`admissionPolicy`)

Explicitní varianty:

- `SUPPORTED`: dnešní odvození včetně reference readiness, podpůrných skupin,
  rezerv a výběrového signálu. Referenční baseline.
- `POINT`: poslední úplné dokončené neomezené hodnocení nejlepšího a původního
  tahu, bez minima uzlů, odstupu hloubek, intervalu stability nebo povinného
  singleton ověření reference. Povinné zůstávají platná data a legální pokračování.
- `WINDOW`: stejné jako POINT, ale závěr musí souhlasit v posledních dvou úplných
  pozorováních ze stejného hledání, s odstupem hloubky >=1, bez přidaných rezerv.
  Je to měřitelná levná alternativa stability, nikoli statistická jistota.

POINT/WINDOW nepoužívají funkci, která před vrácením čísla vynucuje dnešní
`qualitySupport=SUPPORTED`. Nezávisle čtou a normalizují přípustná pozorování,
ale sdílejí čistou funkci pro význam kvality. Nejde o nastavení support prahů
na nulu, které by současně oslabilo grading.

Při scan-only lze porovnat nejlepší hodnotu před tahem s hodnotou pozice po
původním tahu po otočení perspektivy. Vazba přes skutečný tah a historii musí
být zaznamenaná (`PARENT_CHILD_SCAN`). Nedělat z ní důkaz přímého root hledání
původního tahu. Pokud existuje přímý odhad ze stejného rootu, preferovat ho
(`SAME_ROOT`). Žádné průměrování těchto zdrojů; aktuální zdroj uvést v receipt.

Přijetí POINT vyžaduje současně původní tah BELOW podle sdílené bodové hranice
a výběrový signál: při matched WDL ztrátu E >=0,08, při CP_ONLY ztrátu cp >=100
a abs(bestCp)<300. WINDOW totéž v obou bodech; SUPPORT používá dosavadní
konzervativní interval. Ztráty se před kontrolou rozporu nesmějí oříznout na nulu.
Číselné prahy jsou výchozí experimentální hodnoty, ne dokázaná optima.

Proč výběrový signál ponechat: samotný cp propad v již rozhodnuté pozici není
automaticky užitečné cvičení. Citlivost tohoto pravidla lze vyhodnotit zvlášť;
není podmíněna rozpoznáním „lekce“ nebo taktického motivu.

Původní tah totožný s preferovaným neprodukuje cvičení z nesouhlasných skóre.
Stejný matový vítěz v různých vzdálenostech není automaticky jiná kvalita.
Smíšené CP/MATE bez srovnatelného podkladu má explicitní unresolved důvod;
levný režim může skončit bez momentu a nesmí přepočítávat donekonečna.
Pravidlové certifikáty mají přednost. Změna vítěze v odpovídajících matových
hodnoceních může dát engine odhad ztráty výsledku, nikoli přesný certifikát.

### 3.4 Přidělování výpočtu (`executionPolicy`)

Tři způsoby doplnění:

- `NONE`: žádné nové hledání po scanu.
- `PAIR_ONCE`: nejvýše jedno full-root hledání a jeden focused search původního
  tahu ze stejného rootu. Již zaplacené vyhovující pozorování se využije;
  nespouštět automaticky obě hledání, pokud některé nechybí.
- `ADAPTIVE`: přijmout jasný scan odhad, doplnit pouze hraniční, chybějící
  nebo rozporný kandidát. Po prvním kole buď rozhodnout, nebo provést nejvýše
  jedno dražší kolo; pak explicitně skončit. Reference singleton je samostatně
  nastavitelné `NEVER` / `ON_CONFLICT` / `ALWAYS`, nikoli skryté chování.

U ADAPTIVE definujeme hraniční případ číselně: bodová ztráta je do 30 cp od
adaptivní cp hranice nebo do 0,03 od WDL hranice 0,10 či selection hranice 0,08.
CP vzdálenost relevantní jen při dostupném CP, WDL jen při matched WDL.
Chybějící score/PV nebo smíšené score kinds jsou samostatné důvody. Změna
preferovaného tahu sama o sobě eskalaci nespouští. Posun stejné reference o
>60 cp nebo >0,06 E mezi dostupnými současnými porovnáními je měřený konflikt;
jde o počáteční nastavení, ne neomylný detektor chyby.

Scan-first pro nové rodiny: každá potřebná pozice jednou, poté zmrazit pořadí
kandidátů podle výběrového signálu / relativní velikosti ztráty, při shodě ply.
Pořadí nezávisí na pozdější referenční analýze. Kvalifikovaný starší výsledek se
nepřepočítává jen kvůli novému internímu ID. FEN bez historie nestačí pro reuse.

Nové rodiny mají celkový post-scan limit 8M uzlů/partie a 600k/kandidát;
PAIR_ONCE 100k+100k nebo 200k+200k, ADAPTIVE 100k+100k a volitelně 200k+200k.
Všechny proby a opravy se započtou do téhož limitu. Není další allowance při
resume, retry ani změně role hledání. Když se hledání nevejde, nespouští se.
Základní rodinné porovnání neplatí za optional answer coverage.

V hlavním experimentu porovnat současný INTERLEAVED plán s novým SCAN_FIRST
samostatnou bridge ablation. Změna TT způsobená pořadím může měnit výsledky;
rozdíl nesmí být připsán pouze uvolnění admission.

### 3.5 Odpovědi (`answerPreparationPolicy`, `gradingSupportPolicy`)

Pro hlavní rodinný test ponechat grading beze změny: dnešní strict support,
400k reference probe a dvě podpůrná hledání, i u momentů přijatých POINT.
Historické baseline reportovat v jejich původní podobě; při společném grading
testu všem promítnout tuto tutéž grading policy. Odlišné známé odpovědi z
historického Single neporovnávat jako čistý efekt admission.

Příprava: `REUSE_ONLY`, `TOP3_200K` a `TOP5_400K`. Číslo znamená celkový nový
rozpočet přípravy na přijatý moment, nikoli rozpočet pro každý tah. Chybějící
podpora reference má prioritu před rozšiřováním počtu tahů. Žádný režim neslibuje,
že vždy klasifikuje tři/pět odpovědí. Existující MultiPV se nikdy nevyhazuje.

Tyto přípravné režimy testovat až u dvou nejlepších admission strategií.
Později lze samostatně porovnat grading strict vs single-support; nekombinovat
ho nepozorovaně s výběrem kandidátů. Vyčerpání grading rozpočtu nesmí znamenat
automaticky špatnou odpověď.

## 4. Cílový datový kontrakt a hotový background job

Navrhovaný čistý nástupce v4, bez legacy readeru nebo dvojího zápisu:

```ts
type AdmissionAssessment = {
  status: 'ADMITTED' | 'OMITTED';
  basis: 'SUPPORTED' | 'POINT' | 'WINDOW' | 'RULE';
  reason: string;
  originalQualityEstimate: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
  comparisonBasis: 'SAME_ROOT' | 'PARENT_CHILD_SCAN' | 'EXACT';
  preferredMoveUci: string;
  referenceObservationIds: string[];
  originalObservationIds: string[];
  estimatedLossCp: number | null;
  estimatedLossExpectedScore: number | null;
  policyId: string;
};
// V revizi vedle sebe:
// source, evidence, admission, qualityPolicySnapshot,
// gradingSupportPolicySnapshot, executionProfileSnapshot,
// assessments, answerIndex, continuation, costs, semanticHash.
```

Pravidlová evidence se váže samostatnými exact record IDs, nejen observation IDs;
finální schema bude vyžadovat union evidence references pro oba zdroje.
Číselné odhady nemohou samy nastavovat `qualitySupport=SUPPORTED`.
Admission se validuje vlastní čistou projekcí z citované evidence. Odpovědi
vlastní grading projekcí. Importovaný boolean ani score bez původu není důkaz.

Moment s odhadnutou chybou může mít grading readiness `ON_DEMAND`; potřebuje
platnou zdrojovou pozici, alespoň dvě legální možnosti a legální preferovaný tah
s použitelným pokračováním. Nepotřebuje předem vyřešit všechny přijatelné tahy.
Produkt nesmí tvrdit, že nepotvrzený odhad je garantovaná chyba. Pokud pozdější
grading odhad vyvrátí, pokus se nepočítá jako chyba uživatele; moment se vyřadí
z budoucí nabídky s dohledatelným důvodem. Tento případ i jeho náklad měříme.

Samostatně reportovat ADMITTED, GRADE_READY a skutečně DELIVERABLE momenty.
Přijetí do souboru není splněné Practice UX: finalisté musí projít sestavením
revize, validátorem, uložením/načtením a reálným lokálním hodnocením odpovědi.
Levné přijetí nesmí pouze přesunout veškeré potvrzování do každého otevření.

Receipt pro každý hráčův tah: kandidátní signál, admission, jednotlivé neprošlé
podmínky, náklad před rozhodnutím, skutečně provedená hledání, důvod ukončení.
Odlišit `LOW_SIGNAL`, `ESTIMATED_GOOD`, `MISSING_COMPARISON`, `BOUND_ONLY`,
`MIXED_SCORE_KINDS`, `REFERENCE_CONFLICT`, `SUPPORT_POLICY_ONLY`,
`CANDIDATE_BUDGET_EXHAUSTED`, `GAME_BUDGET_EXHAUSTED`, `INVALID_SOURCE`,
`ENGINE_FAILURE`. Více současně nesplněných podmínek ukládat jako pole.

Dokončený background job znamená dokončení deklarovaného rozpočtovaného plánu.
Zbývající odhadové/nerozhodnuté kandidáty automaticky znovu nefrontovat.
Checkpoint drží fázi, pořadí, kurzory, evidence a dosavadní náklad. Technický
retry je odlišný od další dobrovolné analýzy a nesmí obnovovat allowance.

## 5. Matice: nejprve strategie, potom několik parametrů

Výchozí rodiny, scan 100k a kandidátní prahy 30 cp / 0,03 E:

| ID | Admission | Další hledání | Účel |
|---|---|---|---|
| B0 | Dnešní Thorough | Dnešní 200k–1,6M | Nasazená baseline |
| B1 | Dnešní Standard | Dnešní 200k–800k | Levnější strict baseline |
| B2 | Historický Single | B1 s jednou podpůrnou skupinou | Dosavadní nejlepší kompromis |
| E0 | POINT | Žádné | Kolik opravdu získáme jen ze scanu |
| E1 | POINT | Jedno doplnění 100k root + 100k original | Levné srovnání ze stejného rootu |
| E2 | POINT | Jedno doplnění 200k + 200k | Samostatný přínos většího rozpočtu |
| E3 | POINT | Adaptivně 100k+100k, nejvýše ještě 200k+200k | Platit více pouze vybraným kandidátům |
| E4 | WINDOW | Stejný plán jako E3 | Cena a přínos jednoduché stability |

E1–E4: confirmation root MultiPV5, bez povinného focused reference probe,
REUSE_ONLY. Scan je MultiPV1. E0–E4 mění admission, nikoli grading.
B0–B2 zachovávají původní plán a nastavení, žádný nový měkký game cap.

P0: všech 16 historických partií, B2 INTERLEAVED vs B2 SCAN_FIRST: 32 běhů.
Stejná policy i rozpočty; izoluje změnu plánování. Historické časy nejsou čerstvá
kontrola. Scany mezi různými rameny nesdílet při měření celkové ceny.

P1: 32 vývojových partií × 8 rodin = 256 běhů. Pokud přijímání E0/E1 vyjde
dobře, není povinnost prosadit složitější adaptivní variantu.

P2: nejvýše 6 nových konfigurací × stejných 32 partií = 192 běhů.
Tři běhy na každého ze dvou finalistů: samostatně scan50k, root MultiPV3
(u E0 scan MultiPV3), příprava TOP3_200K. Výchozí již existující běh znovu
nepočítat. Pokud máme jen jednoho finalistu, nejvýše tři konfigurace.
TOP5_400K a další prahy zůstávají v katalogu, nejsou automaticky další běhy.
Kombinovaný vítěz vyžaduje vlastní započtený live běh; nepředpokládat sčítání
úspor jednotlivých změn. Nevejde-li se do šesti, nahradit předem jiný P2 slot.

P3: zamknutý vítěz + B0 + B2 na 96 nových holdout partiích = 288 běhů.
Po výsledcích holdoutu nic nedolaďovat. Nová hypotéza potřebuje nový split.
Maximum P0–P3 je 768 celých produktových běhů. Každá fáze může skončit dříve;
nejde o povinnost všechny sloty spotřebovat. Reference, grading a homepage
mají samostatné počty i rozpočty, uvedené níže.

## 6. Corpus, který nepřizpůsobíme výsledkům

Návrh: 16 veřejných Chess.com účtů, 8 partií/účet = 128 hlavních partií.
Čtyři ratingové skupiny: <1200, 1200–1599, 1600–1999, >=2000, čtyři účty/skupina.
Rating je provider/time-control specifický; nedělat z něj FIDE ani míchat
stejné číslo Chess.com a Lichess. Přiřazení účtu podle mediánu blitz ratingu
v eligible období; jednotlivé game ratingy reportovat samostatně.

Jedna vývojová identita/skupina (4 účty ×8 =32), tři nové holdout identity/skupina
(12×8 =96). `adam1a4` a `annacramling` zařadit do development ve skupině podle
metadat. Dalších 14 identit zatím není vybráno. Neodhadovat jejich rating.
Je-li už dříve analyzovaný soupeř současně novým vybraným účtem, vzájemné partie
nepoužít napříč splity; identický PGN nikdy přes split nepřenést.

Období 2026-08-01 až 2026-08-31 UTC, pouze ukončené rated standard partie,
20–160 plies. Na účet čtyři blitz a čtyři rapid, v každém control dvě za každou
barvu. Vybrat pomocí stabilního hash pořadí ze všech eligible source IDs se
seedem z manifestu. Ignorovat výsledek partie, accuracy i engine hodnocení.
Zbylé metadata (délka, výsledek, time control, rating soupeře) slouží k reportu.

Soupis identit a pravidla náhrad zamknout před stažením/analýzou hlavního corpus.
Při nedostatku buňky použít další předem seřazený účet stejné skupiny, jinak
vykázat nedostatek. Žádné tiché posunutí období, přidávání partií s blundery
nebo hledání vhodnějších holdout výsledků. Starých 16 partií je zvláštní P0
materiál; shodné PGN v P1/P3 vyloučit před výběrem.
Účty Adam a Anna nevynechat kvůli nedostatečnému počtu rapid partií: jejich
dostupné partie ponechat v označené development příloze, pokud nesplní hlavní
kvótu. Rozsah přílohy nahradí development sloty, nerozšiřuje automaticky rozpočet;
pak přiznat nevyváženost/menší hlavní corpus. Neprohlašovat plánovaných 128
partií za již dostupné. Úvodní metadata discovery slouží k sestavení rosteru,
neobsahuje engine výpočet; teprve potom se zmrazí konkrétní PGN výběr.

Vlastní stress suite nejvýše 32 existujících pozic: maty, pravidlové remízy,
historie/repetice, jediný legální tah, promotion, saturated CP/WDL, více dobrých
alternativ, měnící se reference, neúplné UCI a přerušení. Není součástí odhadu
běžné četnosti chyb. Lichess provider ověřit až na 12 dodatečných fixních partiích
v adapter/parity části, neprohlašovat z nich ratingovou ekvivalenci.

## 7. Reference, která nevynucuje stejnou chybu metodiky

Neměřit správnost levného přijetí pouze tím, zda prošlo dnešním strict builderem.
Uchovat dvě nezávisle popsané projekce: silnější bodový odhad a stávající strict
support. `UNKNOWN` v druhé projekci není automaticky chyba první ani shoda.

Každá hlavní partie dostane silnější audit scan 400k/pozice, nezávislý na tom,
co levné varianty přijaly. Odkryje také kandidáty, které všechny varianty minuly.
To stále není úplná pravda o všech možných chybách v partii.

Ze všech hráčových rozhodnutí vytvořit tři disjunktní vrstvy na každou partii:
A: přijaté alespoň jednou variantou; B: nepřijaté, ale kandidátní alespoň v jedné
variantě nebo silnějším scanu; C: ostatní hráčova rozhodnutí. Hash sampling
nejvýše 2 pozice/vrstva/partie, celkem <=768. Malou vrstvu vzít celou;
volné místo nepřesouvat podle zajímavosti výsledku. Uvést velikost každé vrstvy
a inclusion probability `min(1, 2/N)`; reprezentativní agregace vážit těmito
pravděpodobnostmi. Nízké počty v některých vrstvách přiznat.

Pro každou vybranou pozici čerstvá session: root MultiPV5 4M, original 4M,
focused preferred 4M (chybějící work; terminální případy zdarma). Nejvýše 12M.
Audit zachová raw skóre, poslední úplné iterace, PV a WDL. Bodový závěr přímo
z aktuálního páru plus označení stability; žádná podmínka dvou fyzických
potvrzení pro vrácení auditního odhadu. Strict projekci reportovat vedle něj.
Silnější finite hledání není oracle a nemá vždy pravdu proti levnějšímu.

Nejvýše 128 cílených rozporů mimo náhodný odhad: deterministicky nejprve falešné
odmítnutí odpovědi, potom opačný výsledek/mat, potom nové/vynechané momenty,
při shodě hash. Každý má nejvýše dalších 12M uzlů. Má-li závěr stále konflikt,
zůstává sporný; nevynucovat verdikt delším a delším výpočtem. Tyto cílené případy
nepřičítat do reprezentativního jmenovatele chybovosti.

U nejvýše 48 pozic navrhnout zaslepené šachové posouzení užitečnosti: je tu
smysluplně lepší rozhodnutí, je nabídnutá alternativa použitelná a existuje
materiální spor v hodnocení? Rovnoměrně z náhodného vzorku a změněných emisí,
uvést původ. Není potřeba pojmenovat motiv. Není-li k dispozici kvalifikované
lidské posouzení, výstup nazvat engine proxy kvality, ne lidsky ověřená užitečnost.

## 8. Náklad serveru a kvalita Practice

Primární měření: CPU user+system celého jobu včetně workerů; u WASM ve stejném
procesu nevydávat pouze main-thread `process.cpuUsage` za celou cenu bez ověření.
Když metrika není dostupná, uvést null a dostupnou proxy. Dále requested/reported
nodes, wall time, startup, paměť/RSS, alokovaná GB-s, evidence/DB bytes, zápisy,
queue retries a invocations. Engine-reported elapsed není CPU ani billing.
Čekání ve frontě a přenos oddělit; paralelizace může snížit wall time bez úspory CPU.

Produktový náklad zahrnuje scan + všechny kandidáty včetně vyřazených + reference
probes + přípravu odpovědí + validaci/serializaci/uložení. Auditní reference se
účtuje jen do ceny experimentu. Dollar cenu počítat až z ověřeného tarifu
a skutečně účtovaných jednotek; produktové credits nejsou cloud dollars.

Reportovat CPU/partie, CPU/100 hráčových rozhodnutí, CPU/admitted moment,
CPU/grade-ready moment a CPU/odhadnutý užitečný moment. U nulového výtěžku poměr
undefined, nikoli nula. Současně chybné přijetí, reference-unknown, recall vůči
auditnímu vzorku, podíl partií s momentem, změny preferovaného tahu, velikost
odchylky a nevratně chybný verdikt odpovědi. Samotný počet momentů není kvalita.

Dopočty nejsou zdarma: pro oba admission finalisty a B0/B2 vyhodnotit společný
vzorek 64 pozic z development union (16/ratingová skupina dle dostupnosti).
Na každé nejvýše 6 předem určených odpovědí: původní, auditně preferovaná,
jedna blízko hranice, jedna další dobrá, jedna špatná a jedna hash-random legální.
Deduplicovat, chybějící kategorie vynechat; <=384 pozice/tah dvojic na profil.
Stejný tah neposuzovat jen v profilech, které jej už znají. U nepřijatého momentu
uvést unavailable, ne bezchybnou odpověď. Common-position a union report oddělit.
Po zamknutí P3 opakovat stejnou metodu na nejvýše 32 holdout pozicích pro B0,
B2 a vítěze, tedy <=192 dvojic/profil. Development grading není důkaz
generalizace vítěze na holdoutu. Kategorie odpovědí se vybírají z auditní evidence
bez znalosti toho, zda konkrétní produktový profil odpověď zvládne.

Čerstvý pokus se obnovuje z původní uložené evidence, ne z předchozího testovaného
tahu. Cold browser, warm engine a opakované otevření téhož momentu jsou oddělené
scénáře. Record instant grade, pending, čas/uzly do gradingu, opravy prvního
verdiktu, timeout a stále nerozhodnuto. Limit 2M nových uzlů/pokus a 5 sekund
watchdog pro test; vyčerpání limitu není správná odpověď ani úspěšná latence.
Hranice/tahy chybějící v audit MultiPV vyžadují zvlášť zúčtované cílené audit
hledání, nejvýše 4M na vybranou dvojici; bez něj zůstává srovnání unknown.

Bez reálné distribuce odpovědí nepočítat instant-feedback rate z podílu známých
legálních tahů. Uvést každý typ odpovědi zvlášť a scénáře využití:
0 %, 25 %, 100 % momentů otevřených, 1 a 3 pokusy/otevřený moment. Model:
`serverCost = extraction + preparation + opens * serverFallback + storage`;
lokální CPU/latenci uvést vedle, nikoli za serverový náklad. Pokud server fallback
není implementovaný, neuvádět ho jako existující funkci. Scénáře nejsou forecast.

## 9. Runtime, opakovatelnost a hranice experimentu

P1–P3: stejný současný serverový WASM artifact, Hash64, Threads1, WDL zapnuto.
Nový native runtime není skrytý parametr těchto rodin. Pokud později vznikne,
porovnat ho zvlášť s novou engine identitou a znovu ověřit kvalitu, teprve potom
kombinovat výhody. Názvem `server` neimplikovat native výkon.

Čerstvá session každá partie/profil, TT reuse uvnitř normálního běhu. Rotovat
pořadí profilů předem daným seedem, nesdílet warm cache mezi experimentálními rameny.
Sériově měřit cenu/latenci bez vlastních konkurenčních benchmarků; cizí procesy
neukončovat. Rušnou mašinu označit, nikoli selektivně vyhazovat pomalé vítěze.
Throughput při paralelním background zpracování měřit až zvlášť na stejném stroji
pro B0 a vítěze; neplést s jednotlivým job CPU.

Každý artefakt: corpus/profile/source/runtime hash, přesné verze/flags a options,
account/split/game source, původní PGN hash, kontext/historie/perspektiva,
fyzická search ID a účetní ledger, výsledek/censor/failure. Výstup atomický.
Resume pouze se stejnými fingerprinty; změna konfigurace vytvoří nový run.
Uložení trace nesmí změnit engine rozpočet; overhead trace se měří.

Offline projekce je použitelná pro změnu prahu při neměnné sadě důkazů.
Neumí odhadnout úsporu vynechaného hledání, změnu TT ani jiné pořadí úloh.
Každý vítěz proto potřebuje celý skutečný běh a navazující Practice zkoušku.

Navrhované maximální rozsahy, ne autorizace:
- P0–P3: <=768 celých produktových běhů.
- Silnější scany: <=128; náhodné cílené reference <=768; cílené rozpory <=128.
- Answer workload: development <=4 profily ×384 a holdout <=3×192 pokusů,
  celkem <=2112; audit neznámých odpovědí <=576 odlišných dvojic.
- Stress: <=32 pozic ×8 profilů, engine jen pokud nestačí fixtures.
- Homepage: <=12 frozen bundles ×2 profily ×2 cold/warm podmínky =48 lookupů.
- Finální server throughput: <=12 partií ×2 profily ×2 concurrency (1/4) =48 jobs.
- Provider/local parity: <=12 partií ×2 profily =24 běhů.
- Globální ceiling: 50 miliard requested uzlů a 24 souhrnných CPU hodin,
  platí první dosažený. Všechny fáze, retries i audit se počítají.
- Běžný jednotlivý run: 200M uzlů a 600s watchdog; bezpečnostní překročení je
  censored výsledek, nikoli úsporně dokončený job. Menší policy budget je řádný konec.

Po každé fázi spočítat zbývající náklad z naměřených uzlů/CPU na pozici a z
explicitního job seznamu. Další fázi nevydat, pokud se nevejde do zbývajícího
ceilingu. Měřit requested rezervace před dispatch a skutečnou spotřebu po návratu;
Stockfish může node limit nepatrně překročit, přebytek se rovněž vykáže.
Watchdog nezaručuje dokončení celého vzorku. Pokud globální limit nestačí,
reportovat neúplnost a nový návrh, ne automaticky rozšířit běh.
Externí placený účet/projekt a dollar limit nejsou zatím určeny; hosted běhy
nespouštět bez vyřešení těchto konkrétních údajů a navazujícího zadání.

## 10. Vyhodnocení a výběr

Výstup je Pareto porovnání serverové ceny, dostupnosti momentů, falešného přijetí
a chyb gradingu. Zvlášť vs Thorough, Single a nejlepší jednoduchá varianta.
Žádný souhrnný score, který schová falešné odmítnutí odpovědi za více momentů.

Před P3 zamknout nejvýše dva cíle: jediný serverový vítěz a případně jednodušší
homepage varianta. Draft tolerancí pro shortlist (návrh před měřením, ne záruka):
- >=25 % nižší produktový CPU náklad než B2, bez zvýšení namodelovaného celkového
  serverového nákladu v žádném ze scénářů využití; není-li billing známý, jen CPU závěr.
- Zachovat >=90 % B2 auditně nevyvrácených momentů a >=95 % jeho pozitivních
  partií s použitelným momentem. Uvést raw counts a náhrady zvlášť; baseline
  nevyvrácený neznamená prokázaně užitečný. Referee recall reportovat samostatně.
- Chybné admission bodově <=5 % vzorku s rozhodnutou referencí, false rejection
  odpovědi <=1 %, false acceptance <=2 %. Je to návrh kompromisu, ne požadavek
  na nulové chyby. Nízké počty nebo mnoho nevyřešených referencí = neprůkazné.
- Dostupnost rozhodnutého gradingu na společném workloadu se nezhorší o >2 p.b.
  v rámci téhož limitu. Nezamaskovat chyby jako častější pending/timeout.

Uvést intervaly nejistoty a account-cluster bootstrap, paired cost rozdíly
po partiích a účty i ratingy samostatně. Pro weighted audit používat inclusion
probabilities; targeted adjudication odděleně. Denominátor false rejection je
počet auditně GOOD odpovědí, false acceptance počet auditně BELOW odpovědí;
navíc reportovat chyby mezi vydanými verdikty. Nezaměňovat tyto míry.
Vedle rozhodnuté podmnožiny uvést unknown podíl a rozpětí výsledku, pokud by
nevyřešené případy dopadly nejlépe/nejhůře. Nulový nález není důkaz <1 % rizika.

Rozpor vyvolá rozbor konkrétního důvodu, nikoli automatický plošný návrat ke
všem starým gates. Úspora času 10s dosažená dalšími jádry sama nesplňuje
ekonomický cíl. Pokud jednoduchý E0/E1 není materiálně horší, dát mu přednost
před složitější heuristikou. Když nikdo nevyhoví, uvést křivku kompromisů;
automaticky neměnit produkci ani prahy po holdoutu.

## 11. Implementační pořadí a review před prvním spuštěním

1. **Manifest a konfigurace:** typed schema, exact-key validace, normalizované
   resolved snapshots všech politik, hash a katalog profilů. Neznámý parametr
   nesmí být ignorován. Dry-run pouze vypíše joby a horní limity, nic neimportuje
   z engine klienta a nenačítá credentials. Současný study.json je draft vstup,
   runner jej zatím neumí vykonat.
2. **Čisté admission projekce:** oddělit point semantics od support evaluatoru,
   implementovat POINT/WINDOW/SUPPORTED, přímý a parent-child původ skóre,
   detailní gate reasons. Neměnit grading jako vedlejší efekt.
3. **Plánovač a cost ledger:** scan-first/paired/adaptive, reuse, rozpočty,
   checkpoint a completion. Baseline INTERLEAVED dostupná pouze pro měření,
   ne jako legacy compatibility větev v cílovém produktu.
4. **Čistý kontrakt a roundtrip:** admission vs grading, validátory, builder,
   server/browser storage, načtení a pokus. Neobcházet v4 validátor jen pro
   hezčí výtěžnost experimentu. Nový kontrakt se implementuje a ověří před
   tvrzením, že nové emise jsou použitelné momenty.
5. **Lab:** načíst konfiguraci přes existující quality lab, materializovat
   jobs/corpus, omezené reference, answer workload, CPU accounting a report.
   Nepřebírat top-level automaticky běžící smyčku `live.ts` jako veřejné API.
6. **Review a technické ověření:** nezávislé CR změn kontraktu/plánovače a CR
   metodiky před měřením; focused fixtures a canonical `pnpm check`, relevantní
   queue/browser parity a checkpoint lanes podle změněných souborů.
7. **Teprve po zadání ke spuštění:** uzavřít corpus, runtime a budget, P0,
   P1, případně P2, zamknout P3, následné bounded grading/hosted/parity běhy.
   Žádné automatické nasazení vítěze z benchmark runneru.

Povinné technické případy: jedna platná scan dvojice může přijmout POINT při
strict UNKNOWN; grading tím nesmí začít odmítat neznámé tahy. Neplatná historie,
perspektiva, bound-only score a ilegální PV neprojdou žádným režimem. Totéž
uložené evidence dává deterministický admission výsledek. Splněný admission
nezpůsobí další povinné potvrzení v builderu. Retry neobnoví game allowance.
Stop/cancel nepřipíše pozdní výsledek jiné pozici. Připravená známá odpověď
nepotřebuje nový search. Neúspěšný pokus/engine má náklad a explicitní stav.

## 12. Co bude možné převzít bez dalšího produktového rozhodování

Potvrzené: ekonomika background serveru je hlavní, homepage zvlášť; jedno
sdílené jádro; samostatný admission a grading; přiměřená chybovost, žádný hon
za nulovou nejistotou; zachování zaplacených dat; bez backward compatibility.

Technické doplnění před skutečným během: 14 dalších účtů a náhradní roster,
frozen PGN manifest, implementované strategie a kontrakt, přesný měřicí runtime,
CPU měření a případný hosted projekt/tarif/dollar ceiling. Doporučené tolerance
jsou v návrhu konkrétní; lze je upravit před zamknutím, ne až podle holdoutu.
V tuto chvíli není potřeba další abstraktní produktové schvalování.
