# Deploying AURA to Render (free plan)

AURA's server runs as **one free Render web service** (`render.yaml`, built from `Dockerfile.render`):
- the Node backend is the public HTTPS API the phone talks to;
- the Python AI service runs inside the same container on a private port (not reachable from the internet).

How the free plan's limits are handled:

| Free-plan limit | What AURA does |
|---|---|
| Sleeps after 15 minutes without requests, ~1 minute to wake | An uptime monitor calls `/health` every 10 minutes. The app also starts waking the server when it opens and when "Hey Aura" is heard, and says "the server may be waking up" instead of hanging. |
| Free hours cover one service all month | Backend and AI service share one service. |
| No permanent disk | The learned models (`ai-service/app/data`) are copied to a private Supabase Storage bucket (`aura-ai-data`, created automatically) every 3 minutes and at shutdown, and restored at start (`DATA_SYNC=supabase`). |
| 512 MB memory | Measured: the AI service uses about 175 MB after loading; the backend roughly 70-100 MB. |

Render does not charge for free services. AI answers still use your OpenRouter credit.

## 1. Before you start
- **Rotate your API keys** if they were ever shared (Supabase service-role, OpenRouter, Gemini, SerpAPI), and use only the new ones below.
- Add credit to OpenRouter.

## 2. Create the service
1. Sign in at render.com with GitHub and allow access to the `AURA` repo.
2. **New -> Blueprint** -> select the repo -> it reads `render.yaml`.
3. Fill the values it asks for: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `SERPAPI_API_KEY`.
4. **Apply**. The first build takes several minutes. When it shows **Live**, open `https://<name>.onrender.com/health`: it should show `"status":"ok"` and `"pythonAi":"ok"`.

## 3. Keep it awake
In UptimeRobot (free) or cron-job.org: add an HTTP monitor for `https://<name>.onrender.com/health`, every 10 minutes (5 also works).

## 4. Point the phone app at it
The server address is built into the app:

```bash
cd aura-web
# PowerShell:  $env:VITE_API_URL="https://<name>.onrender.com"; npm run build
VITE_API_URL=https://<name>.onrender.com npm run build
npx cap sync android
```
Then build the APK (debug for your phone, `./gradlew assembleRelease` for sharing). For a release build, remove the home-Wi-Fi IP from `android/app/src/main/res/xml/network_security_config.xml`.

## 5. Updating
Every push to `main` redeploys automatically (a deploy restarts the server: expect about a minute of "waking up").

## Notes
- If a deploy fails or the service restarts in a loop, the service's **Logs** tab says why (usually a missing value, or running out of memory).
- Running locally is unchanged: `docker-compose.yml` still starts the backend and AI service as two containers.
- Paid alternative (no sleeping, real disk): change `plan: free` to `plan: starter` and remove `DATA_SYNC`.
