# Watchlist Workflow

This project should treat today's trade ideas and multi-day swing setups as different objects.

## Two Lists

### 1. Daily Trade Candidates

Purpose:

- capture names that matter for the current session
- expire them by the close unless promoted
- focus on open-drive, earnings continuation, same-day momentum, or event-driven intraday setups

Typical statuses:

- `new`
- `actionable_today`
- `watch_intraday`
- `passed_today`
- `expired_today`
- `promoted_to_swing`

Lifecycle rules:

1. New candidates are created from the daily source bundle.
2. A candidate becomes `actionable_today` only if trigger, volume, relative strength, and reward-to-risk line up.
3. A candidate becomes `promoted_to_swing` only if the catalyst and chart still have multi-day potential.
4. Unused candidates should become `expired_today` by end of session.

### 2. Swing Watchlist

Purpose:

- track multi-day setups across sessions
- preserve thesis, trigger, invalidation, and review history
- stop recycling every name as if it were brand new each morning

Typical statuses:

- `active_watch`
- `actionable`
- `in_trade`
- `expired`
- `invalidated`
- `passed`
- `closed`

Lifecycle rules:

1. A swing candidate starts with a thesis, trigger, invalidation, first target, and expiry rule.
2. It remains `active_watch` until it either triggers, expires, or breaks.
3. It becomes `actionable` only when the setup is live and reward-to-risk is acceptable.
4. It becomes `in_trade` once a position is opened.
5. It becomes `invalidated` when price breaks the setup.
6. It becomes `expired` when the catalyst window or hold window closes without triggering.

## Promotion Rules

A daily candidate can be promoted into the swing watchlist only when all of these are true:

- the catalyst can matter for more than one session
- the setup still has a clean trigger after day one
- invalidation is clear and nearby enough to control risk
- first target still supports at least `2:1` reward-to-risk
- no near-term event risk makes the hold irrational

Examples:

- earnings gap that holds and builds a 2 to 3 day base
- sector catalyst with improving relative strength
- pullback into support after a valid breakout day

Examples that should not promote:

- one-day rumor pop with no follow-through
- highly extended move with no clean re-entry
- catalyst already fully priced with fading volume

## Dashboard Changes

The dashboard should separate these sections:

1. `Today's Trade Candidates`
2. `Active Swing Watchlist`
3. `Resolved / Archived`

Each daily candidate card should show:

- session status
- catalyst
- trigger
- invalidation
- first target
- promotion eligibility

Each swing watch card should show:

- original thesis
- first identified date
- last reviewed date
- current status
- trigger
- invalidation
- first target
- expiry rule
- review history

## Recommended Storage

Store the two lists separately:

- `data/watchlists/daily/YYYY-MM-DD.json`
- `data/watchlists/swing/current.json`
- `data/watchlists/swing/archive/YYYY-MM-DD.json`

This keeps the daily pipeline disposable while allowing the swing book to persist.

## Implementation Order

1. Add the two JSON schemas in `schemas/`.
2. Write current-day candidates to `data/watchlists/daily/YYYY-MM-DD.json`.
3. Create a promotion step from daily candidate to swing watch candidate.
4. Render separate dashboard sections for daily and swing lists.
5. Add a review action that updates `lastReviewedAt`, `status`, and `reviewHistory`.
