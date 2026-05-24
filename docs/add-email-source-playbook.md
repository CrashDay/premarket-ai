# Add Email Source Playbook

Use this workflow whenever you want to add a new newsletter, alert feed, or market email source into the dashboard pipeline.

## Goal

A new source is fully wired in when it:

- lands in the right Gmail sub-label automatically
- imports into `inbox/YYYY-MM-DD/`
- is recognized by the source classifier
- gets an appropriate role and weight in the daily ranking
- improves the dashboard instead of adding noise

## 1. Pick The Source

Before changing anything, collect:

- sender email address
- sender display name
- one or two real subject lines
- whether the source is useful for:
  - pre-market setup
  - breaking news
  - swing ideas
  - theme discovery
  - watchlist maintenance

## 2. Create A Gmail Sub-Label

All source labels should live under `Market Brief`.

Examples:

- `Market Brief/CNBC/Fast Money`
- `Market Brief/Fool/Stock Advisor`
- `Market Brief/Bespoke/Daily`

Keep names short and stable. Use title case. Match the structure you want the Gmail API to return.

## 3. Add A Gmail Filter

Create a Gmail filter using the search box filter UI.

Usually:

- `From`: sender email
- optionally `Subject`: a stable phrase

Then choose:

- `Apply the label`
- select the new sub-label
- check `Also apply filter to matching conversations`

Leave `To` blank unless you explicitly need recipient-based filtering.

## 4. Add The Label To Import Config

Edit:

- [config/gmail-labels.json](/Users/tonyday/premarket-ai/config/gmail-labels.json)

Add the exact Gmail label path to the `labels` list.

Example:

```json
"Market Brief/CNBC/Fast Money"
```

If the Gmail API path and the config string do not match exactly, the importer will report a missing label.

## 5. Teach The Source Classifier

Edit:

- [scripts/generate-report.js](/Users/tonyday/premarket-ai/scripts/generate-report.js)

Add or update a `SOURCE_PROFILES` entry with:

- `name`
- `patterns`
- `weight`
- `role`

Example shape:

```js
{
  name: "CNBC Fast Money",
  patterns: [/fast money/i],
  weight: 10,
  role: "trader sentiment and catalyst context",
}
```

## 6. Choose A Weight Conservatively

Use small differences at first. You can always tune later.

Suggested starting ranges:

- `16-18`: highest-conviction swing idea sources
- `12-14`: strong pre-market setup sources
- `8-10`: useful catalyst/news context
- `5-7`: broad market color or theme discovery

Good questions:

- Does this source actually improve trade selection?
- Does it mostly repeat what other sources already say?
- Is it timely enough for a morning build?

## 7. Run A Verification Pass

Use a fresh date or today’s date:

```sh
npm run gmail:import -- --date YYYY-MM-DD
npm run brief -- --date YYYY-MM-DD
npm run candles -- --date YYYY-MM-DD --delay-ms 13000
npm run dashboard
```

`gmail:import -- --date YYYY-MM-DD` filters to messages whose local delivery date matches that day. It no longer force-writes every matching message into that folder regardless of the message timestamp.

Then verify:

- no missing-label warnings
- imported emails landed in the expected inbox folder
- source profile shows up correctly in daily JSON
- candidate ranking still looks sane
- dashboard tabs are improved by the new source

## 8. Watch For Noise

A source needs adjustment if:

- it floods the inbox with low-action items
- its subject lines are too generic to classify cleanly
- it over-inflates weak names in the candidate list
- it mostly duplicates another source

When that happens:

- lower the source weight
- tighten the Gmail filter
- tighten the `patterns`
- move it to a lighter role like theme discovery

## 9. ThinkOrSwim Note

ThinkOrSwim-based watchlists should be integrated separately from email labels.

Do not force brokerage watchlist data into the Gmail-source model. Treat it as a future parallel input that can enrich:

- candidate universes
- held positions
- watchlist overlays
- relative-priority scoring

## Checklist

- create Gmail sub-label
- create Gmail filter
- add label to `config/gmail-labels.json`
- add source profile in `scripts/generate-report.js`
- run import/build verification
- tune weight only after reviewing output
