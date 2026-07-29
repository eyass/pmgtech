# Measuring engineering performance

**Telemetry describes. Humans evaluate.**

Four dimensions, used at two altitudes. Live in the app at `/performance`.

| Dimension | Team question | Individual question | Assessed by |
| --- | --- | --- | --- |
| **Flow** | Does work move, or does it queue? | Is their work getting stuck, and where? | Telemetry + human |
| **Quality** | Does what we ship stay working? | Are they shipping safely? | Telemetry + human |
| **Collaboration** | Is knowledge shared, or concentrated? | Are they multiplying others? | Telemetry + human |
| **Impact** | Was the work worth building? | Did they work on the right things? | **Human only** |

At **team level** these are performance metrics; managing on them is reasonable. At **individual
level** they are inputs to a conversation. The tool shows a profile shape and a within-level band,
never a score and never a ranking.

---

## Why not just count merge requests

Because the countable things punish the behaviour you want.

An engineer who spends Tuesday unblocking three colleagues ships less that week than one who
head-down closes tickets. A dashboard that ranks on throughput tells the first engineer to stop
helping. Do that for two quarters and you have a team of individually productive people who cannot
ship anything that spans more than one person's head.

Every metric here is therefore **paired with a counter-metric**, so pushing one alone shows up as a
regression in the other:

| Push this | And this degrades |
| --- | --- |
| Merge-request throughput | Review coverage received, reverts authored |
| Speed / cycle time | Merge-request size, change failure rate |
| Reviews given | Review depth — approving without reading is visible |
| Story points closed | Unplanned-work share |

## The four guardrails

Enforced in SQL (`supabase/migrations/0010_performance_rpcs.sql`, amended by
`0018_material_performance_bands.sql`), not in the UI, so a future caller cannot bypass them:

1. **Within-level only.** Percentiles are computed against the engineer's own seniority cohort.
   Comparing a junior to a staff engineer is meaningless and is not offered.
2. **Minimum sample.** Bands are suppressed below 5 merged merge requests *and* 5 resolved issues in
   the period.
3. **Minimum cohort.** Bands are suppressed when fewer than 3 people share a level, because with two
   people a "comparison" just names one of them.
4. **Minimum difference.** A band reads `above` or `below` only when the gap from the cohort median
   is large enough to matter; otherwise it reads `typical`. A rank on its own always finds a top and
   a bottom quartile, even among five seniors whose cycle times are 19, 20, 20, 21 and 22 hours —
   and the 22-hour engineer does not deserve to be asked what is slowing them down.

| Banded metric | Has to differ from the cohort median by |
| --- | --- |
| Median cycle time | 25%, relative — the same proportion is hours in a slow cohort and minutes in a fast one |
| Review coverage received | 10 percentage points, absolute — it is already a percentage, so a relative test would compound |
| Reviews given | 2 reviews **and** 25% — the floor stops 1-vs-2 reading as a doubling, the percentage stops a large median hiding 12-vs-20 |

`insufficient` and `typical` are different statements and stay distinct: the first means the tool
cannot see enough to have an opinion, the second means it can see and the engineer sits with their
cohort. Profile shape is deliberately exempt — it is descriptive rather than evaluative, so landing
just either side of the median costs nobody anything.

And a fifth guardrail by omission: **there is no composite individual score.** Nothing to sort by,
nothing to stack-rank on. This is deliberate — "reviews a lot, ships less" is information, and
flattening it to a number destroys exactly the signal a manager needs.

---

## What each metric is

### Flow

| Metric | Definition | Watch out |
| --- | --- | --- |
| Lead time | Median hours, first commit → merge | Excludes deploy on purpose: measures what the team controls |
| Flow efficiency | Working time ÷ elapsed time, from the Jira changelog | Below 15% means the team mostly waits. A **system** property |
| Batch size | Median lines changed per MR | Large batches slow review and raise defect risk |
| WIP per engineer | Open MRs ÷ headcount | High WIP usually explains bad lead time |
| Deploy frequency | Successful production deploys per week | Depends on environment naming being right |

**Flow efficiency is the most useful number in the framework.** It separates "the team is slow" from
"the team is waiting", and those need opposite interventions. If it reads 12%, no individual on that
squad will look fast, and coaching them on speed is the wrong move.

### Quality

| Metric | Definition | Watch out |
| --- | --- | --- |
| Change failure rate | Failed production deploys ÷ finished ones | In-flight deploys excluded, not assumed good |
| Time to restore | Median failed deploy → next success | Unrecovered failures excluded, so an open incident can't skew it |
| Review coverage | Share of merged MRs with ≥1 reviewer | The one quality signal that is genuinely per-author |
| Reverts | Commits whose message starts with `revert` | A proxy. Can be someone cleaning up another's mistake |
| Production bugs | Bug/incident tickets labelled production-affecting | Depends on our label conventions — see issue #9 |

Someone doing the hardest, least certain work will read worse here than someone doing routine work.
That is a property of the work, not the person.

### Collaboration

The most under-measured dimension, and where senior leverage actually lives.

| Metric | Definition | Watch out |
| --- | --- | --- |
| Reviews given | Comments + approvals on others' MRs | Self-comments excluded |
| Review depth | Median comment length in characters | Very low = rubber-stamping. This is the anti-gaming pair for review count |
| Threads raised | Resolvable review threads opened | Real requests rather than bare approvals |
| Response time | Median MR open → their first comment | |
| Colleagues reviewed for | Distinct authors | Low + high review count = reviewing only one person's work |
| Reviews for more junior | Reviews where the author is a level below | Closest telemetry gets to mentoring |
| **Review load Gini** | 0 = evenly shared, 1 = one person carries everything | Above 0.6 = review bottleneck and a single point of failure |
| **Knowledge concentration** | Top author's share of a repo's commits | Above 60% is a staffing risk no other metric surfaces |

### Impact

**Human only.** The numbers on this dimension (work-type mix, unplanned-work share, sprint
predictability) are context for a conversation, not a measure.

Telemetry cannot see business value, judgement, technical direction, or a hard problem avoided
entirely. The most valuable engineering work of a quarter is sometimes a design document that stopped
a project. It produces no merge requests.

This is why the app has an assessment form: the rating that counts is the one a human writes, with
evidence, in `engineer_assessments`. The server **rejects a rating submitted without evidence** —
an unevidenced number is not reviewable six months later and is how review cycles become recency
bias.

---

## Profile shapes

Descriptive, not grades. Derived from ship-vs-review balance against the cohort median.

| Shape | Means | Usually |
| --- | --- | --- |
| **Anchor** | Above median on both shipping and reviewing | Carrying load in both directions |
| **Shipper** | Ships above median, reviews below | Check whether review is being crowded out |
| **Multiplier** | Reviews above median, ships below | Often exactly right for a senior — their output is other people |
| **Quiet in telemetry** | Below median on both | **This tool cannot see their work. Not the same as no work.** |

"Quiet in telemetry" is the label that most needs care. Design work, incident response, pairing,
on-call, mentoring outside code review, and anything discussed in person all produce nothing this
tool can count. Assess those people on human input alone.

---

## Running a review

1. **Read the team page first.** Most of what looks like an individual problem is a system one.
2. **Look at the shape, not the counts.** Does it match what you asked of them?
3. **Treat every band as a question.** "Your cycle time is longer than others at your level — what's
   in the way?" is useful. "You're below target" is not — there is no individual target here.
4. **Write the Impact assessment yourself.** It matters most and telemetry cannot reach it.
5. **Check the "no comparative read" list.** Those people are invisible to the tool, not
   underperforming.

### Do not

- Rank people on any number here, or build a leaderboard from the profile table.
- Set individual targets on flow, quality or collaboration metrics. Targets belong to squads.
- Use these numbers as the primary evidence in a performance-management process. They are one input
  to a judgement a human owns.
- Compare across seniority levels, or across squads doing different kinds of work.

---

## Calibration

Team targets live in `src/lib/types/performance.ts` (`TEAM_TARGETS`) and are loosely based on DORA's
published bands. They are a starting point, not universal truth — after a quarter of real data,
recalibrate them to what good actually looks like here. They are the only place in the app where a
metric is judged against an absolute number, and they apply to squads only.

The `>= 5 MRs` and `>= 3 peers` thresholds are in the `engineer_profiles` RPC, alongside the
materiality gates (25% on cycle time, 10 points on coverage, 2 reviews and 25% on reviews given).
Raise any of them if the bands feel noisy; do not lower them. If a band still reads `above` or
`below` for someone who is plainly in the middle of their cohort, the gate is too loose, not the
rank — that is the number to change.
