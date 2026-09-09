# Staff Scheduler

Fair, fully covered weekly schedules for small teams, generated in seconds.

**Live site:** https://thestaffscheduler.com

A manager adds their staff (roles, hours, availability), describes the shifts
they run ("Morning 6-12: one lead and two baristas"), and clicks *Generate*.
The app builds a schedule that satisfies every hard rule, does its best on the
soft ones, explains anything it could not fill, and publishes it to staff by
email and text. Employees get their own login to see shifts, set availability,
request time off, and swap shifts with eligible coworkers.

---

## Table of contents

1. [Features](#features)
2. [How scheduling works](#how-scheduling-works)
3. [Architecture](#architecture)
4. [Project layout](#project-layout)
5. [Running locally](#running-locally)
6. [Testing](#testing)
7. [Deployment (Railway)](#deployment-railway)
8. [Environment variables](#environment-variables)
9. [Data model](#data-model)
10. [API overview](#api-overview)
11. [Operational notes](#operational-notes)

---

## Features

**For managers**
- Multiple locations per account, each with its own staff, roles, hours, and shifts
- Shift-based coverage ("this shift needs N of role X") or detailed hour-by-hour coverage with peak-period boosts
- One-click schedule generation with live progress, plus "find alternative" that is forced to differ from earlier results
- Plain-English *scheduler notes*: why each open hour stayed open, who is under minimum hours, unavoidable clopenings, and what to change
- Publish workflow: draft, review, publish; staff are notified on publish
- Time-off review: approve or deny; approved days are blocked in future schedules and already-scheduled shifts are removed
- Table, grid, and timeline views; colour by role or by person; CSV export
- Dark and light themes

**For employees**
- Personal login (temporary password on invite, forced change on first sign-in)
- Phone-friendly portal: my schedule, coworkers' schedule, hours summary
- Availability editor with 15-minute precision
- Time-off requests
- Shift swaps: give a shift away or trade it; only eligible coworkers are asked; counter-offers; the published schedule updates itself
- Email and SMS notifications, each switchable per person

**Try it:** five demo businesses (7 to 50 staff) live at `/demo/schedule`, no account needed.

---

## How scheduling works

The solver is in [`scheduler/solver.py`](scheduler/solver.py) and uses Google
OR-Tools CP-SAT.

**Variables** exist only where an assignment is possible: the employee is
available, holds the role, and a coverage requirement exists for that role at
that hour. This pruning keeps the model small.

| Variable | Meaning |
|---|---|
| `x[e,d,h,r]` | employee *e* works hour *h* of day *d* in role *r* |
| `w[e,d,h]` | employee works that hour in any role |
| `start[e,d,h]`, `end[e,d,h]` | first / last hour of a shift |
| `day[e,d]` | employee works at all that day |

**Hard rules** (never violated): availability and approved time off, one role
per hour, max staff per requirement, weekly max hours (40 unless overtime is
allowed), max hours per day, max shift length, min shift length, max shifts per
day, max split-shift days per week, max days per week (when "required"), and
supervision (someone who needs supervision only works while a supervisor is on).

Everyone also gets at least one day off a week whenever the business is open
six or seven days, whatever the max-days setting says.

**Soft rules** (penalised in the objective, roughly in priority order; the
weights are named constants at the top of the solver class):
coverage shortfall (per missing person-hour, extra on peak hours), weekly
minimum hours, max days per week when "preferred", clopenings (rest between a
close and the next open below `min_rest_hours`), consecutive days beyond the
limit, split-shift days, short days (a worked day should look like a normal
shift for that person: at least 6 h for full-time, 4 h for part-time), full-
timers' contracted hours (they get their week before part-timers pick up
extras; with "avoid overtime" off this actively uses overtime), hours fairness
(the worst shortfall is penalised so it is shared), overtime hours, days worked
(same hours in fewer days), start-time consistency (one usual start time per
person), weekend fairness (based on weekend history), preferred hours,
mid-shift role switches, and the minimise/balanced/maximise strategy ("minimise"
weighs hours by wage so cheaper coverage wins).

**Two passes.** Pass 1 keeps only the hard rules and the coverage objective, so
it finds the best achievable coverage fast (it stops the moment every hour is
filled). Pass 2 locks coverage at that level, drops it from the objective, and
optimises the human factors above, warm-started from pass 1's solution. Coverage
can never get worse in pass 2, and the second model is much easier to prove.

**Stopping:** each pass stops when it proves optimality, hits its share of the
time limit (15-50 s, scaled by team size), or has not improved by a *meaningful*
amount for a few seconds. Cosmetic improvements do not reset the stall timer,
so a small team returns in seconds instead of burning the whole limit polishing.

**Diagnostics:** the result carries `unfilled_slots` (hour by hour, each with a
plain-English reason), `unfilled_ranges` (the same merged into shift-sized
ranges for the UI), `employees_under_min`, `clopenings`, and `suggestions`.

**Alternatives:** previous solutions for the week are stored with the saved
schedule; an alternative must differ from each of them in at least 10% of the
assigned hours (min 3), and the last solution is used as a warm-start hint.

**Diagnostics:** after solving, each unfilled slot is explained by checking who
could have worked it and why they did not (nobody with the role, nobody
available, everyone at max hours/days, supervision, shift-length rules). These
feed the suggestions shown under the metrics.

Typical timings on the demo businesses (16-core dev machine): coffee shop
(7 staff) about 5 s, restaurant (20 staff) about 10 s, warehouse (50 staff)
about 11 s.

---

## Architecture

```
Browser (vanilla JS)            Flask app (Gunicorn, 2 workers)           PostgreSQL
─────────────────────           ─────────────────────────────────         ──────────
manager app  static/app.js  ──► routes/manager_api.py                     businesses
employee portal employee.js ──► routes/employee_api.py                    db_employees
                            ──► routes/schedule_api.py ──► ScheduleJob    db_roles
                                        │                     row          db_shift_templates
                                        ▼ (daemon thread)                  db_schedules
                                services/schedule_jobs.py                  schedule_jobs
                                        │                                  pto_requests
                                        ▼                                  shift_swap_requests
                                scheduler/solver.py (OR-Tools)             users
```

Design rules that matter:

- **No shared in-memory state.** Every request loads its business fresh from
  the database through `services/business_context.py` and saves it back after
  a change. Two Gunicorn workers can never disagree. Demo businesses are the
  exception: they live in memory, are never persisted, and only appear under
  `/demo`.
- **Access control in one place.** `require_business()` resolves the business
  a request is about (explicit id/slug, else the one in the session, else the
  user's first business) and refuses anything the caller does not own.
  `require_employee_access()` does the same for the portal (the employee
  themself or the owner).
- **Generation is a background job.** `POST /api/generate` returns a job id;
  the solver runs on a daemon thread and streams progress into the
  `schedule_jobs` table; the browser polls. Any worker can answer the poll.
- **Notifications never block a request.** `services/notifications.py` gathers
  plain data during the request and sends email/SMS on a daemon thread.
- **Time zones.** The browser sends its local Monday (`weekStart`) with every
  week-scoped request so the server never guesses which week the user means.

---

## Project layout

```
app.py                   Flask app factory; registers blueprints, error handlers
auth.py                  /auth/*: login, register, logout, password change/reset, profile API
config.py                Settings from environment variables
models.py                SQLAlchemy tables + startup column migrations
db_service.py            Convert between dataclasses and rows; schedule persistence
email_service.py         Resend API (preferred) or SMTP; branded templates
sms_service.py           Twilio (optional; no-op when not configured)
routes/
  pages.py               HTML pages: landing, demo, manager app, employee portal, settings, contact
  manager_api.py         Businesses, staff, roles, shifts, coverage, settings, time-off review
  schedule_api.py        Generate / alternative / job status / load / publish / reset
  employee_api.py        Portal: schedule, availability, preferences, time off, swaps
services/
  common.py              Slugs, dates, JSON helpers, page-slug maps
  business_context.py    Business loading + access control + session "current business"
  schedule_jobs.py       Background generation jobs
  notifications.py       Email + SMS dispatch for every event
scheduler/
  models.py              Dataclasses: Employee, Role, ShiftTemplate, CoverageRequirement, Schedule...
  solver.py              The CP-SAT model
  businesses.py          The five demo businesses
static/                  app.js (manager), employee.js (portal), settings.js, CSS
templates/               Jinja templates (index.html is the manager app)
tests/smoke_test.py      End-to-end test against a temporary SQLite database
Procfile, railway.json, runtime.txt, gunicorn.conf.py   Deployment
```

---

## Running locally

Requirements: Python 3.11+ (3.13 works).

```bash
git clone https://github.com/otterholte/StaffScheduler.git
cd StaffScheduler
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
python app.py
```

Open http://localhost:5000. With no `DATABASE_URL` the app uses a local SQLite
file (`staffscheduler.db`) and creates all tables on first start. With no email
settings, password-reset links and invitations are printed to the console
instead of sent.

Optional: create a `.env` file (loaded automatically) with any of the variables
below, e.g. `RESEND_API_KEY` to send real email locally.

---

## Testing

```bash
python tests/smoke_test.py
```

Runs the whole product flow through Flask's test client on a throwaway SQLite
database: registration, business isolation between two managers, staff/roles/
shifts persistence, background generation and polling, publishing, the employee
portal (login, availability, preferences, time off), a full shift swap, the
anonymous demo, and the forgot-password loop. It prints `FAILURES: 0` when
everything passes.

To benchmark the solver on the demo businesses, run a short script like:

```python
from scheduler.businesses import list_demo_businesses
from scheduler.solver import AdvancedScheduleSolver
for b in list_demo_businesses():
    s = AdvancedScheduleSolver(b).solve()
    print(b.name, s.solve_time_ms, s.metrics.to_dict()['coverage_percentage'])
```

---

## Deployment (Railway)

Pushing to `main` on GitHub triggers a Railway deploy. `railway.json` pins the
Nixpacks builder, the start command (`gunicorn app:app -c gunicorn.conf.py`),
and a health check on `/api/health`, which returns the running version.

On start-up the app runs `db.create_all()` (new tables) and then adds any
columns listed in `models._COLUMN_MIGRATIONS` that are missing, so schema
changes deploy without manual SQL. On PostgreSQL it also makes sure the
foreign keys cascade so deleting a business removes everything attached to it.

Gunicorn runs 2 sync workers with a 180 s timeout. Schedule generation runs on
a background thread, so a long solve never ties up a worker.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | production | PostgreSQL URL (a `postgres://` prefix is normalised). Defaults to SQLite locally. |
| `SECRET_KEY` | production | Session signing key. |
| `FLASK_ENV` | production | Set to `production` to enable secure cookies. |
| `SITE_URL` | production | Public base URL used in emails/SMS links (default `https://thestaffscheduler.com`). |
| `RESEND_API_KEY` | for email | Resend API key. |
| `RESEND_FROM_EMAIL` | for email | Verified sender, e.g. `noreply@thestaffscheduler.com`. |
| `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_SERVER`, `MAIL_PORT` | optional | SMTP fallback (blocked on Railway; useful locally). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | for SMS | Twilio credentials. Without them SMS is silently skipped. |
| `TWILIO_FROM_NUMBER` or `TWILIO_MESSAGING_SERVICE_SID` | for SMS | Sending number (E.164) or messaging service. |
| `SUPPORT_EMAIL` | optional | Where the contact form is delivered (default `otterholteli@gmail.com`). |
| `PORT` | auto | Provided by Railway. |

---

## Data model

| Table | What it holds |
|---|---|
| `users` | Logins. Managers have `company_name`; employees have `linked_employee_id`. `promo_code` records sign-up codes. |
| `businesses` | One row per location: hours, open days, coverage mode, peak periods + role coverage (JSON), emoji/colour. |
| `db_roles` | Roles per business. |
| `db_employees` | Staff: roles, hour limits, supervision flags, rate, notification preferences, availability (JSON with both 15-minute ranges and hour slots). |
| `db_shift_templates` | Named shifts with per-role min/max counts and days. |
| `db_schedules` | One row per business per ISO week: full schedule JSON (incl. alternatives history), status draft/published. |
| `db_shift_assignments` | One row per shift block (for querying an employee's shifts). |
| `schedule_jobs` | Background generation jobs: status, progress, result. |
| `pto_requests` | Time-off requests and decisions. |
| `shift_swap_requests`, `swap_request_recipients` | Swap requests, who was asked, responses, counter-offers. |
| `password_reset_tokens` | One-hour reset links. |
| `business_settings`, `user_business_settings` | Scheduling policy JSON per business (and per user for demos). |

Business ids look like `user_<owner id>_<slug>`; URLs use the slug of the
business name and are resolved only among the businesses the caller owns.

---

## API overview

All JSON. Manager endpoints accept `businessId` in the body or query string
(the browser adds it automatically); paths marked `<business>` accept the id or
slug.

**Schedule**
- `POST /api/generate`, `POST /api/alternative` → `{job_id}`
- `GET /api/schedule/job/<id>` → status, progress, result
- `GET /api/schedule/load?weekStart=YYYY-MM-DD`
- `POST /api/schedule/publish` (notifies staff), `POST /api/reset`

**Businesses / settings**
- `GET /api/businesses`, `POST /api/business/<business>` (switch), `POST /api/business/save`, `DELETE /api/business/<business>`
- `GET|POST /api/business/<business>/settings` (scheduling policies)
- `GET|PUT /api/settings` (hours, days), `/api/<business>/settings/roles[...]`
- `/api/settings/shifts[...]`, `/api/settings/peak-periods`, `/api/settings/role-coverage[...]`, `/api/settings/coverage-mode`, `/api/coverage`

**Staff**
- `GET|POST /api/employees`, `PUT|DELETE /api/employees/<id>`, `POST /api/employees/<id>/invite`
- `PUT /api/employees/<id>/availability`, `PUT /api/<business>/employees/<id>/availability`, `PUT /api/employees/<id>/availability-cell`
- `GET /api/<business>/pto`, `GET /api/<business>/pto/pending/count`, `PUT /api/<business>/pto/<id>/approve|deny`

**Employee portal** (login required; the employee or the owner)
- `GET /api/employee/<business>/<db_id>/schedule`
- `PUT /api/employee/<db_id>/availability`, `PUT /api/employee/<db_id>/preferences`
- `GET|POST /api/employee/<business>/<db_id>/pto`, `DELETE .../pto/<id>`
- `GET .../swap-requests`, `POST .../swap-request`, `POST .../swap-request/<id>/respond|cancel`, `GET .../eligible-for-swap`
- `GET /api/<business>/pto/approved`

**Other**
- `GET /api/health`, `POST /api/contact`, `GET /api/email/status`

---

## Operational notes

- **Demo businesses** are rebuilt from code per process; edits made on the demo
  page are shared by whoever hits the same worker until restart. That is
  intentional: it is a sandbox.
- **Founding-members promo:** the code `FOUNDER50` is captured on the `users`
  row at registration. There is no billing system yet; plan limits are not
  enforced.
- **Repository visibility:** this is proprietary software (see LICENSE). Make
  the GitHub repository private in the repository settings if it is not already.

---

## License

Copyright (c) 2026 Staff Scheduler. All rights reserved. See [LICENSE](LICENSE).
