import { verifyCandidate } from "./lib/candidate-verifier.js";

const args = parseArgs(process.argv.slice(2));

if (!args.symbol) {
  console.log("Usage: npm run verify -- --symbol TICKER [--date YYYY-MM-DD]");
  process.exit(1);
}

try {
  const record = await verifyCandidate({ symbol: args.symbol.toUpperCase(), date: args.date ?? todayLocal() });
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--symbol") parsed.symbol = argv[++index];
    else if (arg === "--date") parsed.date = argv[++index];
  }

  return parsed;
}

function todayLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
