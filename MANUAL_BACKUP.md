# Manual Backup Mode

Use this Mac as a manual backup workstation only.

Do not create automations or scheduled tasks on this machine. The automated desktop remains the primary runner. This Mac is for manual checks, manual rebuilds, and backup execution when needed.

## Folder Layout

Recommended sibling layout on this Mac:

```text
parent-folder/
  Market Dashboard/
  premarket-ai/
```

That keeps the default `premarket-ai` path working for the `paper-trade` commands in the Trader repo.

## Premarket Setup

From `/Users/tonyday/premarket-ai`:

```bash
npm install
cp .env.example .env
```

Then fill in `.env` with the values you want available on this Mac. Add `credentials.json` only if you want Gmail import available here too.

## Trader Setup

From `/Users/tonyday/Market Dashboard`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp config/schwab.env.example config/schwab.env
```

Then fill in `config/schwab.env` with:

- `SCHWAB_APP_KEY`
- `SCHWAB_APP_SECRET`
- `SCHWAB_REFRESH_TOKEN`
- `SCHWAB_REDIRECT_URI`
- `SCHWAB_ACCOUNT_HASH`

## Manual Commands

### Build the premarket dashboard manually

```bash
cd "/Users/tonyday/premarket-ai"
npm run build
```

### Build the premarket dashboard without Gmail import

```bash
cd "/Users/tonyday/premarket-ai"
npm run build:core
```

### Refresh the Trader watchlist and morning queue

```bash
cd "/Users/tonyday/Market Dashboard"
source .venv/bin/activate
paper-trade morning-run --refresh-market-snapshot
```

### Pull a fresh Schwab market snapshot only

```bash
cd "/Users/tonyday/Market Dashboard"
source .venv/bin/activate
paper-trade schwab-snapshot
```

### Validate the MES futures strategy configs

```bash
cd "/Users/tonyday/Market Dashboard"
source .venv/bin/activate
paper-trade validate-futures-strategies
```

### Prepare the MES morning session manually

```bash
cd "/Users/tonyday/Market Dashboard"
source .venv/bin/activate
paper-trade prepare-open-session
```

### Run the MES morning agent manually

```bash
cd "/Users/tonyday/Market Dashboard"
source .venv/bin/activate
paper-trade run-morning-agent
```

## Backup Day Flow

If the automated desktop is unavailable, use this order:

1. Build the briefing pipeline in `premarket-ai`
2. Refresh the market snapshot in `Trader`
3. Run `paper-trade morning-run --refresh-market-snapshot`
4. Run `paper-trade prepare-open-session`
5. Run `paper-trade run-morning-agent` as needed during the session

## Safety Notes

- Do not sync `.env`, `config/schwab.env`, `credentials.json`, or token files into Git.
- Keep this Mac manual-only so it never competes with the automated desktop.
- If you later decide to automate this Mac too, do it deliberately on a separate schedule so both machines do not operate at once.
