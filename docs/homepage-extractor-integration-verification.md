# Ověření integrace homepage a extraktoru

2026-09-06. Společný výchozí commit: `873912414c5498fa1c94e575ed9847884cad190b`.
Tento záznam dokládá lokální implementaci a kontroly před vydáním. Produkční
SHA, deployment ID a smoke výsledky se zapisují samostatně do release reportu;
zelené lokální kontroly samy nejsou záznamem nasazení.

## Výsledek

- Jedno jádro s `FULL_GAME` a `FIRST_PUZZLE`, samostatnými rozpočty a stejnou
  grading policy. Homepage prochází nejnovější hry, skenuje hru jednou a pak
  potvrzuje její kandidáty podle priority; starší hra až při neúspěchu.
- Čerstvé párované potvrzení zůstává oddělené od scan reuse. Dva sousední scan
  výsledky se zachovávají také při opakovaných serverových checkpointech.
- Homepage vykresluje kanonické události extraktoru bez dalšího replay PGN.
  Stejná instance šachovnice přechází do puzzle. Pauza a reduced-motion jsou
  prezentační; nové mobilní hledání posune šachovnici do viewportu.
- U neznámých odpovědí zůstává pravdivé částečné pokrytí a lokální dopočet.
  Reziduální experiment nebyl zapnutý jako výchozí režim.

## Nezávislé review a opravy

První kolo pokrylo celé původní změny proti společnému základu i integrační
diff: šachové jádro, frontend/Practice, persistence, Master a release.
Druhé kolo a následná opakovaná kontrola oprav neobsahovaly otevřený blokující nález.

- Nové serverové checkpointy odmítala čtečka vyžadující odstraněné pole:
  nahrazena sdílenou validací a testem skutečného yield/JSON/resume.
- Po chybějícím engine výsledku zůstával kontext starší chyby soupeře:
  resetuje se, regresní testy pokrývají oba režimy.
- Pozdní chyba refinementu mohla ukončit engine nového puzzle: generační
  ochrana, ověřeno skutečnými React hooks v Chromium při řízeném souběhu.
- Lokální vyhodnocení hlubšího rozhodnutí mohlo přepsat root review:
  kontexty jsou oddělené a regresně ověřené.
- Master přijímal starý nebo nesouhlasící vnořený config: obě vstupní místa
  validují aktuální snapshot, hash i kanonické options.
- Master ukládal kandidáty a receipt samostatně: nyní jedna transakce po
  výpočtu, zámek zdrojového snapshotu a idempotentní reuse dokončeného výsledku.
- Master mohl uložit complete receipt s chybami extrakce: nový výsledek i
  reuse používají společný full-completion validator.
- Vizuální kontrola odhalila mobilní viewport pod šachovnicí: opraveno pro
  explicitně zahájené hledání a znovu nezávisle přezkoumáno i vizuálně ověřeno.

## Lokální důkazy

- Finální `pnpm check`: lint, TypeScript, **1465 testů / 229 souborů**,
  produkční build a všechny klientské bundle limity. 35 opt-in/live testů
  přeskočeno; nejsou počítané jako úspěšné.
- Celá authenticated E2E sada: **73 prošlo, 5 přeskočeno**. Po poslední
  mobilní změně samostatně opakována homepage/mobile sada a vizuální kontrola.
- Finální Coach/offline sada: **19 prošlo, 1 přeskočeno**. První lokální i CI
  běh odhalil dva testy s nelegálním tahem simulovaného enginu; fixture nyní
  vybírá legální tahy podle skutečné pozice a ověřuje instalaci simulace.
  Produkční validace nebyla oslabena. Oba scénáře i celá sada znovu prošly.
- Browser/server audit dvou celých partií: **20 shodných momentů**, stejné
  solution hashes, odpovědi, tiery, skóre a best lines; **366 hledání** na každém
  runtime. Naměřené latence vznikaly pod proměnlivou lokální zátěží a nejsou
  produkčním výkonovým příslibem.
- Reálný FIRST_PUZZLE test: 94 půltahů, přesně 95 scan požadavků, po dvou
  nedostupných potvrzeních nalezen další platný moment bez nového scanu.
- Browser Stockfish protocol/cancellation smoke a compiled Queue callback
  se skutečným serverovým Stockfishem prošly. Dependency audit bez známých
  zranitelností.
- PostgreSQL suite: 17 testů prošlo v prvním běhu; scale test překročil 5s
  mez při souběžné zátěži (7,45s). Izolované opakování všech tří Progress
  testů prošlo beze změny limitu či implementace.
- Nový skutečný PostgreSQL Master test: receipt trigger vyvolal pád po dvou
  insertech kandidátů; rollback zanechal nulu kandidátů/receipts. Retry uspěl,
  další opakování zachovalo identitu i celou evidenci původního výsledku.
- Všech 46 migrací na čisté DB; RLS/privileges pro 58 aplikačních tabulek,
  shoda 830 sloupců s Prisma a nulový migration shadow diff.
- Upgrade z 45 migrací s daty v 15 tabulkách: osm zdrojových/historických
  tabulek zachováno, sedm tabulek starého training/public graphu vyčištěno.
- Desktop/mobile vizuální kontrola: stejný DOM, FEN, orientace a bounding box,
  žádný overflow/page error; skutečný nejlepší tah správně vyhodnocen.

Nové opt-in regresní testy jsou explicitně připojené k odpovídajícím CI lanes:
FIRST_PUZZLE k server Stockfish, souběh React session k Chromium,
extractor→Practice a Master transakce k PostgreSQL integraci.

## Release podmínky zjištěné při přípravě

- Vercel projekt `backranq.xyz`, produkční větev `main`, výchozí nasazené SHA
  `873912414c5498fa1c94e575ed9847884cad190b`; Git deploy automaticky zapnutý.
- Supabase `backranq-prod` (`ftjblndngplzagbjmxsh`): při inventuře nula osobních
  partií/momentů/AnalysisJob, 108 Master snapshots a nula publikací. Inventuru
  zopakovat těsně před migrací; ověřit, že neběží starý worker.
- Produkční přihlašovací hodnoty označené jako sensitive nelze exportovat
  z Vercelu. Přípustná alternativní cesta migrace je autorizované Supabase
  připojení: přesné commitnuté SQL a registrace jeho SHA256 v Prisma historii
  v jedné transakci, s kontrolou celé dosavadní historie a finálního schématu.
  Tajemství se neobchází ani nevypisují.
- Master obsah obnovovat cílenými ANALYSIS runy na zachované zdroje, se
  stabilními idempotency keys. Obecná fronta opakovaných ANALYSIS běhů není
  náhradou, protože vybírá omezený počet nejnovějších zdrojů.
- Veřejné puzzle se nesmí vynutit obejitím kvalitativních gates. Osobní
  reanalýza není při nulovém inventáři potřebná; při změně inventáře použít
  stávající explicitní serverovou reanalýzu včetně standardních kreditů.
- Před aktivací domény musí být úspěšné CR/CI, produkční build z přesného
  `main` SHA a migrace. Po aktivaci ověřit doménu, větev/SHA, schéma, queue,
  homepage i skutečné odpovědi v Practice. Běžné nastavení deploy obnovit.
