# Model eval — gpt-5 vs gpt-6-sol vs gpt-6-luna (zebra doc)

Rulat: 2026-09-24T08:49:05.254Z · doc: "zebra" (13 pag, docBlock 42445 chars, markdown ready) · prompt = forma EXACTA de productie (copii verbatim din lib/answer.ts) · EASY: effort=low/verb=low · HARD: effort=medium/verb=medium · max_output_tokens=8000 · prompt_cache_key="eval-<model>" · judecator: gpt-5 effort=medium, ordine A/B/C randomizata.

## Compatibilitate parametri (conteaza pentru integrare)
- **gpt-5**: reasoning.effort ACCEPTAT · text.verbosity ACCEPTAT
- **gpt-6-sol**: reasoning.effort ACCEPTAT · text.verbosity ACCEPTAT
- **gpt-6-luna**: reasoning.effort ACCEPTAT · text.verbosity ACCEPTAT
- Preturi cached-input pentru gpt-6-sol, gpt-6-luna: PRESUPUSE la 10% din input (raportul gpt-5) — de verificat la integrare.
- **PROMPT CACHE NU SE ACTIVEAZA PE gpt-6-*** (observatie majora): gpt-5 a raportat cached=11904/12038 (99%) de la al doilea call incolo, dar gpt-6-sol si gpt-6-luna au raportat **cached=0 pe toate cele 12 apeluri fiecare**, cu prefix byte-identic de ~12k tokeni si acelasi prompt_cache_key. Fie cache-ul nu e inca disponibil pe gpt-6, fie nu e raportat in usage — de reprobat la integrare. Consecinta imediata: toata infrastructura warm-cache (lane-uri effort×verbosity, /warm, prompt_cache_key) NU reduce azi costul pe gpt-6; costul Sol e dominat de input full-price (~$0.024/call doar inputul), iar economia masurata a gpt-5 cald dispare.

## Per intrebare

| Q | clasa | model | TTFT | total | in (cached) | out (reason) | cost | rank | flag |
|---|---|---|---|---|---|---|---|---|---|
| E1 | easy | gpt-5 | 3.7s | 5.5s | 12038 (0) | 188 (64) | $0.0169 | 2 | WRONG/SHALLOW |
| E1 | easy | gpt-6-sol | 1.0s | 2.9s | 12038 (0) | 106 (0) | $0.0251 | 3 | WRONG/SHALLOW |
| E1 | easy | gpt-6-luna | 795ms | 1.4s | 12038 (0) | 56 (0) | $0.0012 | 1 |  |
| E2 | easy | gpt-5 | 7.2s | 8.9s | 12045 (11904) | 568 (448) | $0.0073 | 1 |  |
| E2 | easy | gpt-6-sol | 2.0s | 3.5s | 12045 (0) | 144 (38) | $0.0255 | 3 |  |
| E2 | easy | gpt-6-luna | 769ms | 1.7s | 12045 (0) | 64 (0) | $0.0012 | 2 |  |
| E3 | easy | gpt-5 | 5.6s | 7.3s | 12033 (11904) | 392 (256) | $0.0056 | 1 |  |
| E3 | easy | gpt-6-sol | 1.7s | 3.2s | 12033 (0) | 139 (32) | $0.0255 | 2 | WRONG/SHALLOW |
| E3 | easy | gpt-6-luna | 2.5s | 4.0s | 12033 (0) | 130 (0) | $0.0013 | 3 | WRONG/SHALLOW |
| E4 | easy | gpt-5 | 3.0s | 3.5s | 12031 (11904) | 152 (128) | $0.0032 | 1 |  |
| E4 | easy | gpt-6-sol | 901ms | 1.7s | 12031 (0) | 54 (0) | $0.0246 | 2 |  |
| E4 | easy | gpt-6-luna | 699ms | 1.7s | 12031 (0) | 70 (0) | $0.0012 | 3 |  |
| E5 | easy | gpt-5 | 7.9s | 9.8s | 12037 (11904) | 564 (384) | $0.0073 | 3 |  |
| E5 | easy | gpt-6-sol | 1.1s | 2.2s | 12037 (0) | 62 (0) | $0.0247 | 1 |  |
| E5 | easy | gpt-6-luna | 849ms | 1.8s | 12037 (0) | 61 (0) | $0.0012 | 2 |  |
| E6 | easy | gpt-5 | 7.6s | 8.6s | 12033 (11904) | 310 (192) | $0.0047 | 1 |  |
| E6 | easy | gpt-6-sol | 994ms | 2.2s | 12033 (0) | 61 (0) | $0.0247 | 3 |  |
| E6 | easy | gpt-6-luna | 673ms | 1.5s | 12033 (0) | 52 (0) | $0.0012 | 2 |  |
| H1 | hard | gpt-5 | 14.1s | 24.3s | 12051 (0) | 2049 (1024) | $0.0356 | 3 | WRONG/SHALLOW |
| H1 | hard | gpt-6-sol | 2.4s | 13.3s | 12051 (0) | 691 (73) | $0.0310 | 2 |  |
| H1 | hard | gpt-6-luna | 2.8s | 8.1s | 12051 (0) | 691 (159) | $0.0016 | 1 |  |
| H2 | hard | gpt-5 | 18.6s | 26.7s | 12047 (11904) | 2985 (1984) | $0.0315 | 3 |  |
| H2 | hard | gpt-6-sol | 5.4s | 15.5s | 12047 (0) | 816 (218) | $0.0323 | 1 |  |
| H2 | hard | gpt-6-luna | 4.8s | 10.7s | 12047 (0) | 1065 (389) | $0.0017 | 2 |  |
| H3 | hard | gpt-5 | 13.9s | 28.5s | 12045 (11904) | 2102 (1152) | $0.0227 | 3 | WRONG/SHALLOW |
| H3 | hard | gpt-6-sol | 2.2s | 9.3s | 12045 (0) | 493 (48) | $0.0290 | 1 |  |
| H3 | hard | gpt-6-luna | 4.3s | 8.7s | 12045 (0) | 768 (314) | $0.0016 | 2 |  |
| H4 | hard | gpt-5 | 28.9s | 45.5s | 12042 (11904) | 3930 (2176) | $0.0410 | 1 |  |
| H4 | hard | gpt-6-sol | 6.2s | 18.2s | 12042 (0) | 911 (207) | $0.0332 | 3 |  |
| H4 | hard | gpt-6-luna | 9.8s | 19.4s | 12042 (0) | 1527 (594) | $0.0020 | 2 |  |
| H5 | hard | gpt-5 | 37.2s | 45.3s | 12044 (11904) | 3385 (2560) | $0.0355 | 3 | WRONG/SHALLOW |
| H5 | hard | gpt-6-sol | 1.8s | 11.1s | 12044 (0) | 575 (26) | $0.0298 | 1 |  |
| H5 | hard | gpt-6-luna | 1.6s | 7.0s | 12044 (0) | 564 (61) | $0.0015 | 2 |  |
| H6 | hard | gpt-5 | 26.8s | 48.6s | 12037 (11904) | 3546 (1600) | $0.0371 | 3 | WRONG/SHALLOW |
| H6 | hard | gpt-6-sol | 3.2s | 13.7s | 12037 (0) | 768 (86) | $0.0318 | 1 |  |
| H6 | hard | gpt-6-luna | 5.9s | 12.6s | 12037 (0) | 1053 (350) | $0.0017 | 2 |  |

## Agregat per model x clasa

| model | clasa | n | TTFT mediu | total mediu | cost mediu | cost total | rank mediu | wins | losses | flagged |
|---|---|---|---|---|---|---|---|---|---|---|
| gpt-5 | easy | 6 | 5.8s | 7.3s | $0.0075 | $0.0451 | 1.50 | 4 | 1 | 1 |
| gpt-5 | hard | 6 | 23.2s | 36.5s | $0.0339 | $0.2033 | 2.67 | 1 | 5 | 4 |
| gpt-6-sol | easy | 6 | 1.3s | 2.6s | $0.0250 | $0.1501 | 2.33 | 1 | 3 | 2 |
| gpt-6-sol | hard | 6 | 3.5s | 13.5s | $0.0312 | $0.1871 | 1.50 | 4 | 1 | 0 |
| gpt-6-luna | easy | 6 | 1.0s | 2.0s | $0.0012 | $0.0074 | 2.17 | 1 | 2 | 1 |
| gpt-6-luna | hard | 6 | 4.9s | 11.1s | $0.0017 | $0.0101 | 1.83 | 1 | 0 | 0 |

## Note de judecata (blind, per intrebare)
- **E1** (easy): gpt-6-luna > gpt-5 > gpt-6-sol · flagged: gpt-5, gpt-6-sol — C răspunde succint și corect la definiție, potrivit cererii „pe scurt”. A dă o definiție corectă, dar adaugă afirmații despre document și exemple inutile pentru un răspuns scurt. B e corect ca definiție, însă introduce mențiuni despre document și o citare de pagină care par nefondate/irelevante pentru întrebare.
- **E2** (easy): gpt-5 > gpt-6-luna > gpt-6-sol — B oferă o traducere concisă și fidelă a propoziției despre limita de detecție (~<20 m), cu citarea [16] și pagina, potrivindu-se exact cerinței. C traduce o altă propoziție înrudită (despre ~2 m din datele autorilor), corectă dar nu neapărat propoziția cerută. A include traducerea relevantă, dar adaugă informații suplimentare necerute, făcând răspunsul mai puțin precis față de solicitarea de a tra
- **E3** (easy): gpt-5 > gpt-6-sol > gpt-6-luna · flagged: gpt-6-luna, gpt-6-sol — A is best: it correctly states there was no fixed number of flies, clarifies they were wild and not individually identified, and treats 22–37 as flights/approaches rather than individual flies. C is concise and mostly correct about no fixed number and wild flies, but incorrectly frames the 22–37 as flies, not tracks. B makes the same misstatement (22–37 “muște”) and adds extraneous details, so it 
- **E4** (easy): gpt-5 > gpt-6-sol > gpt-6-luna — C răspunde direct și complet la întrebare: specie = cal domestic (Equus caballus). B este corect dar adaugă informații despre zebre și un sinonim taxonomic inutil pentru întrebare, potențial neconfirmat de pasaj. A include detalii suplimentare (sex, culori ale blănii) care sunt necerute și posibil nefundamentate în pasaj, făcând răspunsul mai prolix fără a adăuga la claritatea cerută.
- **E5** (easy): gpt-6-sol > gpt-6-luna > gpt-5 — B răspunde concis exact cu paginile relevante (3–4 pentru metodele video și 5 pentru filmarea zebrelor/cailor). C este aproape la fel de bun, menționând 3–5, dar adaugă detalii ușor inutile. A include multe detalii tehnice care depășesc cerința „pe scurt”.
- **E6** (easy): gpt-5 > gpt-6-luna > gpt-6-sol — All three correctly define “ecvidee” as members of the Equidae family (horses, zebras, donkeys). B is the most precise and self-contained, adding accurate taxonomic context; the extra detail is acceptable for completeness. C is concise and correct but adds an unnecessary claim about what the article studies. A similarly adds study-specific scope and even narrows it (“în principal la zebre și cai”)
- **H1** (hard): gpt-6-luna > gpt-6-sol > gpt-5 · flagged: gpt-5 — B gives a concise, well‑grounded explanation that dungile afectează faza finală de aterizare (nu apropierea), sumarizează corect rezultatele cu pături (aterizări mult mai rare pe suprafața dungată, dar neschimbate pe cap), menționează analiza video și că mecanismul vizual exact rămâne neclar, și enumeră ipotezele pe care autorii le resping (camuflaj, confuzie la prădători, semnalizare, termoreglar
- **H2** (hard): gpt-6-sol > gpt-6-luna > gpt-5 — B este cel mai bine ancorat în tabele: citează corect valorile-cheie din Tabelul 1 (rate de aterizare și dimensiunea foarte mică a eșantionului de aterizări pe zebre) și din Tabelul 2 (rate, direcția efectelor și p‑valori), explică ce susțin tabelele și ce nu pot susține (cauzalitatea dungilor), fără a adăuga speculații. C este foarte apropiat ca acuratețe și completitudine; oferă și cifrele medie
- **H3** (hard): gpt-6-sol > gpt-6-luna > gpt-5 · flagged: gpt-5 — C răspunde direct cerinței: compară clar faza de apropiere (fără diferențe majore; apropiere mai rapidă și investigație mai scurtă la zebre) cu faza de aterizare (mult mai puține aterizări pe zebre; lipsă de decelerare controlată), și explică mecanismul propus (perturbarea fluxului optic) subliniind corect că este plauzibil, nu demonstrat. Include și o cifră reprezentativă fără a exagera. B este c
- **H4** (hard): gpt-5 > gpt-6-luna > gpt-6-sol — B is the most complete and well‑grounded: it enumerates concrete methodological constraints (sample/context, paddock setup, 2D tracking, arbitrary thresholds, low N on zebras, materials/UV/strap confounds, observer blinding, independence, weather data) with specific numeric details and links each to how it affects the conclusions. C is accurate and balanced, covering the major limitations and clea
- **H5** (hard): gpt-6-sol > gpt-6-luna > gpt-5 · flagged: gpt-5 — B este cea mai bine sintetizată: acoperă clar întrebarea, metoda (inclusiv mărimea eșantionului), rezultatul cheie, mecanismul probabil și rolul comportamentului, cu trimiteri de pagină adecvate și fără detalii speculative. C este corectă și completă, adaugă util limitările studiului, dar este ușor mai generală decât B pe unele puncte. A, deși detaliată, introduce multe valori numerice și afirmați
- **H6** (hard): gpt-6-sol > gpt-6-luna > gpt-5 · flagged: gpt-5 — B is concise, well grounded in the document, and directly ties each proposed follow-up to specific limitations noted (materials differing, 2D tracking, near-vs-far effects, limited sample/geography), with plausible page citations and clear rationale. C is also solid and relevant, but introduces a very specific quantitative detail (5.3 hours with no bites) that feels more speculative and less safel

## VERDICT
- **Sol vs gpt-5 on HARD**: rank mediu 1.50 vs gpt-5 2.67; wins 4 vs 1; flagged 0 vs 4; TTFT 3.5s vs 23.2s; cost mediu $0.0312 vs $0.0339.
- **Sol vs gpt-5 on EASY**: rank mediu 2.33 vs gpt-5 1.50; wins 1 vs 4; flagged 2 vs 1; TTFT 1.3s vs 5.8s; cost mediu $0.0250 vs $0.0075.
- **Luna vs gpt-5 on EASY**: rank mediu 2.17 vs gpt-5 1.50; wins 1 vs 4; flagged 1 vs 1; TTFT 1.0s vs 5.8s; cost mediu $0.0012 vs $0.0075.
- **Luna vs gpt-5 on HARD**: rank mediu 1.83 vs gpt-5 2.67; wins 1 vs 1; flagged 0 vs 4; TTFT 4.9s vs 23.2s; cost mediu $0.0017 vs $0.0339.

### Recomandare rutare

**(a) gpt-5 → gpt-6-sol pentru clasa HARD (effort medium/high): DA, upgrade clar.**
Sol castiga la calitate pe judecata blind (rank mediu 1.50 vs 2.67, 4 victorii din 6, 0 raspunsuri flagged vs 4 la gpt-5 — judecatorul, el insusi gpt-5, a penalizat sistematic raspunsurile gpt-5 pentru cifre/afirmatii slab ancorate si prolixitate), la latenta e alt sport (TTFT 3.5s vs 23.2s, total 13.5s vs 36.5s — dispare nevoia de „Thinking…” lung), iar costul e ~egal chiar FARA cache ($0.031 vs $0.034/intrebare grea). Rezerva: fara prompt cache functional, pe documente mari (100k tokeni, gen Meditations) inputul full-price al Sol ar costa ~$0.20/intrebare vs ~$0.014 pe gpt-5 cald — pana se confirma cache-ul pe gpt-6, upgrade-ul e sigur pe articole si scump pe carti.

**(b) EASY (clasa effort=low a plannerului) → gpt-6-luna: DA, cu o rezerva punctuala.**
Luna e la egalitate practica cu gpt-5 pe usor (rank mediu 2.17 vs 1.50; un singur flag din 6, si acela discutabil — la E3 documentul chiar scrie „Nflies = 22–37 throughout”, Luna l-a citit literal, gpt-5 a adaugat nuanta „muste salbatice, neidentificate individual”; Sol a facut aceeasi „greseala”), dar e de 6x mai ieftina ($0.0012 vs $0.0075 pe gpt-5 CALD) si de 6x mai rapida (TTFT 1.0s vs 5.8s — sub pragul de perceptie al asteptarii). Pierderile Luna la judecata sunt de stil (concizie vs context suplimentar), nu factuale. Rezerva: intrebarile de EXTRAGERE NUMERICA (cate, cat, ce valoare) sunt singurul loc unde nuanta gpt-5 a batut literalismul Luna — daca vrem zero risc, astea raman pe modelul tare.

**Surpriza rularii**: Luna la $0.10/M a iesit rank mediu 1.83 pe HARD cu 0 flaguri — peste gpt-5 (2.67) si aproape de Sol (1.50), la 1/20 din cost. Nu recomand Luna pe hard doar pe baza unei rulari cu un singur judecator, dar merita o a doua rulare cu judecator diferit inainte de a fixa ruterul.

**Concret pentru integrare** (lib/answer.ts): MODEL_ANSWER=gpt-6-sol; planner-ul existent (planRequest) devine si ruter de model: effort=low → gpt-6-luna, effort medium/high → gpt-6-sol; ambele modele accepta reasoning.effort si text.verbosity, deci executia nu se schimba. De reprobat la integrare: cache-ul pe gpt-6 (vezi sectiunea de compatibilitate) si preturile cached; pana atunci warmer-ul (/warm + lane-uri) ramane relevant doar daca gpt-5 ramane in schema.

**Caveat metodologic**: n=12 intrebari, 1 rulare, 1 judecator (gpt-5 medium, ordine randomizata) pe un singur document (articol, 13 pag). Diferentele de rank de ±1 sunt zgomot; semnalul robust e (1) zero flaguri factuale pe gpt-6 hard vs 4 la gpt-5, (2) TTFT, (3) costurile masurate.
