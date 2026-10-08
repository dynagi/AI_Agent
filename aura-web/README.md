# AURA AI — Web Frontend (React)

JARVIS-style AI operating-system UI for AURA. The visual source of truth is the reference set in [`/reference/aura/`](../reference/aura/) (01–15).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # strict type-check + production build (screens are code-split)
```

Stack: React 18 · TypeScript (strict) · Vite · React Router · lucide-react. No UI framework. The HUD geometry, charts and agent network are hand-built in CSS and SVG.

## Design system

| File | What's in it |
|---|---|
| `src/theme/aura-theme.css` | Tokens (`--aura-bg`, `--aura-panel`, `--aura-primary`, `--aura-cyan`, `--aura-purple`, `--aura-green`, `--aura-warning`, `--aura-danger`, text, borders, glows, metal, type, motion, z-index), the environment background, **clipped HUD geometry**, shell, buttons, inputs, status and responsive rules |
| `src/theme/aura-pages.css` | Page-level compositions (landing, login stage, dashboard, voice, tasks, thank-you) |
| `src/components/aura/` | The component library, imported through `components/aura/index.ts` |
| `public/aura/*.jpg` | Android and robot art cropped from the reference images |

**How the angular panels work.** Every HUD surface (`.hud`, `.tile`, `.btn`, `.chip`, `.input`, `.icon-btn`, `.nav a.active`, …) is drawn with two pseudo-layers that share one clip-path polygon. `::before` is the border layer (`--bd`: a colour, a gradient or `--aura-metal`). `::after` is the fill layer (`--fill` on top of an opaque `--base`), inset by `--bw`. The outer glow is `filter: drop-shadow`, so it follows the diagonal cuts. To restyle one instance, set these variables inline, e.g. `style={{ '--bd': toneHex.green }}`. Don't set `background` on these elements, because the fill layer covers it.

### Components

`AuraShell` (`AuraSidebar`, `AuraTopbar`, mobile bottom nav, `Ctrl+K` palette) · `AuraLogo` · `HudPanel` · `HudFrame` · `NeonButton` · `HudInput` · `CommandInput` · `NeonTabs` · `StatusBadge` · `MetricCard` · `AgentCard` · `AgentAvatar` · `AgentNetwork` · `InsightCard` · `ActionCard` · `ChatMessage` · `ChartCard` · `ProgressRing` · `GlowDivider` · `SectionHeader` · `FuturisticModal` · `VoiceVisualizer` · `AIAvatar` · `AppLogo`

`AIAvatar` takes `art` (`android | core | voice | onboard | signup | login | decision | travel | tasks | integrations | analytics | face`) and `state` (idle … offline). The state changes the glow and ring colour and speed.

## Routes

| Route | Reference |
|---|---|
| `/` | 01 Landing / boot |
| `/login` | 02 Login |
| `/signup` | 04 Sign up |
| `/onboarding` | 05 Personalization |
| `/dashboard` | 03 Command Center |
| `/chat` | 06 AI Chat |
| `/voice` | 07 Voice Mode |
| `/decisions` | 08 Decision Center |
| `/agents` | 09 Agent Hub |
| `/tasks` | 10 Tasks |
| `/agents/:id` (e.g. `/agents/travel`) | 11 Travel Agent |
| `/collaboration` | 12 Agent Collaboration |
| `/integrations`, `/settings` | 13 Integrations & Settings |
| `/analytics` | 14 Analytics & Insights |
| `/thank-you` | 15 Thank You |
| `/qa` | 16 Q&A / Ask Anything |
| `/pricing` | 17 Plans & Pricing |
| `/calendar` | 18 Calendar |
| `/tasks` (+ `/tasks/board` agent view from ref 10) | 19 Tasks |
| `/shopping` | 20 Shopping |
| `/travel` | 21 Travel |
| `/finance` | 22 Finance |
| `/wellness` | 23 Wellness |
| `/research` | 24 Research |
| `/memory` | 25 Memory |
| `/automation-hub` | 26 Automation Hub |
| `/automations` | 27 Automations |

`/home`, `/setup`, `/faq` and `/agents/collaboration` redirect to their new paths.

Layout by width: above 1100px, sidebar, top command bar and multi-column grids. From 900–1100px, the sidebar stays and grids drop to two columns or stack. Below 900px, a drawer and a bottom nav (Home · Chat · **Voice** · Agents · More). No route scrolls horizontally at phone width.

## Behaviour rules

- Data lives in `src/data/mock.ts` and in data arrays inside each screen. Anything not backed by an integration shows a **DEMO** badge.
- `src/services/aura.ts` is the only API boundary, and no keys are in the frontend. The voice layer is `src/services/voice.ts` (browser speech, with Vapi/ElevenLabs handled server-side).
- Consequential actions go through the approval modal. Mock mode never reports a fake success.
- The Decision Center's "AURA's pick" comes from a transparent weighted score over your priority-goal order. Reorder the goals and the pick can change. The final choice stays with the user.
- `prefers-reduced-motion` is respected. Focus states are visible, and controls have labels.

## Module architecture (refs 16–27)

```
src/components/ui/          primitives + kit (Drawer, MoreMenu, FilterDropdown, Tooltip, DataTable, AvatarGroup…)
src/components/ai/          AICommandPanel — suggested prompts, NL input, voice, streaming reply, action preview, Confirm/Cancel
src/components/<domain>/    calendar · tasks · shopping · travel · finance · wellness · research · memory · automations · pricing
src/data/mock*.ts           one file per domain (mockTasks, mockEvents, mockProducts, mockTrips, mockTransactions, mockBudgets,
                            mockGoals, mockWellnessData, mockResearchPapers, mockMemories, mockAutomations, mockTestimonials, mockPricingPlans)
src/state/stores.ts         tiny shared stores (useSyncExternalStore) seeded from the mock files — swap for API/Supabase loaders
src/state/search.tsx        header search: on module pages it filters the page live; elsewhere Enter asks AURA
```

**AI actions follow one rule:** anything that changes data is shown as a preview and waits for **Confirm** or **Cancel**. Examples are "Plan my day → Optimize My Day / Keep Current Schedule", creating tasks, adding focus blocks, and budget changes. Purchases, bookings and plan upgrades run in demo mode, so they never report a real charge or booking.

## Mobile app (Capacitor)

This web app is wrapped as a native Android/iOS app via [Capacitor](https://capacitorjs.com). The native project lives in `android/` (generated by `npx cap add android`; not hand-edited except the files listed below).

```bash
npm run cap:sync     # build the web app, copy it into android/, sync plugins
npm run cap:android  # cap:sync + open the project in Android Studio
```

**Quick Cart / cart agent** (`services/extension.ts` + `native/cartAssistant.ts`) fills your cart on a store by itself, then stops at the cart. Payment is not automated. It starts with no confirmation step whenever the Shopping Agent turns a command into an order (`aura.chat` starts it), or from the Quick Cart panel / "Fill … cart" forecast buttons. In the phone app it works on **any store**. On web it needs the `browser-extension/` companion and covers Blinkit, Zepto and Instamart. The native side is a custom Capacitor plugin:

- `android/app/src/main/java/com/aura/app/AuraCartAssistantPlugin.java`: the JS-facing plugin (`startQuickCart({store, startUrl, items, apiBase, token})`, plus `quickCartProgress`, `quickCartNeedUser` and `quickCartDone` events).
- `android/app/src/main/java/com/aura/app/CartAssistantActivity.java`: hosts a WebView on the real store site (the user's own logged-in session; AURA never sees or stores those credentials). It runs the agent loop: page snapshot, then `POST {apiBase}/shopping/agent/step`, then the action is performed. If the site needs login, an address or a captcha, it shows **Continue**.
- `android/app/src/main/java/com/aura/app/CartJobBridge.java`: the active job (store, items with pending/added/failed status, recent action history).
- `android/app/src/main/assets/aura-cart/agent.js`: snapshots visible controls with the product-card text around them, and performs click, type, scroll and navigate actions.
- `android/app/src/main/assets/aura-cart/safety.js`: the click denylist.

Three independent safety nets enforce "AURA fills the cart, the user pays":
- the server rewrites any pay, checkout or place-order step into "done";
- `safety.js` refuses those clicks in the page;
- `CartAssistantActivity` blocks payment-looking URLs and non-http schemes such as `upi://`.

For a local backend on the emulator, set `VITE_API_URL=http://10.0.2.2:4000`. Cleartext HTTP is allowed only for that host and localhost (`res/xml/network_security_config.xml`).

No iOS plugin yet — `AuraCartAssistantPlugin`/`CartAssistantActivity` are Android-only; an iOS build would need an equivalent `WKWebView`-based Swift plugin under `ios/App/App/` once `npx cap add ios` is run (requires Xcode/macOS).

## "Hey Aura" wake word (Android)

`WakeWordService` listens for "Hey Aura" in the background with [Vosk](https://alphacephei.com/vosk/) (offline, on the phone; the recogniser only knows the wake phrase). It is off until the user turns it on in **Voice → "Hey Aura" wake word**, shows a permanent notification while on, and must be switched on with the app open (Android 14 rule for microphone services). On the phrase it frees the microphone, brings AURA forward and fires the `wake` event; `services/wake.ts` + `companion.wakeTalk` then capture the command with the normal recogniser and answer by voice. Anything in the app that listens calls `holdWake()` / `releaseWake()` so the two never share the mic.

The speech model (55 MB) is not in git. Before building the Android app, download and unpack it once:

```bash
curl -L -o vosk.zip https://alphacephei.com/vosk/models/vosk-model-small-en-in-0.4.zip
unzip vosk.zip && mv vosk-model-small-en-in-0.4 android/app/src/main/assets/model-en-in
uuidgen > android/app/src/main/assets/model-en-in/uuid   # any unique text; Vosk uses it as the model version
```

Not available on iOS (no third-party always-listening) or the web.
