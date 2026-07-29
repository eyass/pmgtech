# PMG Engineering Tracker

Delivery health for the PMG engineering org, split by squad — **Team Buyer**,
**Team Seller**, **Team Monetization**, **Team Growth** and **DevExp** — built
from GitLab, Jira and HiBob.

Next.js 16 on Vercel, Postgres on Supabase. Aggregation happens in Postgres, so a
page render is a handful of RPC calls rather than a fan-out of row fetches.

---

## What it shows

| Page | Answers |
| --- | --- |
| **Overview** | The four DORA metrics for the whole org, squad comparison, throughput and lead-time trends, and a list of merge requests that need a human. |
| **Squads** | Every metric side by side, normalised per engineer per week so squads of different sizes are comparable. Work-type mix and the review flow between squads. |
| **Squad detail** | One squad's trends, its sprints, its people, and its stuck merge requests. |
| **Delivery** | DORA with each definition stated inline, plus where merge requests actually lose time. |
| **Sprints** | Committed vs added mid-sprint vs completed, carryover, and scope creep. |
| **People** | Per-engineer activity, benchmarked against the median for their own level rather than the whole org. |
| **Admin** | Connection status, squad/board/repo mappings, unmapped identities, sync history. |

### On individual metrics

The people pages are activity counts, not performance ratings. Volume depends
heavily on what someone is assigned, and time spent reviewing, mentoring, on
incidents and on design does not show up in a merge-request count. Seniority
benchmarks deliberately hide any level with fewer than two people so no
individual is singled out by a median.

---

## Setup

### 1. Database

The schema is already applied to the Supabase project `pmgtech`
(`ihkfzsiplnpskkjihdho`, eu-west-1). To recreate it elsewhere, run the files in
`supabase/migrations/` in order.

### 2. Google sign-in

In **Supabase → Authentication → Providers → Google**, enable the provider and
paste a Google OAuth client id and secret. In the Google Cloud console, add this
authorised redirect URI:

```
https://ihkfzsiplnpskkjihdho.supabase.co/auth/v1/callback
```

Then in **Supabase → Authentication → URL Configuration**, set the site URL to
your Vercel domain and add `https://<your-domain>/auth/callback` to the redirect
allow-list.

Domain restriction is enforced server-side in `src/proxy.ts` and again in the
OAuth callback, so a non-`@petmediagroup.com` Google account never ends up with a
valid session. The `hd` parameter passed to Google is only a hint.

### 3. Credentials

Copy `.env.example` and fill it in. The three integration tokens need:

- **GitLab** — a personal or group access token with `read_api`, plus
  `GITLAB_GROUPS` (subgroups are discovered automatically).
- **Jira Cloud** — an API token from
  [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens),
  the account email, and the project keys to track. Check your story-point and
  sprint custom-field ids at `/rest/api/3/field` — the defaults are common but
  per-instance.
- **HiBob** — service-user id and token. It only needs read access to the people
  fields listed in `src/lib/integrations/hibob.ts`; no compensation data is read.

Nothing breaks if a source is unconfigured — the app renders and the admin page
tells you exactly which variables are missing.

### 4. Deploy

Import the repo in Vercel, add the environment variables, deploy. `vercel.json`
registers a cron that hits `/api/sync` once a day at 03:00 UTC; Vercel sends
`CRON_SECRET` as a bearer token automatically once that variable exists.

Three things catch people out on the first deploy:

- **Cron frequency is plan-gated.** Hobby accounts allow one cron run per day, and
  Vercel rejects the whole deployment at config validation if `vercel.json` asks
  for more — no deployment record is created at all, so the project looks untouched
  rather than failed. The committed schedule is daily so it deploys on any plan. On
  Pro, `0 */3 * * *` is the schedule you actually want.
- **Daily crons are too slow for the initial backfill.** Each run stops on a
  ~300-second budget and resumes from its cursors, so a 12-month first pass would
  take many days at one run per day. Drive the backfill from the admin page instead
  and let the cron keep it current afterwards.
- **Production only ever builds `main`.** Vercel builds the production branch, so
  unmerged code isn't live however green its preview is — merge to `main` to deploy.
  Don't shortcut that by pointing **Settings → Git → Production Branch** at a
  feature branch; production ends up tracking a branch that later gets deleted.
  Branch pushes still get preview deployments.

Set the environment variables for Preview as well as Production if you want branch
deployments to work — a preview build with no `NEXT_PUBLIC_SUPABASE_URL` compiles
fine, because every route is dynamic, and then throws on each request instead.

### 4a. If you deploy with `DISABLE_AUTH=true`

`DISABLE_AUTH` is not a read-only preview switch. `currentUser()` returns a
synthetic user with `isAdmin: true`, which satisfies the `requireAdmin()` check in
front of every server action — so anyone who can load the page can also reassign
squads, override seniority levels, exclude people from metrics, remap repositories
and boards, and write performance assessments. Server actions are POST endpoints;
the UI hiding a button is not a control.

`/api/sync` is the exception: it authorises independently in
`src/lib/sync/auth.ts` and ignores `DISABLE_AUTH`, so an anonymous caller gets a
401 and cannot trigger a sync.

If you deploy this way to see the app before Google sign-in is configured, turn on
**Settings → Deployment Protection → Vercel Authentication** so the URL is gated
by Vercel SSO. Never leave `DISABLE_AUTH=true` on a publicly reachable
deployment, and turn it off before the first real HiBob or GitLab sync puts
personnel data in the database.

### 5. Check GitLab before syncing

```bash
npm run check:gitlab
```

Read-only preflight — writes nothing and needs no database access, so it runs before
`SUPABASE_SERVICE_ROLE_KEY` exists. It reports whether the token is valid and has `read_api`, which
projects the sync would discover, how many merge requests are in the backfill window, and roughly
how many API calls and cron runs the first sync will take. It also warns when a group has no GitLab
Deployments, which is the usual reason deploy frequency, change failure rate and MTTR come back
empty.

Add the token without putting it in a chat message or your shell history:

```bash
read -rs TOKEN && echo "GITLAB_TOKEN=$TOKEN" >> .env.local && unset TOKEN
echo 'GITLAB_GROUPS=your-group' >> .env.local
```

`.env.local` is gitignored. To let the sync actually write to Supabase you additionally need the
service-role key, added the same way:

```bash
read -rs KEY && echo "SUPABASE_SERVICE_ROLE_KEY=$KEY" >> .env.local && unset KEY
```

### 6. First sync

Run these in order from the admin page (HiBob first — it builds the directory
that the other two resolve their authors against):

1. **HiBob only** — creates the engineer directory with seniority and squads.
2. **Jira only** — projects, boards, sprints, issues, changelog.
3. **GitLab only** — repositories, merge requests, reviews, commits, deploys.

Then finish the mapping:

- Map each **Jira board** to a squad. This is what makes sprint metrics work.
- Map each **GitLab repository** to its owning squad. Used as the fallback for
  activity whose author cannot be resolved.
- Work through **unmapped identities** — GitLab and Jira accounts whose email did
  not match anyone in HiBob. Linking one re-attributes that person's whole
  history immediately, without a re-sync.

A twelve-month backfill will not finish in one request; see below.

---

## How it works

```
HiBob  ─→ engineers (identity, seniority, squad)
              ↑ resolved by email
GitLab ─→ merge requests · review notes · commits · deploys · pipelines
Jira   ─→ projects · boards · sprints · issues · status changelog
              ↓
        Postgres views + aggregation RPCs
              ↓
        Next.js server components
```

### Identity resolution

HiBob decides who exists. GitLab and Jira identities are matched to those people
by email, and the link is persisted so later runs skip straight to a cache hit.

There is deliberately **no fuzzy name matching** — two engineers called "J.
Smith" would silently merge, and attributing one person's work to another is
worse than leaving a row unmapped. Anything unresolved lands in
`unmatched_identities` for triage on the admin page, ranked by how many events it
represents.

### Squad attribution

People-first, with fallbacks:

- **Merge requests, commits, reviews** — the author's squad, falling back to the
  squad that owns the repository.
- **Jira issues** — a manual override, then the sprint's board, then the
  assignee's squad, then the Jira project's squad.

### Resumable sync

One merge request costs four GitLab API calls (detail, commits, notes,
approvals), so a twelve-month backfill of a real org cannot finish inside a
serverless invocation.

Merge requests are therefore fetched oldest-updated-first, and the per-project
cursor advances to the last MR actually written. When the time budget runs out
the run records `partial` and stops cleanly; the next run resumes exactly where
it stopped. Pressing **Full backfill** repeatedly, or just letting the cron run,
walks steadily through history without duplicating work.

### Metric definitions

- **Deploy frequency** — successful GitLab deployments to a production
  environment per week. Which environments count is configurable in
  `app_settings.production_environment_patterns`.
- **Lead time for change** — median hours from the first commit on a branch to
  the merge. Excludes the deploy step, so it measures what the team controls.
- **Change failure rate** — failed production deploys as a share of those that
  finished. Still-running deploys are excluded, not assumed successful.
- **Time to restore** — median hours from a failed production deploy to the next
  success on the same project and environment. Failures never followed by a
  success are excluded, so an open incident cannot skew the median.
- **Sprint commitment** — reconstructed from the Jira changelog. An issue is
  *committed* if it was in the sprint before the start date and *added* if it
  joined later. Sprints whose changelog Jira has truncated fall back to the
  sprint start date, which can understate scope creep on very old sprints.

### Security

- All reads go through the service-role key in server components. The browser
  never holds a key that can read data.
- RLS is enabled on every table. The `anon` role can read nothing and cannot
  execute any RPC — verified, not assumed.
- `app_settings` and `app_admins` are service-role only.
- Admin mutations re-check admin status server-side; hiding a button is a
  convenience, not a control.
- If `app_admins` is empty, every allowed-domain user is an admin, so the app is
  usable straight after deploy. Add rows to restrict it.

---

## Development

```bash
npm install
cp .env.example .env.local   # fill in Supabase keys at minimum
npm run dev                  # DISABLE_AUTH=true skips Google sign-in locally
```

```bash
npm run typecheck
npm run build
```

Adding a metric usually means editing one migration and one page: define the
aggregation in `supabase/migrations/`, add its row type to
`src/lib/types/metrics.ts`, expose it in `src/lib/queries.ts`, then render it.

### Layout

```
supabase/migrations/     schema, views, aggregation RPCs, RLS
src/lib/integrations/    GitLab, Jira, HiBob API clients
src/lib/sync/            sync orchestration, identity resolution, cursors
src/lib/queries.ts       the read layer used by every page
src/app/                 pages, sync route, auth routes
src/components/          UI primitives and charts
```
