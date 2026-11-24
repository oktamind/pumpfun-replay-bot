// pumpfun-replay-bot: a crossing-runner bot for the agent-fun pump.fun replay
// (agent-fun/replay/v2). The grader runs `node /bot/main.ts`; the strategy lives in
// strategy.ts and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte
// (only the filename in its header comment differs from the pilot copy).
//
// The bot buys a curve when its real SOL first crosses the entry band with an organic
// early tape, scales in as the curve's own per-batch size cap allows, and lets winners
// run to a wide take-profit / trailing stop while cutting losers fast. See strategy.ts
// for the research behind the numbers.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
