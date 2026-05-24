import { connectSchwab, connectSchwabWithLoopback, buildAuthorizationUrl } from "./lib/schwab.js";

const args = parseArgs(process.argv.slice(2));

try {
  const result = args.loopback
    ? await connectSchwabWithLoopback({
        port: Number(args.port || 8182),
        pathName: String(args.path || "/callback"),
      })
    : await connectSchwab({
        redirectedUrl: args.redirectUrl || args.url || process.env.SCHWAB_REDIRECT_URL || "",
        interactive: !args["no-prompt"],
      });

  if (!result.ok) {
    console.log(result.message);
    console.log("");
    console.log("Authorization URL:");
    console.log(result.authorizationUrl || buildAuthorizationUrl());
    process.exit(0);
  }

  console.log("Schwab connection saved.");
  console.log(`Access token expiry: ${result.token.accessTokenExpiresAt}`);
  console.log(`Refresh token present: ${result.token.hasRefreshToken ? "yes" : "no"}`);
} catch (error) {
  console.error(`Schwab connect failed: ${error.message}`);
  process.exit(1);
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
