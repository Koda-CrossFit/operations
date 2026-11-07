# Koda Operations

The site for the gym's cleaning people and hourly workers: today's tasks with a check mark, availability for upcoming weeks, clock in and out, and tools for the managers. A static page on GitHub Pages (`index.html`), a Google Apps Script backend (`apps-script/`), and one Google Sheet as the database.

Staff sign in by tapping their name. Managers enter a short code once per device. The site has no dollar amounts anywhere: pay rates stay in the separate payroll sheet.

## How the week works

1. People with set days (type `Set`) are scheduled automatically. Everyone else (type `Flexible`) says how many hours they can work each day and how many hours they want for the whole week. There are no set times: staff just see their tasks by day, and pay comes from clocking in and out.
2. **Friday at 7:00 AM** the schedule for the coming Monday to Sunday is built. Anyone who didn't submit gets an email, everyone with work gets their week, and the managers get a summary.
3. Tasks go out by priority (A, then B, then C), and people by rank, best first, up to the hours they asked for.
4. Anyone who submits after the deadline only gets what's left over. Nobody else's work moves. Someone who was on time stays on time when they change their answer later, unless they offer more than before (more hours on a day, or more hours wanted).
5. Every night a little after 12:30 AM, unfinished work is sorted out. A daily task counts as missed. A one-off rolls to today, and so does any other task unless the same task already has a row today or tomorrow. Floors never moves: if it isn't checked off, it's marked missed where it is and the managers get an email. A forgotten clock-out gets flagged. A shift can run past midnight: an entry stays on the clock for 12 hours after clocking in, and anything older counts as a forgotten clock-out.
6. On the 1st of each month at 7:00 AM, the managers get last month's hours.
7. On a phone, the Today tab shows how to add the site to the home screen until the person dismisses it or opens it from the icon. Android gets a one-tap prompt when Chrome offers one. Apple gives a page no way to prompt, so an iPhone gets the steps.
8. Staff can write in anything extra they did on the Today tab. It's saved on the `Extra Work` tab, and managers see it under that day on Manage.
9. Manage opens on Overview, which always shows the current Monday to Sunday: whether the week is out, on hold or not out yet, tasks done, still open, missed and uncovered, done out of total for each day, hours logged this week and last week for each person (with a dot for anyone on the clock), every row of `Tasks` with this week's done out of scheduled, and this week's one-offs. Hours go by the entry's date, the same as Manage, then Hours and payroll, and an entry still on the clock counts once it's clocked out. It only reads, through the `mgrOverview` request.

A manager can put one week on hold with the `mgrHoldWeek` request. That week has no deadline, nobody counts as late, and Friday's run waits. `mgrRunHeldWeek` builds it and sends the emails. Run it before that day's work starts, since a run late in the day still hands out that day's set work. A hold only suits a week with no unfinished work before it, like the first week: the nightly would roll old work into the unbuilt week, and the run would then add it again.

## The sheet

Everything lives in the "Koda Operations" Google Sheet. Columns are found by their header name, so they can be moved around, and new ones can be added to the right.

| Tab | What it holds |
|---|---|
| Staff | Everyone, with their rank, email, type, set days and set tasks |
| Tasks | The regular tasks: how often, priority, about how long, which days, how far they can move |
| One-Offs | The extra tasks managers add each week |
| Availability | One row per person per week. `Hours Wanted` is the week's total. `Slots` is the hours per day that the code reads, like `Mon:3;Tue:2.5`, and `Readable` is for people, like `Mon 3 hrs; Tue 2.5 hrs` |
| Time Off | Out-of-town dates |
| Schedule | Every task on every day, who has it, and whether it got done |
| Hours | Every clock-in and clock-out |
| Monthly Hours | Totals per person. Type any date in a month at the top |
| Log | A line for every change anyone makes |
| Settings | Test mode, who gets email, and the site's address |
| Closed Days | Days the gym is closed. Nothing is scheduled on them |
| Extra Work | What staff wrote in that they did beyond their list |

## Changing things

Edit the sheet. There's nothing to redeploy for any of this.

**A task:** change its row in `Tasks`. Set `Active` to FALSE to stop a task without deleting it. To add one, add a row with a new ID.

- `Priority`: A, B or C. Plusses rank higher, so `A++` comes before `A`.
- `Days`: `Mon, Wed, Fri`, or the word `Set` for a task only set staff do unless they're covering.
- `Minutes`: about how long it takes. Matching and the managers' screens use it. Staff don't see it, and pay comes from clock-in and clock-out times, never from this.
- `Flex Days`: how many days a task can move from its listed day if nobody can do it then. 0 means that day or not at all.

**A person:** change their row in `Staff`. Set `Active` to FALSE when someone leaves, which keeps their history.

- `Rank`: lower numbers get first pick.
- `Type`: `Set`, `Flexible` or `Manager`.
- `Set Days`: `Thu, Fri, Sun`.
- `Set Tasks`: task IDs, optionally for one day only: `T08, T14@Tue`.

**A closed day:** add a row to `Closed Days`. Type the date like `12/25/2026`. `2026-12-25`, `12/25/26`, `12/25` and `Dec 25` also work. Anything else can't be read, so work gets scheduled that day as usual, and the Friday summary email says which line it couldn't read.

**The hours in a shift:** use Manage, then Hours, on the site. That records who changed it and when.

Changes to tasks and staff apply from the next schedule built. To apply one to the current week, use Re-run matching on the Manage tab. It leaves alone anything done, anything a manager placed by hand, and anything already on someone's list today.

Out-of-town dates typed straight into `Time Off` only count from the next build. The site's Out of town form also covers the affected work right away, and tells the managers.

## Test mode and going live

`Settings` has a `live` row, and it starts at FALSE. Until it says TRUE, **every email goes only to `test_email`**, with `[TEST to <name>]` in the subject, so the whole thing can be rehearsed without anyone else getting anything.

To go live:

1. Check that every person in `Staff` has the right email.
2. Check `manager_emails`, `reply_to` and `site_url` in `Settings`.
3. Set `live` to TRUE **before 7:00 AM on the Friday** that should email everyone.

The Friday run goes out once. If it ran while `live` was still FALSE, that week's emails went only to `test_email`, and turning `live` on afterward doesn't send them again. To send them for real: set `live` to TRUE, then in the Apps Script editor open Project Settings, Script Properties, and delete the property named `RUN_WEEK_2026-11-09_DONE` (with that week's Monday in it). Do it before that Monday, since the job only looks at the coming week. The next run, within 5 minutes, sends everything to the real people. It doesn't rebuild the schedule.

`test_email` also gets a note whenever an automatic job fails, live or not. `first_week` is the first Monday the site schedules. Weeks before it are skipped, and Manage won't take a one-off or a Re-run for one. `thursday_heads_up` set to TRUE adds a Thursday 1:45 PM reminder to anyone missing availability.

## Deploying the backend

You need [clasp](https://github.com/google/clasp), logged in as the account that owns the script. `.clasp.json` holds the script ID and isn't in this repo. Its `rootDir` should point at `apps-script`.

The first time only:

1. `clasp push`, then in the Apps Script editor run `authorize` once and approve what it asks for.
2. Create the web app deployment: execute as yourself, access for anyone.
3. POST `adminSetup` to the web app URL, as plain text. Then put the web app URL in `PROD_API_URL` in `index.html`.

```json
{
  "action": "adminSetup",
  "code": "the manager code you choose",
  "sheetId": "the Koda Operations sheet",
  "sourceSheetId": "the sheet with the employees and rankings tab",
  "managers": [{ "name": "First Last", "email": "someone@example.com" }],
  "testEmail": "someone@example.com",
  "replyTo": "someone@example.com"
}
```

`adminSetup` creates the tabs, seeds the tasks and closed days, reads staff from the source sheet, and installs the 5-minute trigger. It's safe to run again, with the same code: it adds what's missing and doesn't wipe or duplicate anything. Leave `sheetId` out on the first run to have it make a new sheet. Add `"shareWithManagers": true` to make the managers editors of the sheet, which makes Google email them about it. If the response has a warning about the trigger, run `installTick` from the editor. The sheet ID and manager code are kept in Script Properties, never in this repo.

`sheetId`, `managers` and `shareWithManagers` only count on the first run, so the manager code alone can't point the site at another sheet or give anyone access to it. After that, share the sheet from Google Sheets, add managers on the `Staff` tab, and change `SHEET_ID` in Script Properties.

**Choosing the manager code:** pick a long, random one, 12 characters or more. It's typed once per device, so length costs nothing, and the wrong-try limit counts per action, so it slows guessing down but doesn't stop it. Anyone who can edit the sheet can also open its Apps Script project and read the code in Script Properties. Today that's fine, because the only editors already hold the code. If the sheet is ever shared more widely, move the script to a standalone project first.

Every time after that:

```
clasp push
clasp create-version "what changed"
clasp update-deployment <deployment id>
```

The page only sees a change once the deployment is updated. Updating the same deployment keeps the same web app URL.

**When `appsscript.json` has changed, use `clasp push --force`.** Without it, clasp prints "Skipping push" and uploads nothing, and the next `clasp create-version` quietly repeats the old code.

## How reads work

Reading through SpreadsheetApp is slow: a few hundred milliseconds a call, sometimes far more, and three calls per tab. So the first read in a run is one call to the Sheets service (`Sheets.Spreadsheets.Values.batchGet`) that gets every data tab at once, and everything else that run reads comes from that. It took about half a second on an empty sheet, the only size it has been timed at so far (see Known limits). Log only sends its header row, since it grows without limit and nothing reads it for data. Monthly Hours isn't read at all.

- **Dates and times:** the batch sends these as plain numbers, so the date and time columns in `Config.js` say which numbers to turn back, and a plain number typed into one of those columns reads as a date or time too. `first_week` in `Settings` gets turned back the same way. A date in any other column stays a plain number, and one in `Flex Days` counts as no flex. The number is Denver clock time, so the sheet has to stay on Denver time, which `adminSetup` sets. Turning it back uses the script's own clock, which `appsscript.json` sets to Denver. A run checks that first, and if the clock isn't Denver's, that run reads through SpreadsheetApp.
- **Writes:** these still go through SpreadsheetApp, and the batch can't see a write that's still waiting to be sent. Once a run writes to a tab, later reads of that tab in that run use SpreadsheetApp, which does see it. Anything written before the batch gets flushed first, and a request that fails partway sends what it wrote before it lets go of the lock, so the next request in line sees it.
- **If the batch fails,** for any reason, or its reply isn't the right shape, that run logs a warning and reads through SpreadsheetApp: slower, never broken. A tab that comes back with nothing at all, not even headers, gets a second look through SpreadsheetApp too, since setup always leaves headers.
- **`adminSetup`** always reads through SpreadsheetApp, because it writes straight to the sheet as it makes tabs.

## Running it locally

No Google needed. There's nothing to install beyond Node.

```
node dev/server.js
```

The site runs at http://localhost:8787, with the real backend code running against an in-memory fake of the Google services (`dev/gas-mock.js`). It starts with fake staff, fake schedules and the clock on Tuesday, November 10, 2026 at 9:05 AM. The manager code is `000000`.

| Address | What it does |
|---|---|
| `/dev/time?set=2026-11-13T07:00:00-07:00` | Moves the clock. `?clear=1` goes back to the real time |
| `/dev/tick` | Runs the automation once |
| `/dev/emails` | Shows what's been "sent". `?clear=1` empties it |
| `/dev/reset` | Starts over. `?nextWeek=0` leaves next week unpublished |

## Known limits

The page itself needs a connection to open. Taps on a page that's already open are safe with no signal: they wait on the phone and send once it's back. But reloading, or opening the site cold, with no connection at all gives the browser's own error page until the signal returns, and nothing waiting is lost. A small service worker fixes this, and it's the first change planned after launch. It isn't in yet because a bad one is hard to undo on people's phones, and the site should run on real Google first. When that goes in, make the `offline` walkthrough scene really go offline, not just block `/api`.

The batch carries every row of every data tab on every request that reads anything, even one that only needs the staff list. At the site's pace that's about 0.7 MB more each year, and Google suggests 2 MB a request at most, which is about three years away. An error from Google falls back to SpreadsheetApp, but a batch that just gets slower doesn't, and nothing warns about it. So once there's real history, time a read on a copy of the sheet with 3,000 and then 20,000 `Schedule` rows. If it has gotten slow, move old `Schedule` rows to an archive tab that isn't in `HEADERS_`, since the batch only asks for those.

## Tests

```
node --test
```

`tests/scheduler.test.js` covers the matching rules, `tests/api.test.js` covers every handler and automation against the fake Google services, `tests/reads.test.js` checks that reading through the batch gives the same answers as SpreadsheetApp and stays fast, and `tests/site.test.js` checks what it can about `index.html` and `assets/` without a browser.

To walk the real site in a real browser, start the local server and run this in a second window. It needs Microsoft Edge, clicks through every screen at phone, narrow phone and desktop sizes, tests the offline queue and a slow server, fails on any console error, sideways scroll, or a screen that keeps asking the server for things while it sits idle, and saves a screenshot of each screen to `dev/screenshots/` (not committed). `node dev/walkthrough.js today offline` runs just those parts.

```
node dev/walkthrough.js
```

`node dev/make-icons.js` redraws the app icons in `assets/`.

## Rules for this repo

This repo is public. No real staff names, email addresses or private sheet IDs go in any file: they live only in the Google Sheet, and tests use made-up people. There are no dollar amounts anywhere.
