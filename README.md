# MUWCI 24H Race

Live race system for the MUWCI 24 Hour Race: public standings, a TV display,
team pages, and a staff console for scoring laps and running the race.

## Screens

| URL | Who | What |
|---|---|---|
| `/` | Everyone | Clock, standings (with tie-break and gaps), lap chart, race feed, who's due back, records, donate links |
| `/tv` | Venue screen | Full-screen dark display: all teams, rotating panel (due back, lap chart, latest laps, feed), news ticker. Double-click for full screen |
| `/team/<id>` | Teams & families | Shareable team page: runners, running order, lap history |
| `/admin` | Race staff (PIN) | **Scorer** (one tap per lap), **Race control**, **Teams**, **Laps**, **Announcements**, **System** |

## How it works

- Every staff action is an *operation* sent to the `raceOp` Cloud Function
  (asia-south1). The function checks the PIN, applies the operation inside a
  Firestore transaction using the same rules file the browser uses
  (`functions/shared/race-logic.js`), and writes an audit log entry.
- State lives in `races/main`; each lap is its own document in
  `races/main/laps`. Spectators receive only the small changes.
- Browsers can read but never write (see `firestore.rules`).
- Two PINs: `RACE_ADMIN_PIN` (staff) and `RACE_MASTER_PIN` (clock correction,
  reset, restore, delete team). 8 wrong PINs from one network locks it out for 10 minutes.
- The race clock uses server time (`/api/time`), so device clocks don't matter.
- The race finishes by itself at 00:00:00 and lap entry locks everywhere.

## Offline

The app installs a service worker, so any device that opened the site once can
reload it without internet. Staff actions made offline are stored on the device
with their original time and sent automatically, in order, when the connection
returns. Operations are idempotent, so resending is always safe.

## Develop & test

```sh
npm install && npm --prefix web install && npm --prefix functions install
npm --prefix functions test              # rules engine tests
npm --prefix web run build
npx firebase emulators:start --project demo-muwci --only functions,firestore,hosting
# open http://127.0.0.1:5050  (local staff PIN 1111, master 9999, from functions/.secret.local)
```

## Deploy

```sh
npx firebase login
npx firebase functions:secrets:set RACE_ADMIN_PIN
npx firebase functions:secrets:set RACE_MASTER_PIN
npx firebase deploy
```

After the event, set `RACE_MIN_INSTANCES=0` in `functions/.env` and redeploy to stop
the warm server instance.

Never commit service-account keys, tokens or PINs. `legacy/` holds last year's
recovered build for reference only; it is not deployed.
