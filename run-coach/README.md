# Run Coach

SpacePlayground's 2nd app. Connect a Garmin Connect **Personal API** key and get your running, trail,
walking and hiking data with HR zones, sleep, HRV, Body Battery, a readiness/recovery estimate,
coaching tips and a 7-day plan.

## Run it

Needs Node 18 or newer (no `npm install`). From the SpacePlayground folder:

```
node run-coach/server/server.js
```

Open http://127.0.0.1:8787/run-coach/ and paste your key. `PORT` and `HOST` env vars change where it
listens (default `127.0.0.1:8787`, this computer only).

On a static host such as GitHub Pages there is no server, so only **Try with demo data** works there.

## How it works

| File | What it does |
|---|---|
| `server/server.js` | Swaps the API key for a 24 h access token (`POST /personalapitoken-service/...`), keeps both in memory per browser session (HttpOnly cookie), renews the token when it expires, proxies read-only Garmin GET calls from an allow-list, serves the SpacePlayground files |
| `index.html` | Page 1: enter the key |
| `dashboard.html`, `dashboard.js` | Page 2: loads 1 year of activities, 6 months of daily summaries, sleep and HRV, then renders everything |
| `coach.js` | Readiness, recovery hours, VO2max estimate, insights, activity notes, best efforts, race predictions, weekly plan |
| `api.js` | Calls the backend, or answers with generated data in demo mode (`dashboard.html?demo`) |

## Estimates, not Garmin numbers

The Personal API doesn't return Garmin's VO2max, Training Readiness, Recovery Time or Training Status.
Run Coach estimates its own:

- **VO2max**: per run from grade-adjusted pace vs heart-rate reserve (ACSM running equation), runs of
  15+ min with under 20% walking; the trend is the 75th percentile of the last 6 weeks.
- **Readiness**: weighted mix of last night's sleep score, HRV status, resting HR vs 7-day average,
  Body Battery peak and acute:chronic training load.
- **Recovery hours**: from each recent activity's training effect and load, minus time since it ended.
