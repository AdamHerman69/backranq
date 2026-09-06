# Směr extrakce Practice po produktovém upřesnění

Zapsáno 2026-09-05 nad auditem SHA `873912414c5498fa1c94e575ed9847884cad190b`.
Jde o schválený směr a návrh architektury, nikoli implementaci nebo schválení
konkrétních numerických prahů. Doplňuje [audit](standard-analysis-audit.md).
Sdílený backlog je výhradně `/Users/adam/dev/backranq/ideas.md`.

Navazující ucelený návrh:
[Extrakce osobních tréninkových momentů](../standard-analysis-extraction-design.md).
Tento dokument zachovává produktová upřesnění; navazující návrh rozepisuje fáze,
kontrakty, rozpočty a implementační ověření.

## Co uživatel upřesnil

1. Nyní řešíme extrakci užitečných momentů. Binární „úspěch“, animace a odměny
   nejsou předpokladem datového modelu ani vstupní podmínkou extrakce. Lze
   evidovat kvalitu tahu, ztrátu vůči nejlepšímu a zlepšení proti původní partii.
2. Potvrzená chyba se nemá ztratit kvůli změně její přesné závažnosti, tieru
   odpovědi, pořadí alternativ nebo hranice vzdálených přijatelných odpovědí.
   Potřebujeme spolehlivou chybu a lepší alternativu, ne neměnný úplný seznam.
3. Výpočet musí být přiměřeně levný. Předpočítat spolehlivé jádro dobrých a
   špatných tahů; další mohou zůstat neznámé a vyhodnotit se lokálně při otevření
   puzzle nebo po zahrání. Neznámé není synonymum špatného.
   Následné upřesnění: cílit na ekonomické pokrytí všech opravdu dobrých odpovědí,
   aby tah bez vlastního uloženého skóre mohl dostat okamžité negativní či
   nižší hodnocení, pokud jeho nižší kvalitu dostatečně dokládá ověřená hranice
   pokrytí. Přesnou závažnost lze dopočítat. To je jiné než vůbec nevědět,
   zda je tah dobrý. Četnost takových uživatelských tahů zatím není změřena.
4. Prioritizovat záchranu remízy, ztrátu výhody a jasné taktické chyby. Praktické
   lekce ve vyhraných/prohraných pozicích nevylučovat, ale nevybírat jen podle cp.
5. Oddělení jednoho rozhodnutí a celé kombinace potřebuje samostatný
   architektonický návrh. Následující detaily jsou návrh, ne hotové rozhodnutí
   o konkrétní délce kombinace nebo požadavcích všech režimů.

## Vstupní podmínka pro osobní moment

Navržená minimální evidence:

- platná zdrojová pozice, historie, strana hráče a původní legální tah;
- spolehlivě doložené zhoršení původním tahem podle zvolené srovnávací policy;
- alespoň jedna spolehlivě lepší alternativa, která obstojí při cíleném ověření;
- uložené výsledky a provenance obou stran porovnání, včetně nejistoty;
- výukový důvod/priorita oddělené od měřeného skóre a pokrytí dalších tahů.

Původní tah je povinným negativním příkladem pro moment označený jako náprava
chyby; nepotřebujeme umělou kvótu dalších špatných tahů. Pokud se srovnáním ukáže,
že původní tah je rovnocenný kvalitní alternativě, nebyla potvrzena podstata
tohoto cvičení. To je jiný případ než změna jeho odhadované loss z 250 na 220 cp.

Změna šesté/sedmé alternativy nebo GOOD/STRONG není veto celého momentu.
Dotčená odpověď může zůstat hraniční či nevyhodnocená. Pokud se naopak zásadně
obrací kvalita původního tahu nebo jediné opory řešení, je nutné cílené nové
ověření. Takový rozpor může vzniknout chybou orchestrace i horizontem omezeného
search; samotný nesouhlas enginu není důkaz konkrétní implementační chyby.

## Navržené vrstvy

| Vrstva | Odpovědnost | Na čem nesmí záviset |
| --- | --- | --- |
| SourceDecision | PGN hash, decision ply, FEN, history-aware context, strana a původní tah. | Engine scores nebo UI hodnocení. |
| DecisionEvidenceRevision | Best/played comparison, exact outcomes, WDL/cp, dosažený budget a stabilita závěru o chybě. | Uzavření všech alternativ. |
| MoveAssessmentIndex | Pro každý prozkoumaný tah evidence, loss vůči best, zlepšení proti původnímu tahu, stav jistoty a odvozený tier. | Domněnka, že všechny ostatní tahy jsou špatné. |
| TrainingMoment | Odkaz na potvrzené rozhodnutí, známé dobré/špatné příklady, výuková metadata a pokrytí odpovědí. | Binární úspěch nebo hotová kombinace pro každou větev. |
| ContinuationGraph | Kontextové uzly, soupeřovy odpovědi, další uživatelská rozhodnutí a jejich vlastní evidence. | Pevná představa, že celá PV je ověřený tréninkový strom. |
| Orchestrace | Rozpočty a prioritizace pro full scan, homepage, otevřené puzzle a zahraný tah. | Vlastní odlišná pravidla kvality/gradingu. |

Pozorování, zda tah patří do spolehlivého jádra, musí vycházet ze srovnávací
evidence, ne pouze z pořadí MultiPV. Počet prozkoumaných odpovědí je resource
limit. Vyčerpání legálních tahů lze zaznamenat, ale není nutné pro přijetí
každého osobního momentu. U příbuzných kvalitních tahů nesmí z libovolného
pořadí vznikat protichůdné hodnocení.

### Pokrytí pro okamžitou zpětnou vazbu

Rozlišovat explicitně tři stavy informace:

| Dostupný důkaz | Co lze říci okamžitě | Co ještě může chybět |
| --- | --- | --- |
| Vlastní spolehlivé hodnocení tahu | Doložená kvalita včetně známého tieru/metrik. | Podrobnější vysvětlení či continuation. |
| Dostatečně ověřená hranice pokrývá kvalitní tahy; tento tah je vně | Pouze doložený závěr, že tah je pod touto kvalitativní hranicí. | Jeho přesná závažnost, tier a zlepšení proti původní chybě. |
| Neúplné pokrytí bez vlastního hodnocení | Kvalitu dosud neznáme. | Samotné zařazení i přesné metriky; žádný automatický negativní verdikt. |

Druhý stav nepotřebuje detailní score každého špatného tahu. Potřebuje ale
důvěryhodnou completeness a grading boundary evidence: několik uložených top
tahů nebo dosažení MultiPV capu nestačí. Shoda tierů všech dobrých odpovědí není
nutná. Hraniční cluster lze ponechat širší/nejistý, ale okamžitý negativní závěr
se smí týkat jen prokazatelně pokryté oblasti; nejlepší neznamená jediný dobrý.
Pro engine evidence jde o definovanou úroveň ověření, ne matematickou jistotu.

Tento stav připravenosti pro okamžité hodnocení musí být oddělený od přijetí
momentu. Jinak bychom plošnou podmínkou úplného pokrytí znovu zavedli původní
blokování extrakce. Pokrytí může doplnit bounded práce při otevření pozice;
bez něj se konkrétní neznámý tah vyhodnotí před negativní zpětnou vazbou.

U ostrých pozic s několika jedinými kvalitními tahy může být pokrytí levné.
V auditovaném vzorku však byly i pozice se 16 přijatelnými odpověďmi při capu16.
Četnost širokých pozic ve finálním výběru ani četnost uživatelem zahraných
neprozkoumaných tahů z tohoto malého neoznačeného vzorku nelze odvodit.

## Rozpočet a doplňování hodnocení

1. **Scan:** levně vytipovat rozhodnutí. Uchovat reuse evidence a skutečné
   pokrytí hry; scout není kompletní analýza.
2. **Potvrzení momentu:** cíleně porovnat původní tah a nejsilnější alternativu
   či malé jádro alternativ. Přidat budget při rozporu podstatném pro toto
   rozhodnutí, ne kvůli vzdálenému pořadí nebo samotnému tieru.
3. **Předání:** uložit připravený moment s částečně známými odpověďmi a explicitním
   stavem jejich evidence. Nenechat dnešní complete-set validator odmítat nový
   význam; nový kontrakt musí projít celou cestou až po pokusy.
4. **Otevření puzzle:** prewarm lokální engine; případné předpočítání má vlastní
   malý rozpočet a lze ho zrušit. Není potřeba slepě dopočítávat všechny tahy.
5. **Zahraný tah:** známé spolehlivé hodnocení lze použít okamžitě; neznámý nebo
   hraniční tah dostane prioritu před background prací. Porovnat kompatibilní
   evidence (POV, model, pravidlová historie, root/submitted rozpočet). V případě
   potřeby obnovit i reference score; nepředstírat přesnost porovnáním slabého
   child search s nesouvisejícím silným root search.
6. **Vyčerpání budgetu:** evidovat nejistotu. Způsob následného zobrazení a dopad
   na odměny/statistiky jsou samostatná prezentace; jádro nesmí vyrobit falešný
   negativní verdikt jen proto, že nemá data.

Výchozí search lze držet levný a deterministický; dodatečné potvrzení má být
adaptivní. Fresh versus reused evidence musí být dohledatelná. „Dva průchody“
neznamenají automaticky dvě nezávislá potvrzení ani požadavek vždy mazat hash.
Konkrétní budgets a hranice jádra potřebují kalibraci, nikoli produktový odhad
počtu nodes od stolu.

## Rozhodnutí a kombinace

Root decision může být připravený, zatímco continuation má jiný stav.
Rozlišit alespoň:

- **Vysvětlující větev:** legální engine line či doložené vyvrácení ukazované
  v rozboru, s evidencí jeho síly; není automaticky graded cvičením.
- **Ověřená tréninková větev:** každý další požadovaný uživatelský tah má vlastní
  decision context a připravené hodnocení, včetně významu odpovědí soupeře.
- **Dosud neověřené pokračování:** lze doplnit později; nepoškodí důkaz root
  chyby, ale nesmí se vydávat za ověřenou kombinaci.

Kombinace má končit podle doložené šachové pointy a typu úlohy, s tvrdým resource
stropem. Samotné dosažení maxPlies není důkaz dovysvětlení taktiky. Zahrání jiné
dobré odpovědi může vést k jiné větvi; nelze ji nutit do PV původního bestmove.
Je třeba rozhodnout, kdy nabídnout další rozhodnutí a kdy skončit rozborem;
zde zatím není schválený konkrétní UX ani univerzální počet tahů.

## Co musí změna prokázat

- C50/C84 z auditu: tier-only změna nevyřadí potvrzený root moment; nejistota
  přesné známky se zachová.
- L54: změna hraničních alternativ se nepřeklopí v tvrzení, že jejich nečlenství
  v částečném indexu dokazuje chybu. O původním Nf7 a stabilní lepší alternativě
  rozhoduje vlastní evidence.
- Negativní kontroly C64/L20: pokud původní tah obstojí jako kvalitní odpověď,
  nepublikovat ho jako prokázanou chybu pouze kvůli dřívějšímu scanu.
- Tentýž kontext/tah má stejné významy v extrakci, uložené revision, dodatečném
  hodnocení a serverovém zápisu pokusu. Nezavádět klientský dynamický verdikt,
  který server současným kontraktem zahodí.
- Neúspěch rozšířené continuation nesmaže root evidence. Současně se neověřená
  větev nesmí hodnotit jako hotová kombinace.
- Měřit fyzická hledání, reuse, čas k prvnímu spolehlivému momentu, počet
  hraničních odpovědí a latenci skutečně zahraného tahu. Nárůst počtu momentů
  bez kontroly nesprávných hodnocení není sám úspěch.

Otevřené kalibrační otázky: společná cp/WDL/exact outcome comparison policy,
bezpečný odstup pro spolehlivé jádro, confidence/stability kritérium bez
falešného tvrzení o statistických intervalech, budgets na konkrétních zařízeních
a chess endpoint pravidla pro kombinace. Binární úspěch, tiery v UI a animace
nemusejí jejich vyřešení blokovat.
