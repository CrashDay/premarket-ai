import { syncSchwabAccount } from "./lib/schwab.js";

const args = parseArgs(process.argv.slice(2));
const date = args.date || new Date().toISOString().slice(0, 10);
const includeQuotes = args["skip-quotes"] ? false : true;
const softFail = Boolean(args["soft-fail"]);

try {
  const summary = await syncSchwabAccount({ date, includeQuotes });

  if (!summary.ok) {
    console.log(`Schwab sync skipped: ${summary.reason}`);
    if (summary.authorizationUrl) {
      console.log(`Connect first: ${summary.authorizationUrl}`);
    }
    process.exit(0);
  }

  console.log(
    `Schwab synced for ${summary.date}: ${summary.totals.accountCount} account(s), ` +
      `${summary.totals.positionCount} position(s), ${Object.keys(summary.positionsBySymbol ?? {}).length} symbols.`,
  );
} catch (error) {
  console.error(`Schwab sync failed: ${error.message}`);
  process.exit(softFail ? 0 : 1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}
