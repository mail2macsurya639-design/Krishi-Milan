# कृषि मिलन · Krishi Milan

Region-aware crop recommendation + direct farmer-buyer marketplace, built on
existing sklearn ensemble model, plus Google Gemini and weather APIs.

## Setup

```bash
cd backend
pip install -r requirements.txt --break-system-packages
cp .env.example .env
```

Fill in `.env`:
- `MONGO_URI` — MongoDB Atlas connection string (use a **new** password;
  rotate any credential you've ever pasted in chat or committed to git)
- `GEMINI_API_KEY` — from Google AI Studio (free tier works fine for a demo:
  Flash / Flash-Lite models, no card required)
- `WEATHER_API_KEY` — from openweathermap.org (free tier)
- `JWT_SECRET` — any long random string, used to sign login tokens. Generate
  one with:
  ```bash
  python3 -c "import secrets; print(secrets.token_hex(32))"
  ```
  Paste the output as `JWT_SECRET=...` in `.env`. The app refuses to start
  without this — it's what makes login sessions real instead of trust-the-client.

```bash
python app.py
```

Then open `frontend/index.html` in a browser (or serve it with any static
file server). It talks to `http://127.0.0.1:5000/api`.

## What we changed from the original version

- **Region-aware**: every prediction and listing carries a Terai / Pahad /
  Himal region, and the model's top-3 output is softly re-ranked per region.
- **Gemini integrated across six features**: crop explanation, buyer-listing
  matching, deal summaries, a farming Q&A chatbot, a photo-based crop health
  check (multimodal), and a price negotiation coach.
- **Real database**: MongoDB collections for `users`, `listings`,
  `predictions`, `matches` — replacing the previous stateless-only backend.
- **Real authentication (JWT)**: login/register return a signed token, sent
  as `Authorization: Bearer <token>` on protected calls. The backend derives
  who you are from the token — it no longer trusts a client-supplied
  `farmer_id`/`buyer_id`, so one user can't spoof another's identity when
  posting a listing or updating a deal. Session persists across page
  reloads via `localStorage`.
- **Prediction history**: `/api/predictions` (GET, logged-in farmers only)
  returns their past crop recommendations; shown in a "मेरो अघिल्लो
  सिफारिसहरू" card.
- **Deal status tracking**: matches move through
  `pending → confirmed → completed` (or `rejected`) via
  `/api/matches` (list) and `/api/matches/<id>/status` (update) — only the
  buyer or farmer involved in that specific deal can change its status.
- **Voice input**: mic buttons (🎤) on the listing crop-name field, the
  buyer's "what do you need" box, and the chatbot input, using the
  browser's built-in Web Speech API in Nepali or English depending on the
  active language toggle. Works best in Chrome — Safari support is
  inconsistent, and the button quietly disables itself if the browser
  doesn't support speech recognition at all.
- **Region-based rainfall auto-fill**: picking a region fills the rainfall
  field with a *typical* value for that zone (not live weather — see below
  for why), and only if the farmer hasn't already typed something.
- **Weather auto-fill**: browser geolocation → OpenWeatherMap → fills
  temperature/humidity, so a farmer doesn't have to guess numbers.
- **Bilingual UI** (Nepali/English toggle), region-based visual theme, and a
  farmer/buyer login + marketplace flow, replacing the single static form.

## New: Farming assistant tab

- **Chat (`/api/chat`)** — free-form farming Q&A, keeps the last 20 turns of
  conversation for context. Honest by design: the prompt tells Gemini to
  say when a question needs a real expert (e.g. lab-confirmed disease ID).
- **Crop health check (`/api/crop-health`)** — upload a photo, Gemini
  (multimodal) gives a best-effort read on visible issues plus one next
  step. This is a photo heuristic, not a diagnosis — the prompt explicitly
  asks Gemini to flag low confidence and suggest a local agriculture office
  for anything uncertain.
- **Negotiation coach (`/api/negotiate`)** — given a listing's asking price
  and a buyer's offer, Gemini explains the gap in relative terms and
  suggests a fair way to bridge it. Important: there is no live mandi price
  feed wired in, so the prompt is written to never invent a "real" market
  price — that's a stated future-scope item (see below).

## Why rainfall isn't auto-filled from live weather

OpenWeatherMap's current-conditions endpoint only reports rain actively
falling right now (usually 0 unless it's raining that minute) — but the crop
model was trained expecting a seasonal/typical rainfall figure. Filling one
with the other would silently feed the model a misleading number. Instead,
`/api/regions` exposes a typical rainfall value per zone (the midpoint of
each region's rough climate range), and the frontend auto-fills that,
editable, when a region is picked. It's an honest approximation, not real
climatological data — a good candidate for a real rainfall API in the future
scope.

## Known gaps / next steps

- Deal status permissions are basic (any party to a deal can set any
  status) — no workflow enforcement (e.g. blocking a jump straight to
  "completed" without "confirmed" first).
- Satellite imagery (NDVI crop health) intentionally left out of this build —
  the photo-based Gemini check is the lighter-weight alternative shipped
  instead.
- Region-climate bounds in `app.py` are rough approximations, not real Nepal
  agri data — a stated future improvement, not a finished retraining.
- No live mandi/market price feed — the negotiation coach reasons about the
  gap between two numbers, not real market value (see above).
