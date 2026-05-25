# Premarket AI

A small, standalone workflow for turning market emails into a daily pre-market briefing.

The first version is intentionally simple:

- Drop exported or pasted emails into `inbox/YYYY-MM-DD/`.
- Run `npm run build`.
- Review the dashboard in `public/dashboard.html`.

`npm run build` now performs the Gmail import first and then runs the full local pipeline. If you want to rebuild from the files already present in `inbox/YYYY-MM-DD/` without importing Gmail again, use `npm run build:core`.

Later, this can connect to Gmail directly by reading a dedicated label such as `Market Brief`.

## Quick Start

```sh
cd /Users/tonyday/premarket-ai
npm install
npm run build
```

By default, the script uses today's date and reads:

```text
inbox/YYYY-MM-DD/
```

You can run a specific date:

```sh
npm run brief -- --date 2026-04-19
npm run dashboard
```

## Dashboard

The dashboard is generated as a static HTML file:

```text
public/dashboard.html
```

It includes:

- ranked buy candidates
- swing-trade setup classification for pullbacks, breakouts, catalyst continuation, reversals, and risk-watch names
- trigger, stop/invalidation, target, sizing, and avoid rules for each actionable setup
- macro pressure and before-buying checks
- today's ingested sources
- extracted article links when found in email bodies
- detected tickers and nearby source notes
- current themes
- calendar-style events
- trend memory across all files in `data/daily/`
- links to the source bundle and LLM prompt

The project is moving toward two separate watchlists:

- `Daily Trade Candidates`: current-session ideas that expire by the close unless promoted
- `Swing Watchlist`: persistent multi-day setups that survive across sessions until triggered, invalidated, expired, or closed

See:

- [Watchlist Workflow](/Users/tonyday/premarket-ai/docs/watchlist-workflow.md)
- [Daily Trade Candidates Schema](/Users/tonyday/premarket-ai/schemas/daily-trade-candidates.schema.json)
- [Swing Watchlist Schema](/Users/tonyday/premarket-ai/schemas/swing-watchlist.schema.json)

This is a decision-support dashboard for swing-trading research. Its job is to rank buy candidates, organize source-backed context, help you notice recurring catalysts, and give you a repeatable pre-market foundation.

The swing-trading layer is intentionally rules-based. It does not invent prices or recommendations; it turns the source-backed ticker evidence into a checklist for the trade decision: direction, entry trigger, invalidation, target logic, position-sizing caution, and pass conditions.

## Input Files

Supported file types:

- `.txt`
- `.md`
- `.eml`
- `.html`

For the first pass, save emails manually into the daily folder. Gmail can export individual messages via "Download message", or you can copy/paste the body into a `.txt` file.

There is a sample input in `examples/sample-market-email.txt`. To try it:

```sh
npm run brief -- --input examples --date sample
```

## Optional AI Generation

Without an API key, the script writes a source bundle and prompt file that you can paste into ChatGPT or another LLM.

With an API key, it can call OpenAI directly when `GENERATE_FINAL_BRIEFING=true`:

```sh
export OPENAI_API_KEY="..."
export GENERATE_FINAL_BRIEFING=true
npm run brief
```

Then rebuild the dashboard:

```sh
npm run dashboard
```

Optional:

```sh
export OPENAI_MODEL="gpt-5.4-mini"
```

## Gmail Plan

Recommended eventual setup:

1. Create a Gmail label named `Market Brief`.
2. Add Gmail filters that apply the label to useful newsletters and alerts.
3. Let this project fetch unread or recent labeled messages.
4. Mark processed messages or store their IDs so each email is used once.

## Gmail Import

The Gmail importer reads messages from the labels in `config/gmail-labels.json`, buckets each message into `inbox/YYYY-MM-DD/` using the message's local delivery date, and tracks processed message IDs in `state/gmail-processed.json`.

If you pass `--date YYYY-MM-DD`, the importer treats that as a date filter and only imports messages whose local delivery date matches that day.

For repeatable source onboarding, use the playbook here:

- [Add Email Source Playbook](/Users/tonyday/premarket-ai/docs/add-email-source-playbook.md)

To set it up:

1. Create a Google Cloud project.
2. Enable the Gmail API.
3. Configure OAuth consent for a desktop/local app.
4. Create an OAuth Client ID with application type `Desktop app`.
5. Download the OAuth JSON file as `credentials.json`.
6. Place it at `/Users/tonyday/premarket-ai/credentials.json`.
7. Run:

```sh
npm install
npm run gmail:import
npm run build
```

After the first browser authorization, daily use can be:

```sh
npm run daily
```

## Optional Article Enrichment

Some newsletter emails include canonical article URLs. The generator extracts those links and stores them in the daily JSON and dashboard.

There is also an optional fetch step:

```sh
npm run fetch-links -- --date 2026-04-20
```

It attempts to fetch article details and stores results under `data/articles/`. This step is best-effort only. CNBC and some other publishers may return `403` or otherwise block automated fetching.

Suggested labels for the newsletters you added:

```text
Market Brief/CNBC/Breaking News
Market Brief/CNBC/Disruptors
Market Brief/CNBC/Morning Squawk
Market Brief/CNBC/The Exchange
Market Brief/CNBC/Jims Top 10
```

Current source weighting:

```text
CNBC Jim's Top 10: highest CNBC weight for pre-market buy ideas
CNBC Morning Squawk: high weight for pre-market setup
CNBC The Exchange: medium weight for intraday catalyst context
CNBC Breaking News: medium weight for urgent catalysts
CNBC Disruptors: lower direct-trade weight, useful for theme discovery
```

## Portable Setup

This project is ready to live in Git and be cloned onto another machine, but private inbox content and credentials should stay local.

What to commit:

- `scripts/`, `schemas/`, `docs/`, `prompts/`, and `config/`
- `package.json` and `package-lock.json`
- `README.md`
- sample fixtures under `examples/`
- reusable historical examples under `reports/` and selected `data/daily/`

What not to commit:

- `.env`
- `credentials.json`
- `token.json`
- `data/schwab/oauth.json`
- raw inbox email under `inbox/`
- generated article caches, dashboard output, and local runtime state

Basic setup on another computer:

```sh
git clone <your-repo-url>
cd premarket-ai
npm install
cp .env.example .env
```

Then fill in `.env` with the needed values:

- `OPENAI_API_KEY` if you want automatic final briefing generation
- `SCHWAB_APP_KEY`
- `SCHWAB_APP_SECRET`
- `SCHWAB_CALLBACK_URL`
- `SCHWAB_HOLDINGS_ACCOUNT` after you know which account to use

For Gmail import on the new machine:

1. Create or download a fresh Google OAuth desktop-app credential file.
2. Save it as `credentials.json` in the repo root.
3. Run:

```sh
npm run gmail:import
```

For Schwab on the new machine:

```sh
npm run schwab:connect
```

Then complete the browser flow and run:

```sh
npm run schwab:sync -- --date YYYY-MM-DD
```
