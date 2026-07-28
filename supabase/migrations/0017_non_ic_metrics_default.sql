-- 0017 — keep managers and leadership out of per-engineer denominators by default.
--
-- What include_in_metrics actually does, which is the part worth being precise about: it
-- gates the engineers table only — headcount, cohorts, the people directory, the
-- per-engineer and per-week rates. It does NOT gate v_merge_requests, v_commits,
-- v_review_events or v_jira_issues. So excluding someone stops them diluting a rate
-- without deleting a single thing they shipped; their work still counts towards their
-- squad and still appears on their own profile.
--
-- That distinction is why this is the right default rather than a judgement call about
-- whose contribution matters. An engineering manager who ships two merge requests a month
-- is doing their job; averaging them in with eight ICs makes the squad look 20% slower
-- than it is. This directory has four engineering managers, a CTO and a head of DevOps
-- among twenty heads — a third of the denominator.
--
-- Recorded with a source, like squad and seniority already are, so a choice made in the
-- admin screen survives every later sync. Only 'auto' rows are ever recomputed.

alter table engineers
  add column if not exists include_in_metrics_source text not null default 'auto'
    check (include_in_metrics_source in ('auto', 'manual'));

comment on column engineers.include_in_metrics_source is
  'auto = derived from job title by the HiBob sync; manual = set in the admin screen and never overwritten.';

-- Apply the default to the rows that have never been touched by hand. Deliberately not a
-- trigger: a title-matching rule belongs where it can be read and unit-tested
-- (src/lib/sync/matching.ts, isNonIcTitle), and the sync applies it on every run. This
-- statement exists so existing rows pick it up without waiting for a HiBob sync, and it
-- keeps the same word list.
update engineers
set include_in_metrics = false
where include_in_metrics_source = 'auto'
  and include_in_metrics
  and job_title is not null
  and (
    job_title ~* '\ymanager\y'
    or job_title ~* '\yhead of\y'
    or job_title ~* '\ydirector\y'
    or job_title ~* '\yvp\y'
    or job_title ~* '\yvice president\y'
    or job_title ~* '\ychief\y'
    or job_title ~* '^(cto|ceo|coo|cpo|cio)\y'
  );
