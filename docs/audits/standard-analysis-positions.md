# Pozice pro lidské posouzení standardní analýzy

SHA `873912414c5498fa1c94e575ed9847884cad190b`, verzovaný corpus. Jde o pracovní hodnoticí karty, nikoli lidsky schválený seznam správných puzzle. Všechny reálné pozice v tomto malém vzorku mají White na tahu; černá strana, terminální pravidla a setup jsou navíc pokryté izolovanými testy.

Před přečtením engine odpovědí si zapište vlastní nejlepší nápad a alternativy. U každé karty zvažte: je původní tah skutečná chyba pro účel osobního tréninku; jaké tahy by měly projít; je motiv srozumitelný; pomáhá samotná volba, nebo chybí pokračování? Výsledek označte užitečná / nejistá / příliš snadná / zavádějící a stručně zdůvodněte. Rozhodnutí o přijetí mimořádně širokých nebo tierově nejistých pozic není automaticky dáno enginem.

## Karta 1: chesscom, decision ply 46

Původní tah: **c4+**. FEN: `8/1p4pp/p7/3kPp2/8/1P3N2/2P2PPP/1b3K2 w - - 2 24`

```text
   +------------------------+
 8 | .  .  .  .  .  .  .  . |
 7 | .  p  .  .  .  .  p  p |
 6 | p  .  .  .  .  .  .  . |
 5 | .  .  .  k  P  p  .  . |
 4 | .  .  .  .  .  .  .  . |
 3 | .  P  .  .  .  N  .  . |
 2 | .  .  P  .  .  P  P  P |
 1 | .  b  .  .  .  K  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 2: chesscom, decision ply 50

Původní tah: **Nd4+**. FEN: `8/1p4pp/p3k3/4Pp2/2P5/1P3N2/b3KPPP/8 w - - 3 26`

```text
   +------------------------+
 8 | .  .  .  .  .  .  .  . |
 7 | .  p  .  .  .  .  p  p |
 6 | p  .  .  .  k  .  .  . |
 5 | .  .  .  .  P  p  .  . |
 4 | .  .  P  .  .  .  .  . |
 3 | .  P  .  .  .  N  .  . |
 2 | b  .  .  .  K  P  P  P |
 1 | .  .  .  .  .  .  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 3: chesscom, decision ply 54

Původní tah: **g3**. FEN: `8/1p5p/p5p1/4kp2/2PN4/1P1K4/b4PPP/8 w - - 0 28`

```text
   +------------------------+
 8 | .  .  .  .  .  .  .  . |
 7 | .  p  .  .  .  .  .  p |
 6 | p  .  .  .  .  .  p  . |
 5 | .  .  .  .  k  p  .  . |
 4 | .  .  P  N  .  .  .  . |
 3 | .  P  .  K  .  .  .  . |
 2 | b  .  .  .  .  P  P  P |
 1 | .  .  .  .  .  .  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 4: chesscom, decision ply 64

Původní tah: **b4+**. FEN: `8/1p5p/p5p1/2k2p2/2PN1P2/1PK3P1/7P/1b6 w - - 5 33`

```text
   +------------------------+
 8 | .  .  .  .  .  .  .  . |
 7 | .  p  .  .  .  .  .  p |
 6 | p  .  .  .  .  .  p  . |
 5 | .  .  k  .  .  p  .  . |
 4 | .  .  P  N  .  P  .  . |
 3 | .  P  K  .  .  .  P  . |
 2 | .  .  .  .  .  .  .  P |
 1 | .  b  .  .  .  .  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 5: chesscom, decision ply 84

Původní tah: **Ng5**. FEN: `8/1p3N2/p7/2Pk1p1p/1P3P2/4K3/7P/5b2 w - - 0 43`

```text
   +------------------------+
 8 | .  .  .  .  .  .  .  . |
 7 | .  p  .  .  .  N  .  . |
 6 | p  .  .  .  .  .  .  . |
 5 | .  .  P  k  .  p  .  p |
 4 | .  P  .  .  .  P  .  . |
 3 | .  .  .  .  K  .  .  . |
 2 | .  .  .  .  .  .  .  P |
 1 | .  .  .  .  .  b  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 6: chesscom, decision ply 8

Původní tah: **e5**. FEN: `rnbqkb1r/ppp3pp/3ppn2/5pB1/3PP3/2N5/PPP2PPP/R2QKBNR w KQkq - 0 5`

```text
   +------------------------+
 8 | r  n  b  q  k  b  .  r |
 7 | p  p  p  .  .  .  p  p |
 6 | .  .  .  p  p  n  .  . |
 5 | .  .  .  .  .  p  B  . |
 4 | .  .  .  P  P  .  .  . |
 3 | .  .  N  .  .  .  .  . |
 2 | P  P  P  .  .  P  P  P |
 1 | R  .  .  Q  K  B  N  R |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 7: lichess, decision ply 20

Původní tah: **Bg3**. FEN: `r1b1kb1r/pp1n1p2/2p1p2p/q2p2pn/3P3B/P1NBPN2/1PP2PPP/R2Q1RK1 w kq - 0 11`

```text
   +------------------------+
 8 | r  .  b  .  k  b  .  r |
 7 | p  p  .  n  .  p  .  . |
 6 | .  .  p  .  p  .  .  p |
 5 | q  .  .  p  .  .  p  n |
 4 | .  .  .  P  .  .  .  B |
 3 | P  .  N  B  P  N  .  . |
 2 | .  P  P  .  .  P  P  P |
 1 | R  .  .  Q  .  R  K  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 8: lichess, decision ply 44

Původní tah: **Ng3**. FEN: `2kr4/pp2bpr1/2pq1n1p/3pNR2/3P4/P1P1PQ2/1P2N1P1/5RK1 w - - 1 23`

```text
   +------------------------+
 8 | .  .  k  r  .  .  .  . |
 7 | p  p  .  .  b  p  r  . |
 6 | .  .  p  q  .  n  .  p |
 5 | .  .  .  p  N  R  .  . |
 4 | .  .  .  P  .  .  .  . |
 3 | P  .  P  .  P  Q  .  . |
 2 | .  P  .  .  N  .  P  . |
 1 | .  .  .  .  .  R  K  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Karta 9: lichess, decision ply 54

Původní tah: **Nf7**. FEN: `2k5/pp2b3/2pq1p1p/3pN2R/3P4/P1P1P3/1P4K1/5R2 w - - 0 28`

```text
   +------------------------+
 8 | .  .  k  .  .  .  .  . |
 7 | p  p  .  .  b  .  .  . |
 6 | .  .  p  q  .  p  .  p |
 5 | .  .  .  p  N  .  .  R |
 4 | .  .  .  P  .  .  .  . |
 3 | P  .  P  .  P  .  .  . |
 2 | .  P  .  .  .  .  K  . |
 1 | .  .  .  .  .  R  .  . |
   +------------------------+
     a  b  c  d  e  f  g  h
```

Vlastní návrh: __________  Alternativy: __________  Výuková hodnota a důvod: __________

## Engine podklady k porovnání vlastního úsudku

Loss je z uloženého original-decision měření; nejde o materiálovou ztrátu ani absolutní pravdu. Accepted množiny nejsou lidské labely. Standard používá100k verifier a200k confirmation; reference400k/800k. Dva průchody mohou změnit tier, membership i evidence.

| Karta | STANDARD cp loss | Stav | Accepted SAN | Reference cp loss | Stav | Accepted SAN |
| --- | ---: | --- | --- | ---: | --- | --- |
| 1 | 218 | trainable VERIFIED/STABLE | Ne1 | 239 | trainable VERIFIED/STABLE | Ne1 |
| 2 | 234 | vyřazeno AMBIGUOUS/OPEN | Kd3, g3, Ke3, Nd2, h4, Kd2 | 282 | vyřazeno AMBIGUOUS/OPEN | Kd3, Kd2, g3, Nd2 |
| 3 | 269 | trainable VERIFIED/STABLE | Nf3+ | 300 | trainable VERIFIED/STABLE | Nf3+ |
| 4 | 100 | vyřazeno AMBIGUOUS/OPEN | Ne6+, Nf3 | 102 | vyřazeno VERIFIED/STABLE | Ne6+, Nf3, h4, b4+, h3 |
| 5 | 267 | vyřazeno AMBIGUOUS/OPEN | Nd8, Nd6, Kf2, Kd2, h4, Ne5 | 288 | vyřazeno AMBIGUOUS/OPEN | Nd8, Nd6, Kf2, Kd2, h4 |
| 6 | 85 | vyřazeno AMBIGUOUS/OPEN | exf5, Nf3, Bd3, h4, Nh3, f4, Bc4, Be2, Qe2, a3, a4, Bb5+, d5, Bh4, Qf3, g3 | 81 | vyřazeno AMBIGUOUS/OPEN | exf5, Bd3, Nf3, h4, Nh3, Be2, f4, Qd3, Qe2, e5, Qf3, Bb5+, a3, Bxf6, Bc4, g3 |
| 7 | 33 | vyřazeno AMBIGUOUS/OPEN | Ne5, Ne1, g4, Bg3, Nd2, b4 | 38 | vyřazeno VERIFIED/STABLE | Ne5, Ne1, g4, Bg3, Nd2, b4 |
| 8 | 445 | trainable VERIFIED/STABLE | Rxf6 | 451 | trainable VERIFIED/STABLE | Rxf6 |
| 9 | 160 | trainable VERIFIED/STABLE | Rxh6, Ng6, Nd3, Ng4, Nf3 | 179 | vyřazeno AMBIGUOUS/OPEN | Rxh6, Ng6, Nd3 |

Karty2 a5 mají uvnitř reference shodné membership400k→800k, ale změněné tiery. Karty4 a7 reference odmítne jako cvičení proto, že přijímá původní tah. Karta9 ukazuje nestabilní hranici, ne automaticky falešně přijaté či odmítnuté odpovědi. Podrobné UCI snapshots a diagnostika jsou v hlavní zprávě a raw artefaktech.
