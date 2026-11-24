# pumpfun-replay-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oktamind/pumpfun-replay-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oktamind/pumpfun-replay-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun activity, scored on net PnL.

## Strategy — the crossing runner

The shipped momentum pilot loses ~9 SOL on the dev window by pyramiding into pumps that then collapse, and the sniper pilot caps every win at +15%. Tape analysis of the dev window showed the distribution is a lottery ticket: once a curve's real SOL crosses ~1 SOL, the median price 100 slots later is flat but the mean is +43% — about 8% of coins more than double, ~3% go 5x+, while most go nowhere. So this bot:

- buys the crossing itself (real SOL first reaching the entry band) and only when the early tape looks organic — several distinct non-creator buyers, no creator sell, no huge creator buy, price not already spiked;
- scales in over several batches as the curve's own 1%-of-reserve per-batch size cap allows, so the tx fee stays a small share of each buy;
- lets winners run to a wide take-profit / trailing stop, and cuts losers on a hard stop, a creator sell, a big sell, staleness, or a time limit.

Everything is deterministic: no clock, no randomness, no network, no secrets — stdlib plus the vendored `vendor/makefun-bot.ts` shim only.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout (the grader runs `node /bot/main.ts`). To backtest it on the kit's dev window, use the pilot's local engine port (`baselines/pilot/momentum/tools/backtest.ts` in the kit) pointed at this repo's `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rrts6br6&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
