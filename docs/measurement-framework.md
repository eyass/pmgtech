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
level** they are inputs to a conversation — plus, since the Outliers page, a score and a ranking.
See [Scoring and ranking](#scoring-and-ranking) for what the score is, and what it still refuses to
do.

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

---

## Scoring and ranking

This section used to say there was no composite individual score — nothing to sort by, nothing to
stack-rank on. That changed by decision: `/outliers` scores engineers and squads 0-100 and ranks
both. The reasoning that produced the old position has not been thrown away, though, because it was
about a specific failure — a single number that flattens "reviews a lot, ships less" into a grade,
and that nobody can take apart afterwards. The score is built against that failure:

| Property | Engineers | Squads |
| --- | --- | --- |
| Baseline | The median of their **own seniority cohort** | **Absolute targets**, not the other squads |
| What 50 means | The cohort median — not half marks | Halfway between the bad and good thresholds |
| Scale | ±1 interquartile range of the cohort's spread = ±15 points | Linear between `bad` = 0 and `good` = 100 |
| Weights | Four dimensions, 25 each | Four dimensions, 25 each |
| Missing data | Dimension drops out, remaining weights renormalise — never a zero | Same |

Dimension inputs, and the within-dimension weights:

| Dimension | Engineers | Squads |
| --- | --- | --- |
| Throughput | Complexity-weighted MRs ×2, resolved issues ×1 | Weighted MRs per engineer per week ×2 (good 4, bad 1), production releases per week ×1 (good 5, bad 1) |
| Flow | Median cycle time | Median cycle time (good 24h, bad 120h) |
| Quality | Review coverage received ×2, large-MR share ×1, reverts ×1 | Change failure rate (good 15%, bad 30%), time to restore (good 4h, bad 24h) |
| Collaboration | Reviews given ×2, colleagues reviewed for ×1 | Review coverage (good 90%, bad 60%), reviews per engineer per week (good 8, bad 2) |

Six of the squad thresholds are the team targets already used on `/performance`. The two
per-engineer rates are new, and were set from this org's own spread rather than from anything
published — they are the most arguable numbers in the scoring and they live in exactly one place,
`0021_outliers.sql`.

### Complexity weighting: why a merge request is not one unit

Counting merge requests makes a three-line change and a nine-hundred-line refactor worth the same,
which is gameable in one obvious direction — split the work, ship more units, score higher. So the
throughput dimension counts **weighted** merge requests (`0022`, `0023`):

```
points = log₂(1 + churn ÷ median churn) × breadth,  capped at 6, floored at 0.1
```

| Property | Why it is that shape |
| --- | --- |
| The unit is the org's own median merged MR for the period | Self-calibrating. A team whose normal change is 40 lines and one whose normal change is 400 each get a scale that fits, and no line count is invented here. A median MR scores 1.0. |
| Sublinear — 63× the lines is 6× the weight | Rewarding churn linearly would move the gaming from many-small to one-enormous, which is worse: large changes are harder to review. |
| Capped at 6 | One vendored-dependency dump or generated-file commit cannot outscore a quarter of someone's real work. |
| Floored at 0.1 for ≤10 lines in a single file | The teeth. Twenty of those are worth two median merge requests, not twenty. |
| Counts **authored** churn — generated files excluded | A `package-lock.json` bump is 5,000 lines and no engineering. Measured: it scores **0.12** on authored churn against **5.61** on total churn, so without this the cheapest way to a top score would be bumping dependencies. Needs file paths, which GraphQL `diffStats` supplies without the diff bodies REST bundles in. |
| Breadth counted by directory, not file | Thirty files in one directory is one change; the file count was flattering it. |
| Breadth multiplier, up to 1.5× | Coordinating a change across thirty files is work a line count alone misses. |

Counter-metric, per the rule above: throughput now rewards size, and **quality already penalises
it** — `large_mr_pct`, review coverage received and review iterations all degrade as merge requests
grow. Pushing one moves the other.

Three limits worth knowing before quoting a weighted number:

- **It is size, not cognitive complexity.** Nothing parses source, so nesting, coupling and
  cleverness are invisible. A change that took three days to find and one line to fix scores 0.1,
  exactly like a typo fix, and no telemetry here can tell them apart. The raw count sits next to the
  weighted one for that reason.
- **Resolved issues are still a plain count.** Jira has no comparable size signal — story points
  cover under 10% of issues here — so that half of the throughput dimension remains
  splittable. It is the remaining gaming surface, and it is deliberate rather than overlooked.
- **The basis is chosen once, org-wide.** Below 60% of merged MRs having a measured size, throughput
  falls back to counting them, for everyone, and `throughput_basis` says so on every row. Mixing
  weighted and unweighted rows inside one seniority cohort would put two units in the same
  percentile and the median would mean nothing.

### What the score still will not do

- **It will not compare across levels.** Percentile bands and the score both use the seniority
  cohort. A junior is never measured against a staff engineer.
- **It will not pretend to be precise.** Every ranked row carries the materiality tally beside its
  score. Where the tally reads `even`, the gap that produced the rank did not clear the gates in the
  table above, and the ordering is ordering — not distance. In a team doing similar work, most rows
  read `even`, and that is the correct answer rather than a failure to discriminate.
- **It will not hide thin data behind a number.** A score built on two merged merge requests, or
  against a cohort of one, still appears — but flagged `thin data` or `no cohort`, with the reason.
- **It will not become the assessment.** The performance assessment of record is still the one a
  human writes, recorded on the person's page. Impact carries no telemetry at all and therefore
  contributes nothing to the score, which is itself a statement about the score's ceiling: the
  dimension that asks whether the work was worth building is the one it cannot see.

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

- Read the ranking on `/outliers` as an ordering of people's worth, or paste it into a calibration
  meeting as the input. It ranks four dimensions of telemetry, one of the four dimensions is missing
  from it entirely, and the rows that read `even` are not distinguishable from each other.
- Act on a score flagged `thin data` or `no cohort` without opening the person's page first.
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
