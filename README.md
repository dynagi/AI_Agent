# AURA AI — Monorepo

Personal AI decision-maker platform. See [AURA_AI_Claude_Complete_Build_Spec.md](AURA_AI_Claude_Complete_Build_Spec.md) for the full product spec.

## Structure

```
AI_Agent/
  aura-web/       Frontend (React + Vite today; migrate to React Native per spec)
  backend/        Node.js + TypeScript + Express + Supabase (public API boundary)
  ai-service/     Python + FastAPI (NVIDIA NIM LLM + Gemini voice, agent orchestration, external data providers)
  docker-compose.yml
  .env.example
```

## Architecture

```
Frontend  →  Node backend (:4000)  →  Supabase (auth/db/realtime)
                     |
                     v
          Python AI service (:8001, internal only)
                     |
             AURA Coordinator
                     |
      Travel / Finance / Productivity / Shopping /
      Research / Calendar / Wellness / Communication agents
                     |
      SerpAPI (shopping + flights + hotels) · arXiv (research)
```

- **Node backend** is the only public boundary. It proxies AI calls to the Python service and enforces auth via Supabase JWTs + Row Level Security.
- **Python AI service** is never exposed directly to the frontend — only reachable from the backend network.
- **LLMService** (`ai-service/app/services/llm_service.py`) abstracts the model provider. Default: **NVIDIA NIM** (`nvidia/nemotron-3-super-120b-a12b`); `GrokProvider` is available via `LLM_PROVIDER=grok`.
- **VoiceService** exists on both sides:
  - `backend/src/services/voice.ts` — `POST /voice/speak`
  - `ai-service/app/services/voice_service.py` — `POST /ai/voice/speak`
  - Default provider: **Gemini TTS** (`gemini-2.5-flash-preview-tts`). `ElevenLabsProvider` available via `VOICE_PROVIDER=elevenlabs`.
- **Shopping** — `ai-service/app/services/shopping_service.py` calls SerpAPI's Google Shopping engine, which aggregates real listings across many retailers in one call, and sorts results lowest-price-first. This is the realistic way to get genuine cross-platform comparison without individually approved retailer partnerships (Amazon PA-API, Flipkart Affiliate, etc. each require their own business approval).
- **Travel** — `ai-service/app/services/travel_service.py` uses SerpAPI's Google Flights + Google Hotels engines (same key as Shopping), sorted lowest-price-first. Amadeus's self-serve developer portal was decommissioned in July 2026; its replacement requires a business agreement, so it wasn't usable here.
- **Research** — `ai-service/app/services/research_service.py` queries the arXiv API (free, no key).
- **Google Calendar + Sign-In** — handled via Supabase Auth's Google OAuth provider on the frontend (`aura-web/src/services/auth.ts`, requests Calendar scopes). The Google access token from the Supabase session is forwarded to `backend/src/routes/calendar.ts` (`GET/POST /calendar/google/events`) via the `X-Google-Access-Token` header — the backend never stores Google credentials itself.
- **Finance & Wellness** stay on the generic Supabase-backed CRUD routes (`/finance`, `/wellness`) — no external price/transaction API is wired in yet (Finance needs a Plaid-equivalent with business approval; Wellness has no natural "compare price" API).

## Setup

```bash
cp .env.example .env
# fill in the keys below
```

Required for each capability:

| Capability | Env vars | Where to get them |
|---|---|---|
| LLM reasoning | `NVIDIA_API_KEY` | https://build.nvidia.com/ |
| Voice | `GEMINI_API_KEY` | https://aistudio.google.com/ |
| Shopping + Travel (flights/hotels) | `SERPAPI_API_KEY` (one key covers all three) | https://serpapi.com/ |
| Database/Auth | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | https://supabase.com/dashboard |
| Google Sign-In + Calendar | Configured in Supabase Dashboard → Authentication → Providers → Google (Client ID/Secret from Google Cloud Console) | https://console.cloud.google.com/ |

**Database schema**: run both files in Supabase Dashboard → SQL Editor (in order): [0001_init.sql](supabase/migrations/0001_init.sql) creates the typed domain tables with Row Level Security, and [0002_app_records.sql](supabase/migrations/0002_app_records.sql) creates `app_records`, the per-user store the web app uses for tasks, events, transactions, budgets, goals, memories, chats, decisions, wellness logs and more. **The app cannot save anything until 0002 is applied.**

Frontend also needs `aura-web/.env` (public values only — no secrets):
```bash
cp aura-web/.env.example aura-web/.env
# VITE_API_URL, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
```

### Run locally (no Docker)

Run each of these three in its own terminal — all three need to be up at once.

**1. AI service** (Python, port 8001):
```bash
cd ai-service
python -m venv .venv
./.venv/Scripts/pip install -r requirements.txt   # or .venv/bin/pip on macOS/Linux
./.venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8001
```
> Port 8000 is used as the default elsewhere (Docker, `.env.example`), but on Windows it's commonly reserved by Hyper-V's dynamic port range, which shows up as `[Errno 13] ... forbidden by its access permissions` when you try to bind it. If you hit that, run on a free port instead (8001 above), and set `PYTHON_AI_URL=http://localhost:8001` in the root `.env` to match. Check what's reserved with `netsh interface ipv4 show excludedportrange protocol=tcp` (PowerShell, admin).

**2. Backend** (Node, port 4000):
```bash
cd backend
npm install
npm run dev
```

**3. Frontend** (Vite, port 5173):
```bash
cd aura-web
npm install
npm run dev
```
Then open http://localhost:5173.

### Run with Docker

```bash
docker compose up --build
```

This builds and runs `ai-service` (port 8000 — fine inside its own container, since Windows port reservations only affect the host) and `backend` (port 4000), wired together on the compose network, with health checks gating startup order. The frontend isn't containerized yet; run it separately with step 3 above.

## API surface

Node (`backend/src`):
```
/health /chat /voice /decisions
/shopping (+ GET /shopping/search?q=..., GET /shopping/predictions, POST /shopping/events, POST /shopping/agent/step)
/travel (+ GET /travel/flights, GET /travel/hotels, GET /travel/predictions, POST /travel/events)
/research (+ GET /research/search?q=...)
/calendar (+ GET/POST /calendar/google/events, DELETE /calendar/google/events/:id)
/tasks /finance /wellness /memory /automations /integrations /notifications /approvals /agents
```

Python (`ai-service/app`):
```
/ai/health /ai/chat /ai/plan /ai/decide /ai/voice/speak
/ai/shopping/search /ai/research/search
/ai/shopping/predict /ai/shopping/events /ai/shopping/ask /ai/shopping/model /ai/shopping/demo-users /ai/shopping/browse/step
/ai/travel/flights /ai/travel/hotels /ai/travel/predict /ai/travel/events /ai/travel/ask /ai/travel/demo-users
```

## Data: nothing is mocked

The web app ships with **no sample data**. Every screen starts empty and fills from one of these sources:

| Area | Source |
|---|---|
| Tasks, Calendar events, Finance (transactions, budgets, goals), Memory, Wellness (plan, meals, daily stats, habits, metrics), Automations, Chat history, Decisions, Agent settings, cart/wishlist | Your own records, saved per user through `/records/:collection` (Supabase + RLS) |
| Google Calendar events | Google Calendar API, after Google sign-in (read-only in the UI) |
| Shopping prices | SerpAPI Google Shopping (India, ₹), cheapest first |
| Flights and hotels | SerpAPI Google Flights / Hotels (India, ₹), cheapest first |
| Research papers | arXiv API |
| Next-trip forecast (Travel Agent) | LightGBM model in `ai-service/models/travel`, run on your own `travel_events` records. Synthetic **demo users** (`USER_000123`-style ids) exist only for testing; disable with `TRAVEL_DEMO_ENABLED=false` |
| Next-purchase forecast (Shopping Agent) | LightGBM model in `ai-service/models/shopping`, run on your own `shopping_events` records and fine-tuned on them after each command. Demo users as above; disable with `SHOPPING_DEMO_ENABLED=false` |
| Chat, decisions, plans, summaries, spoken replies | NVIDIA NIM (LLM) and Gemini TTS through the backend |
| Weather (Home) | Open-Meteo, only after you allow location access |

Behavior worth knowing:
- **Nothing is executed on your behalf**, with one exception: a shopping command ("order milk from Zepto") makes the cart agent fill your cart on that store by itself. It stops at the cart; payment is not automated. Otherwise approvals are recorded (`approvals` table) but no provider integration books, buys or sends. AURA never claims an external action succeeded.
- **Automations** "run" by asking AURA to prepare the actions and logging them for review.
- **Pricing/billing** has no payment provider: choosing a paid plan saves your interest and charges nothing.
- **Settings → Privacy** lets you export all your data (JSON) or delete it (`GET` / `DELETE /records`).
- Shopping/travel locale defaults to India/INR (`DEFAULT_COUNTRY`, `DEFAULT_CURRENCY` in `ai-service/.env`).

## Travel Agent

When a chat message is about travel (flights, hotels, a trip, or any known city), the Travel Agent:

1. **Forecasts the next trip** with the trained model (`ai-service/app/ml`): top-3 destinations, app, trip type and booking type, plus rough timing, spend and trip length. It uses the user's travel history (`app_records`, collection `travel_events`).
2. **Understands the request** with the LLM: route, dates ("next Friday"), travellers, budget. Anything missing is filled from history: home city as the origin, the destination and dates they have been searching, and their usual trip length for the check-out date. If the LLM is down, simple keyword matching is used instead.
3. **Searches live** Google Flights / Hotels (SerpAPI) and hands grounded notes to the final reply. It never books or pays.

The model only knows a user once they have events. Log them from search/booking flows with `POST /travel/events` (backend) or `POST /ai/travel/events` (AI service). The model was trained on synthetic data (`synthetic_data/`), so retrain on real events once there are enough.

### Testing it

**Automated** (offline; the LLM and SerpAPI are mocked):
```bash
cd ai-service
./.venv/Scripts/pip install -r requirements-dev.txt
./.venv/Scripts/python -m pytest tests -q
```
`test_travel_features_parity.py` checks that serving features match training features exactly. It is skipped unless `synthetic_data/experiments/seed7_long` is on disk.

**By hand**, with the AI service running (step 1 above). Open http://localhost:8001/docs to use the same endpoints from the browser:
```bash
# demo users (synthetic history), optionally by persona
curl "localhost:8001/ai/travel/demo-users?persona=business_traveler"
# forecast for a demo user now, or replayed at a past date alongside what they actually booked next
curl "localhost:8001/ai/travel/predict?userId=USER_000030"
curl "localhost:8001/ai/travel/predict?userId=USER_000030&asOf=2026-05-15T10:00"
# just the Travel Agent: its notes, forecast, parsed request and live offers
curl -X POST localhost:8001/ai/travel/ask -H "Content-Type: application/json" -d '{"userId":"USER_000030","message":"Find me a flight and hotel to Chandigarh next Friday"}'
# the full AURA reply
curl -X POST localhost:8001/ai/chat -H "Content-Type: application/json" -d '{"userId":"USER_000030","message":"Where should I go for my next trip?"}'
# simulate the user researching a trip, then ask vaguely; the agent picks up Goa and the date
curl -X POST localhost:8001/ai/travel/events -H "Content-Type: application/json" -d '{"userId":"USER_000030","action":"search","destination":"Goa","origin":"Pune","departure_date":"2026-10-16"}'
curl -X POST localhost:8001/ai/chat -H "Content-Type: application/json" -d '{"userId":"USER_000030","message":"Book my trip"}'
curl -X DELETE "localhost:8001/ai/travel/events/session?userId=USER_000030"   # forget test events
```
Through the backend (needs a signed-in user's token): `GET /travel/predictions` (outside production, add `?demoUser=USER_000030`) and `POST /travel/events`.

## Shopping Agent

Any shopping command, in chat or on the Shopping screen ("order 2 amul milk and eggs from Zepto", "get my usual groceries", "what am I running out of?", "compare wireless earbuds"), goes to the Shopping Agent (`ai-service/app/agents/shopping_agent.py`). It:

1. **Understands the command** with the LLM (offline keyword parser if the LLM is down): order / suggest / search, which store, which items and how many.
2. **Logs it** as shopping events (`app_records`, collection `shopping_events`) and **schedules a retrain** of the shopping model (below).
3. **Predicts what's needed next** with the next-purchase model: each item's chance of being bought in the next 7 days, when it's due, which store this user buys it from, typical quantity and price. Gaps in the command are filled from this: "my usual" becomes the predicted basket, and if no store is named it uses the store they usually buy those items from.
4. **For an order, returns a cart job** that the app starts immediately, with no confirmation step.

### The next-purchase model

`ai-service/app/ml/shopping_*`: a LightGBM classifier scoring P(user orders item X within 7 days) for every item the user has bought or looked at, plus popular items in their main categories. Features cover repurchase cycles (days since last order compared with their usual gap), recent searches, cart adds and wishlists, store and category habits, and catalog priors. One feature module (`shopping_features.py`) is used for training, retraining and live predictions, so they can't drift apart.

- **Base model:** trained on 2,500 synthetic users (`synthetic_data/generate_shopping.py`, then `train_shopping.py`). Tested on users it never saw, over the last 4 months: AUC 0.943. For items bought every 10+ days, where timing matters, AUC is 0.75 against 0.65 for "most frequent" and 0.61 for "most overdue". Full metrics are in `models/shopping/shopping_lightgbm_v1.json`.
- **Learning from use:** every event changes that user's features, so the next prediction already reflects it. Every command also schedules a fine-tune, debounced by 20 s and at most once per 2 min (`SHOPPING_RETRAIN_*` settings). The fine-tune adds trees to the base model, fit on all real users' history mixed with a synthetic sample, takes a few seconds, and hot-swaps the model in. It is saved to `app/data/shopping/` (not committed). `GET /ai/shopping/model` shows which model is serving.

### The cart agent (phone app)

`CartAssistantActivity` opens the store's real website in a WebView, logged in as the user (AURA never sees those credentials). After each page change, `agent.js` snapshots the visible buttons, links and inputs, with the product text around each, and posts it to `POST /shopping/agent/step`. The LLM picks one next action (search, click ADD, tap + for quantity, close a popup, open the cart), and `agent.js` performs it. This works on any store: known stores (Blinkit, Zepto, Instamart, BigBasket, JioMart, Amazon, Flipkart, Myntra, AJIO, Nykaa, Meesho, 1mg, PharmEasy, Croma, DMart) start from their site, and other stores start from a web search for their official site. If the LLM is unavailable, known stores fall back to a search-URL + "ADD" heuristic.

**It stops at the cart.** Payment isn't automated yet. Three independent layers enforce this:
- the server rewrites any pay, checkout, place-order or buy-now step into "done";
- `safety.js` refuses those clicks in the page;
- the WebView blocks payment-looking URLs and non-http schemes such as `upi://`.

The agent never types into login, OTP, PIN or card fields. If a site needs login, an address or a captcha, it pauses, and the user taps **Continue** once that's done.

On the web, the cart job uses the `browser-extension/` (Blinkit, Zepto and Instamart only); other stores need the phone app.

```bash
# forecast for a demo user (bachelor, mostly Swiggy Instamart)
curl "localhost:8001/ai/shopping/predict?userId=USER_000001"
# a command: parsed intent, forecast, and the cart job the phone would start
curl -X POST localhost:8001/ai/shopping/ask -H "Content-Type: application/json" -d '{"userId":"USER_000001","message":"get my usual groceries"}'
curl "localhost:8001/ai/shopping/model"             # base or fine-tuned, last retrain
curl -X DELETE "localhost:8001/ai/shopping/events/session?userId=USER_000001"   # forget test events
```

## Screen assistant (phone app)

The Android app's accessibility service lets AURA see the phone's screen and act on a spoken command ("Hey Aura, ..."). One service, four jobs:

| Say / happens | What it does | Where |
|---|---|---|
| "what's on my screen", "tap the second video", "like this post", "scroll down" | Reads the foreground app's screen (accessibility tree, plus a screenshot when the words aren't enough), asks the server for **one** next action, performs it through the element's own click action, checks the new screen, repeats (max 12 steps / 80 s, with a Stop bar on screen). "Scroll" needs no server. | `ScreenAgent.java`, `ai-service/app/services/screen_agent.py` (`POST /ai/screen/step`) |
| "find this", "where can I buy this", "find the red shoes on screen" | Screenshots the screen; a vision model names the product; live prices come from the same SerpAPI search as Shopping. The matches open in Shopping (`/shopping` with `state.search`). | `ScreenAgent.visualSearch`, `POST /ai/screen/visual-search` |
| A YouTube ad shows | Presses "Skip ad" as soon as the button appears (found by meaning, press verified). Settable in Memory → On your phone. | `AdSkipper.java`, `YouTubeAdapter.java` |
| Learning (opt-in) | Counts which apps and when, kinds of tap (Like, Share, Send...), who you chat with on WhatsApp, topics you like on Instagram/YouTube. | `ActivityLearner.java`, `ActivityProfile.java` |

**Limits that are enforced, not just promised**
- Banking, payment, wallet, password-manager, authenticator, brokerage and system-security/Play Store/Settings screens are never read, screenshotted, acted in or learned from (`ScreenPolicy.blocked`).
- Payment, OTP and password controls are never pressed, and nothing is typed into a password field. Enforced on the phone and again on the server (`validate_step`).
- Anything that sends, posts, deletes, orders or buys (and share/follow/call, unless the user asked for it) is confirmed by voice first.
- It only starts from a spoken command. Only the screen task's elements and, when needed, one downscaled screenshot go to the server; nothing is stored there.
- Learning is **off until the user turns it on**. It stores counters only: no message text, no typed text (the service doesn't even subscribe to typing events), and a tap is recorded only if its label is one of a fixed list of verbs. The profile is a file on the phone; contact names never leave it. The assistant is given one sentence about habits (apps, hours, topics) with no names. Memory → On your phone shows everything and has a wipe button.

**Setup:** set `VISION_MODEL` (see `.env.example`) to a vision-capable model id for your `LLM_PROVIDER`. Screenshots need Android 11+ and the accessibility service turned off and on once after updating (Android asks again when a service gains a capability).

## Not built yet

- Per-retailer shopping APIs (each needs an approved partner account), real banking data, and email/food/cab integrations.
- Enforcement of agent autonomy levels on the server (the settings are saved but not yet enforced by a policy engine).
- Real-time Socket.IO agent events, file uploads (files are referenced, not stored), and the React Native migration (the frontend is a Vite/React web app).
