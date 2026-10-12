# Deploy pe Google Cloud Run — ghid pas cu pas (de la zero la link pentru prieteni)

Partea de cod e GATA și testată: imagine Docker (build standalone), `npm run deploy`, Gotenberg cu parolă, sesiuni de 400 de zile, izolare multi-user 13/13. Tu faci doar pașii cu conturi/chei de mai jos, în ordine.

---

## PASUL 1 — Supabase cloud (baza de date + login + fișiere) · ~10 min
1. Deschide [supabase.com](https://supabase.com) → **Start your project** → loghează-te cu GitHub/Google → **New project**:
   - Name: `read-deeper` · Database password: alege una și noteaz-o · Region: **Central EU (Frankfurt)**
2. Când proiectul e gata, mergi în **SQL Editor** (iconița din stânga) → **New query** → deschide pe laptop folderul `supabase/migrations/` și, PE RÂND, copiază conținutul fiecărui fișier (0001 → 0007), lipește-l și apasă **Run**. Șapte rulări, toate trebuie să zică „Success".
3. **Authentication → Sign In / Providers → Email** → dezactivează **„Allow new users to sign up"** → Save.
4. **Authentication → Sessions**: nu atinge nimic (default = sesiuni care se reînnoiesc singure; cookie-urile noastre țin ~400 de zile).
5. **Project Settings (rotița) → API** → ține pagina deschisă: îți trebuie `Project URL`, `anon public` și `service_role` (secret).

## PASUL 2 — Conturile celor 4 prieteni · 1 comandă
În PowerShell, în folderul proiectului (înlocuiește cu valorile de la 1.5):
```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="https://XXXX.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="eyJ...service_role..."
npx tsx scripts/provision-users.ts
```
Afișează cele 4 emailuri + parole (test1–test4@readdeeper.app). Le poți schimba oricând re-rulând scriptul.

## PASUL 3 — Google Cloud: cont, proiect, unelte · ~15 min (o singură dată)
1. [console.cloud.google.com](https://console.cloud.google.com) → loghează-te cu contul Google → acceptă termenii.
2. Sus, lângă sigla Google Cloud, apasă selectorul de proiect → **New project** → nume `read-deeper` → Create → selectează-l.
3. **Billing**: meniul ☰ → Billing → Link a billing account → adaugi cardul (free tier-ul acoperă testarea; plafonăm oricum instanțele).
4. Instalează **gcloud CLI** pe laptop: [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) → Windows installer → next-next-finish (bifează „Run gcloud init"). În fereastra care se deschide: loghează-te în browser, alege proiectul `read-deeper`, la regiune poți da Skip.
5. Verificare: deschide un PowerShell NOU și rulează `gcloud config get-value project` → trebuie să afișeze id-ul proiectului.

## PASUL 4 — Gotenberg (conversia Word→PDF), cu parolă · 1 comandă
Alege o parolă (ex. `Gtb-Secret-2026`) și rulează:
```powershell
gcloud run deploy gotenberg --image gotenberg/gotenberg:8 --region europe-west1 --allow-unauthenticated --memory 1Gi --max-instances 1 --args="--api-enable-basic-auth" --set-env-vars "GOTENBERG_API_BASIC_AUTH_USERNAME=rd,GOTENBERG_API_BASIC_AUTH_PASSWORD=Gtb-Secret-2026"
```
(prima comandă `gcloud run` te întreabă dacă activează API-urile — răspunde `y`). La final primești un URL `https://gotenberg-....run.app` — noteaz-l. „Allow unauthenticated" e OK: serviciul cere user+parolă prin basic auth.

## PASUL 5 — Valorile publice pentru build
Deschide fișierul `.env.production` din folderul proiectului (dacă nu există, creează-l) și pune în el valorile CLOUD (ambele sunt publice prin natura lor):
```
NEXT_PUBLIC_SUPABASE_URL=https://XXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...anon...
```

## PASUL 6 — Prima publicare a aplicației · 1 comandă, ~6 min
```powershell
npm run deploy
```
(build-ul se face în cloud; la întrebări răspunde `y`). La final: **Service URL: https://read-deeper-....run.app** — ăsta e link-ul aplicației.

## PASUL 7 — Cheile secrete (runtime) · 1 comandă
Completează și rulează (toate pe O singură linie; înlocuiește ce e între <>):
```powershell
gcloud run services update read-deeper --region europe-west1 --set-env-vars "NEXT_PUBLIC_SUPABASE_URL=https://XXXX.supabase.co,NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon>,SUPABASE_SERVICE_ROLE_KEY=<service_role>,OPENAI_API_KEY=<cheia-openai>,MODEL_ANSWER=gpt-5,MODEL_UTILITY=gpt-5-mini,MODEL_EMBEDDING=text-embedding-3-small,REASONING_EFFORT_ANSWER=medium,DOC_FULL_CONTEXT_MAX_TOKENS=150000,WEB_CLASSIFIER_TIMEOUT_MS=3000,GOTENBERG_URL=<url-gotenberg-de-la-pasul-4>,GOTENBERG_AUTH=rd:Gtb-Secret-2026,NEXT_PUBLIC_APP_URL=<url-aplicatiei-de-la-pasul-6>"
```
**NU seta niciodată în cloud**: DEV_AUTOLOGIN, DEV_USER_*, STRIPE_*.

## PASUL 8 — Smoke test · 2 min
1. Deschide URL-ul aplicației → pagina de login → intră cu `test1@readdeeper.app`.
2. Încarcă un PDF mic → highlight → întrebare → răspuns streamed.
3. Alt browser (sau incognito): `test2` → NU vede documentul lui test1.
4. Încarcă un .docx → după procesare trebuie să vezi PAGINI originale (Gotenberg funcționează).

## Update-uri viitoare
```powershell
npm run deploy
```
Atât — ~5 min, zero alte griji. Rollback: Cloud Console → Cloud Run → read-deeper → Revisions → alegi versiunea anterioară → „Manage traffic" 100%.

## De știut (setate deja în scriptul de deploy)
- `--no-cpu-throttling` = pregătirea AI din fundal la upload funcționează corect (obligatoriu pentru noi)
- `--max-instances 2` = plafon de siguranță la costuri; `--timeout 600` = cărțile mari intră lejer
- `--memory 2Gi` = extracția PDF-urilor mari cu multe figuri are nevoie de headroom (la 1Gi instanța se sufoca și documentul rămânea blocat pe „processing")
- Cold start ~3–8s la prima vizită după pauză (apoi cald); dacă vrei zero cold start: `gcloud run services update read-deeper --region europe-west1 --min-instances 1` (~$3–8/lună)
- Costul estimat al fazei de test: **~$0 pe infrastructură** + tokenii OpenAI (~$0.2–1/zi la utilizare activă)
