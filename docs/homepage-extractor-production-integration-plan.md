# Integrace homepage a společného extraktoru do produkce

Stav: integrace implementována a přezkoumána, 2026-09-06. Výsledky a postup
vydání zachycuje `homepage-extractor-integration-verification.md`.

## Cíl a výchozí stav

Jedno analytické jádro pro homepage, osobní browser/server analýzu a Master.
Homepage používá strategii hledání prvního puzzle a menší výpočetní profil;
pravidla potvrzení chyby a hodnocení odpovědí zůstávají společná.
Dokončení znamená ověřenou sloučenou verzi na produkční doméně z přesného
commitu větve `main`, funkční databázi, engine, queue a dostupná nová cvičení.

- Extraktor: `/Users/adam/.codex/worktrees/5790/backranq`, detached HEAD
  `873912414c5498fa1c94e575ed9847884cad190b`, rozsáhlé lokální změny.
- Homepage: `/Users/adam/dev/backranq`, `main` na stejném SHA, samostatné lokální
  změny v landing UI, onboarding finderu, stavu, kontraktech a testech.
- Soubory `PersonalGameScan.tsx`, `scanPreview.ts` a jejich testy jsou také
  součástí přenosu, přestože jsou dosud untracked.
- Oba výsledky byly testovány samostatně. Tyto výsledky nenahrazují nové
  ověření integrace. Aktuální vzdálený `main`, produkční SHA, nastavení Vercelu
  a stav sdílené DB je nutné ověřit při realizaci; nejsou zde deklarované jako známé.

## 1. Zachytit a bezpečně sjednotit oba vstupy

1. Před editací znovu zjistit stav obou tasků/checkoutů, upstream a rozdíly.
   Zabránit souběžnému přepisování přenášených souborů; pracovat s přesným
   seznamem a obsahem změn, nikoli se zastaralým patch souborem.
2. Připravit lokální integrační větev v tomto worktree. Zachovat oba původní
   vstupy včetně relevantních nových souborů a kontrolních hashů.
3. Přenést homepage změny selektivně. Ručně sloučit překryv
   `tests/lib/personal-puzzle-finder.test.ts`; zachovat nový Practice kontrakt
   v `candidatePrompt.ts`, warmup i hodnocení osobních odpovědí.
4. Nepřidávat `ideas.md`, lokální tajemství, build výstupy ani nesouvisející
   artefakty. Auditní důkazy vybírat vědomě; nerevertovat ostatní worktrees.

Výstup: reprodukovatelný integrovaný diff s doloženým původem obou částí.

## 2. Sjednotit orchestrace nad jedním jádrem

- Explicitní strategie `FULL_GAME` a `FIRST_PUZZLE`; výpočetní profil je
  samostatný. Runtime browser/server nemění šachovou policy.
- Připravený kontext partie obsahuje kanonický replay, historii, zdrojovou
  identitu a omezeně uchovanou scan evidenci. Parsování a scan se neopakují
  pro každého ověřovaného kandidáta.
- Odstranit současný problém: samostatné `VERIFY` znovu prochází scan smyčku,
  zatímco její cache nepřežívá jednotlivá volání.
- Sdílet interní přípravu/scan/potvrzení, nikoli dvě implementace rozhodování.
  Potvrzení zůstává čerstvé, párované a vázané na správný kontext a profil.
- `FULL_GAME` zachová všechny relevantní kandidáty, timeline, receipts a
  serverové checkpointy. Kontext po resume musí odpovídat zdroji a konfiguraci.
- `FIRST_PUZZLE`: nejnovější partie → jeden scan → seřazení jejích kandidátů →
  cílená potvrzení → první vhodné puzzle; starší partie až při neúspěchu.
- Menší rozpočet dovoluje nedořešený případ a pokračování v hledání, nikoli
  mírnější důkaz správnosti. Partial výstup nikdy není full-game completion.
- Zrušení běhu zastaví práci enginu a zabrání pozdnímu předání starého výsledku.
  Paměťový kontext se uvolní po dokončení/změně hry/zrušení.

Výstup: jedna pipeline, žádný opakovaný scan při potvrzování kandidátů,
zachované vlastnosti plné analýzy i Practice.

## 3. Připojit homepage prezentaci a sjednotit předání

- Typované události průběhu ponesou identitu běhu, hry, fázi, rozhodnutí a
  kanonickou pozici. UI nebude udržovat druhý nezávislý výklad PGN.
- Převzít výběr nejnovější partie, metadata, orientaci, pauzu přehrávání,
  reduced-motion a ochranu před pozdní odpovědí staršího hledání či warmupu.
- Tempo vykreslování oddělit od rychlosti enginu; nehromadit animace.
  Potvrzování drží pozici kandidáta, neposouvá šachovnici po interní PV.
- Zajistit plynulé předání stejné FEN a orientace do hratelného puzzle bez
  probliknutí/layout shiftu; odstranit příčinu remountu nebo ověřit vizuálně
  rovnocenné řešení. Nejde pouze o snížení animationDuration.
- Zachovat nové evidence DTO, známé odpovědi, lokální dopočet nepokrytého tahu
  a neutrální výsledek při nedostatku evidence i ve veřejném hráči.

## 4. Dvě kola code review

První kolo po funkční integraci, druhé po opravách nad výsledným diffem.
Review musí zahrnout celou dodávanou změnu proti společnému základu, ne jen
poslední integrační patch. Rozdělit nezávislé posouzení na:

1. Šachové jádro, identity kontextu, cache, čerstvost potvrzení, režimy,
   úplnost/částečnost a serverový resume.
2. Homepage/Practice: souběh, rušení, engine lifecycle, předání, unknown-move
   grading, offline pokusy a viditelné opravy hodnocení.
3. Persistence a release: zdrojové/revision identity, idempotence, RLS,
   migrace, staré checkpointy/fronty, obnova obsahu a pořadí nasazení.

Každý nález musí mít soubor/místo, dopad, opravu nebo doložené vypořádání a
relevantní regresní ověření. Opravné změny znovu přezkoumat. Podmínkou vydání
je žádný otevřený blokující nález; ostatní omezení musí být explicitně popsaná.

## 5. Integrované ověření

- Stejná evidence + policy → stejný grading v obou strategiích. Levnější
  homepage nemusí najít stejné množství momentů jako Thorough.
- Počítat skutečné engine požadavky: běžný scan N+1 kontextů, následné ověření
  bez nového průchodu scanem, potvrzovací hledání zůstávají samostatná.
- Nejnovější použitelná hra vyhraje; starší se otevře až po vyčerpání kandidátů.
  Ověřit empty/error, deadline, invalid PGN, setup/Black, terminální pozice,
  částečné pokrytí a tier-only nejistotu.
- Real Stockfish browser/server parity a obě strategie na stejných fixtures;
  změny hashů vysvětlit, nezaměnit změnu rozpočtu za porušení parity.
- Chromium desktop/mobile: hledání → scan → potvrzení → puzzle → známá a
  neznámá odpověď, změna identity za běhu, pauza, reduced-motion, navigace,
  pozdní warmup, offline/retry. Vizuálně ověřit přechod šachovnice.
- PostgreSQL: extractor → save API → DB → Practice → idempotentní pokus,
  reanalýza/revize, refinement, queue fencing/resume a Progress.
- Migrace ověřit na čisté DB i na izolovaném schématu před změnou s testovacími
  starými cvičeními. Ověřit přesný rozsah mazání, zachování zdrojových partií
  a Master snapshots, RLS a shodu s Prisma.

Povinné příkazy podle aktuálního package.json/CI:

- `pnpm check`
- `pnpm check:queue-runtime-bundle` a `pnpm check:queue-runtime-callback`
- `pnpm audit:prod`
- `pnpm db:migrate:deploy`, `pnpm check:db-contract`,
  `pnpm check:schema-shape` a migration shadow diff na izolované DB
- PostgreSQL integrační suite s oběma CI přepínači; explicitně přidat nový
  `extraction-practice-postgres.integration.test.ts`, který aktuální explicitní
  seznam v quality workflow ještě neobsahuje
- `pnpm smoke:stockfish-browser`, skutečný server Stockfish test
- `pnpm test:e2e` a `pnpm test:e2e:coach-offline:built`

Testy, které jen byly přeskočené nebo dříve prošly na samostatných částech,
nepočítat jako ověření integračního commitu. Po změně zdrojového základu
ověřit výsledný kandidát znovu v odpovídajícím rozsahu.

## 6. Připravit vydání a integrovat do main

1. Vydávaný diff rozdělit do srozumitelných commitů; CR a CI vztáhnout k jejich
   přesnému výslednému SHA. Případný PR nemá nahrazovat nezávislé CR.
2. Před aktualizací vzdáleného `main` zjistit produkční Vercel projekt, doménu,
   aktuální nasazené SHA, produkční větev, automatické build/deploy spouštění,
   blokování na CI a dostupnost oprávnění. Nevycházet jen z lokálního linku.
3. Vyřešit pořadí migrace a aktivace ještě před merge/push: automatické nasazení
   nesmí předběhnout DB ani review. Zvolit mechanismus podle ověřených možností
   hostingu; nepřidávat produktové flags, kompatibilitu nebo canary.
4. Prověřit běžící staré analysis/Master úlohy a checkpointy. Pro krátký přechod
   přes nekompatibilní kontrakt je dokončit nebo přesně zneplatnit/zrušit se
   správným vyrovnáním rezervací; starý worker nesmí zapisovat do nového schématu.
   Případné pozastavení plánování musí mít doložené obnovení.
5. Integrovat pouze zamýšlenou práci do `main`, zachovat nesouvisející lokální
   změny kanonického checkoutu. Ověřit vzdálené `main` a finální SHA.

## 7. Migrace, produkční aktivace a obnova obsahu

- Připravit produkční build přesného ověřeného `main` SHA. Nikdy nenasadit nebo
  nepromovat artefakt z feature větve jako produkci.
- Ověřit redigovanou identitu cílové DB a stav migrací. Build migrace nespouští.
  Aplikovat `pnpm db:migrate:deploy` jako samostatný řízený krok; na chybě nebo
  timeoutu nepokračovat k aktivaci nekompatibilní aplikace.
- Nová migrace odstraní starý training graph a Master publikace/kandidáty/
  receipts. Zdrojové partie a snapshots zůstanou. Neprovádět plošný reset DB.
- Aktivovat nový build z `main`, ověřit schéma a obnovit pozastavené plánování.
- Obnovit cvičení ze zachovaných zdrojů přes aktuální pipeline. Připravit předem
  přesně omezený a opakovatelný postup pro existující osobní partie i Master
  publikace; zahrnout explicitní reanalýzu již analyzovaných partií a ověřit
  dopad na kredity. Auto fronta sama vybírá neanalyzované hry a toto neopraví.
- Po destruktivní změně kontraktu není prostý rollback starého webu bezpečný.
  Při problému preferovat opravu dopředu z `main`; každá obnova staré verze
  vyžaduje také odpovídající schéma a obsah. Postup rozhodnout před migrací.

## 8. Podmínky skutečného dokončení

- Produkční doména obsluhuje doložené finální SHA z `main`; Vercel production
  branch zůstává `main`. Ověřit před i po vydání.
- Readiness/health, DB a migrace jsou v pořádku; queue callback a skutečný
  serverový analysis job doběhnou. Žádné nové nevysvětlené runtime chyby.
- Na nasazeném browser enginu projde homepage hledání a řešení puzzle,
  osobní analýza/save/Practice a lokální dopočet; použít vyhrazený testovací
  účet/partii, nikoli pustit destruktivní E2E harness proti produkční DB.
- Ověřit dostupnost nových osobních i veřejných cvičení a konzistenci pokusů.
- Zapsat výsledky obou CR kol, přesné testovací příkazy, migrace, zdrojovou
  větev/SHA, deployment ID/URL a výsledek produkčních smoke kontrol.

Úplné pokrytí všech legálních odpovědí ani zapnutí reziduálního experimentu
není podmínkou této integrace. Částečné pokrytí musí zůstat pravdivé a jeho
lokální fallback funkční. Tento plán nepřidává redesign odměn ani kompletní
generování dlouhých kombinací.
