# dAttendance

Replaces the per-employee monthly attendance spreadsheet
(`DZIND147_Attendance_Sheet.xlsx`) with an app: employees mark their own days,
admins configure the working week, send reminders and approve the month.

This repo is the **employee app** only. The dAdmin side — the Work Pattern,
Reminders, Approvals and Activity History pages — lives in the dAdmin repo.

```
dattendance/
├── server.js                 API on :4010
├── scripts/start-dev.js      dev server, first free port from 3000 up
├── config/db.js              one pool per database (dadmin, dtime, dattendance)
├── src/
│   ├── Login.js              auth against dadmin.employee
│   ├── My_Attendance.js      the Excel-shaped sheet
│   ├── backend_routes/
│   │   ├── Login_server.js
│   │   ├── dAttendance_Sheet_server.js
│   │   └── utils/attendanceCalendar.js   ← the calendar engine
│   └── utils/                api.js, SessionContext.js
└── sql/
    ├── 001_dattendance_schema.sql        the new database
    ├── 002_dadmin_registration.sql       registers the app inside dAdmin (required)
    └── 003_backfill_and_checks.sql       optional backfill + data-quality queries
```

`src/backend_routes/utils/attendanceCalendar.js` decides what every date is for
an employee — working day, week-off, declared holiday, or before their joining
date. The dAdmin pages carry their own copy of this file, and the two must stay
byte-identical: a divergence means the employee's sheet and payroll disagree
about what a day is, which is the worst failure this system can have. If you
change it here, copy it across.

## Running it

```bash
npm install
cp .env.example .env    # then fill it in
node server.js          # backend  — API on :4010
npm start               # frontend — :3000, or the next free port
```

In VS Code, **F5** runs the backend instead of `node server.js` — the
`Run Backend` configuration in `.vscode/launch.json`, same as dAdmin and dEpr.
It attaches the debugger, runs in the integrated terminal, and restarts on
crash. `npm run server` is the same thing without the debugger.

`npm start` takes 3000 when it can and steps up to 3001, 3002 … when another
dApp already holds it, without stopping to ask. In development the API accepts
any `localhost` origin, so a shifted port still passes CORS on the credentialed
login request. `PORT=3005 npm start` pins it; `npm run start:cra` is plain
`react-scripts start` if you ever want the original prompt back.

The API port does **not** move. It is a fixed contract with nginx (which
proxies `dattendance.dolluzcorp.com` to it) and with `REACT_APP_API`; a backend
that wandered would silently break CORS and the auth cookie. Set
`DATTENDANCE_PORT` in `.env` to change it deliberately.

`JWT_SECRET` must be byte-identical to dAdmin's. Identity is never duplicated —
there is no user table in `dattendance`; staff authenticate against
`dadmin.employee`, so a password change in dAdmin takes effect here immediately.

The API will not accept a login until `sql/002` has been run — it adds the
`app_dAttendance` column the login query reads.

## Ports

| App | Port |
|---|---|
| dAssist | 4001 |
| dAdmin | 4002 |
| dTime | 4003 |
| dBug | 4004 |
| dSlip | 4007 |
| **dAttendance** | **4010** |

`https://dattendance.dolluzcorp.com` → nginx → `localhost:4010`.

Note the bundle's original README listed dTprm on 4010. If dTprm is deployed on
the same droplet, one of the two has to move — check `pm2 list` before the
first deploy.

## Deploy

First-time setup is in [DEPLOY.md](DEPLOY.md) — nginx vhost, certbot, pm2, and
the SQL that has to run before anyone can log in.

Subsequent releases:

```bash
cd /var/www/dolluzcorp.com/dattendance
git pull origin main
npm install                                             # only if package.json changed
NODE_OPTIONS="--max-old-space-size=3072" npm run build
pm2 restart dattendance-backend
```

The `NODE_OPTIONS` bump is not optional — `react-scripts build` OOMs on the
droplet's default heap.

## Four assumptions still open

These were taken to keep the build moving. Each is isolated to one place.

| Decision | Made | Change it in |
|---|---|---|
| **Leave source** — the employee marks `L`; approved dTime leave is advisory, mismatches surfaced not blocked | `manual` | `att_config.leave_source` |
| **Worked days** — excess-only LOP, not the spreadsheet's cliff | excess-only | `summariseSheet()` |
| **Approval routing** — `reporting_manager`, else the first active Admin | manager first | `/submit` |
| **Holiday access** — cross-database read of `dtime.holidays` | cross-DB read | `attendanceCalendar.js` |

The leave source is the one that reaches payroll. `dtime.leave_requests`
already owns leave, so letting an employee freely type `L` creates a second,
contradictory record and dSlip will not know which to bill. The build shows
both and flags disagreements rather than picking a winner — a holding position,
not an answer.
