Implementace schváleného návrhu extrakce — 2026-09-06

Výchozí revize: `873912414c5498fa1c94e575ed9847884cad190b`.
Rozsah odpovídá `standard-analysis-extraction-design.md`: společná extrakce,
browser/server engine, persistence, předání do Practice a historie pokusů.
Změny jsou lokální; tento dokument není záznam nasazení.

- Přijetí momentu vyžaduje potvrzenou chybu původního tahu a doloženou lepší
  odpověď. Nejistý tier nebo vzdálená alternativa samy moment nezruší.
  Potvrzení chyby, pokrytí odpovědí a připravenost pokračování jsou samostatné.
- Kandidát používá stejnou kvalitativní policy jako Practice. Cp a skutečná
  párovaná WDL evidence se nezaměňují; mat a přesné koncové výsledky mají
  samostatné srovnání. Nasycené pozice potřebují další praktický důvod.
- Scan používá kanonický chess.js replay, kontext včetně historie a explicitní
  reuse sousední pozice. Potvrzení používá nová párovaná hledání s doloženým
  scope, budgetem a fyzickou identitou. Povinné pravidlové konce předcházejí
  engine práci; claimovatelná remíza se nezaměňuje s povinným koncem hry.
- Uložený známý tah se hodnotí podle doložených metrik. Tah bez individuálního
  skóre dostane okamžitý obecný verdikt pouze v přesně doloženém pokrytém
  scope. Absence v MultiPV seznamu nestačí. Jinak běží omezené lokální
  přehodnocení proti nové kompatibilní referenci.
- Lokální důkazy mají původ `CLIENT_EVALUATED`. Mohou doplnit nebo opravit
  osobní pokus, nikoli přepsat kanonické řešení. `RECORD` a následné `ENRICH`
  sdílejí jeden clientAttemptId; doplnění je samostatná neměnná evidence.
  Oprava mění viditelné hodnocení i značku tahu. Původní událost zůstává
  dohledatelná; refinement nepřidává další opakování do plánovače.
- Zdrojová identita nezahrnuje proměnlivé engine skóre. Revize uchovává původní
  srovnání a evidence. Stejný význam řešení s jiným fyzickým důkazem může mít
  novou revizi. Konfliktní opakování téhož analysis runu se odmítne atomicky.
  Offline pokusy používají skutečně zobrazenou historickou revizi.
- Nejistá nová analýza zachová dříve potvrzený moment při stejné konfiguraci.
  Nepřepíše jeho aktuální důkaz ani metriky; Progress jej nadále uznává.
  Archivaci způsobí explicitní negativní závěr, nikoli absence v novém seznamu.
- Pokračování má vlastní uzly s kontextem a důkazy. Neověřená vysvětlující PV
  nevytváří další hodnocený úkol. Selhání volitelného pokračování neruší root.
- Producer, save API, DTO a server queue používají aktuální společný extraction
  snapshot v3. Opraveny jsou setup PGN/Black ply, duplicitní MultiPV kořeny,
  legální vyčerpání variant, bounds a zrušení práce během startupu enginu.

`residualCoverage.ts` zůstává volitelným experimentem mimo výchozí pipeline.
Ve dvou skutečných pozicích nebyl levnější než zkoušené MultiPV rozšíření.
V taktické pozici podpořil CP mez pro 34 zbývajících tahů; v počáteční pozici
správně ponechal částečné pokrytí. Tento výsledek není WDL certifikát ani
důkaz kvality všech puzzle. Podrobnosti a raw artefakty zachovává runtime audit.

Finální `pnpm check` prošel bez lint/type chyb: 1 443 testů ve 225 souborech,
produkční build i limity klientských balíčků. Záměrně vypnuté provider/live a
opt-in testy nejsou započítány jako úspěšné. Samostatně prošlo 18 PostgreSQL
integračních testů včetně locking/parity a tisíceřádkového Progress scénáře.
Skutečný Stockfish prošel přes save API, izolovanou DB a Practice až po
idempotentní pokus i neutrální nehodnocené zahrání. Chromium ověřil 25 scénářů:
desktop/mobile, offline/nav retry, skutečný WASM pro neznámý tah, doplnění téhož
pokusu a fallback po dvou selháních workeru. Závěrečná úprava textu fallbacku
následně prošla celým check/buildem.

Na dvou celých auditních partiích (94 a 108 plies) byly finální server/browser
výstupy přesně shodné: 20 momentů, jejich solution hashes, odpovědi/tiery,
score/WDL/PV i scope hledání. Všech 40 výsledných kandidátů prošlo také
validátorem, source-PGN kontrolou a konstrukcí Practice DTO. Oba běhy použily
366 fyzických hledání a shodně hlásily 68 305 334 nodes; 204 scan hledání
odpovídá N+1 na každou partii. Server trval 65,3 s, browser 62,8 s na tomto
stroji. To není příslib latence jiných zařízení ani lidské kvality všech úloh.
Pokrytí všech 20 momentů zůstalo PARTIAL. Uložením verifier stromu pouze jednou
klesly payloady auditních partií přibližně z 1,37/1,20 MB na 0,86/0,77 MB se
zachováním všech důkazů a stejného sémantického hashe.

Migrace `20260905090000_decision_evidence_and_attempt_refinement` přidává nové
revision/evidence sloupce a tabulku doplnění pokusu s RLS. Podle pre-user
pravidel projektu odstraňuje starý training graph místo zachování nepravdivého
closed-set kontraktu. Zdrojové partie i Master snapshots zůstávají; osobní i veřejná cvičení
je nutné znovu extrahovat. Staré Master publikace/kandidáti/receipts se odstraní,
aby nemohly servírovat neplatný původní kontrakt. Celá migrační historie a výsledné schéma byly ověřeny na nové
izolované databázi. Sdílená ani nasazená databáze nebyla změněna.

Zbývající kalibrace: velikost počátečního seedu, reálný podíl tahů vyžadujících
lokální search, mobilní latence na reprezentativních zařízeních a lidské
posouzení praktické hodnoty. Materiální důsledek v omezené PV je výuková
heuristika, nikoli důkaz vynucené kombinace. Implementace nevydává empirickou
stabilitu za kalibrované procento jistoty.
