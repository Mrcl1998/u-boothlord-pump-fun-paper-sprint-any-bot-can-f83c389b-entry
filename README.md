# Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Mrcl1998/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Mrcl1998/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
competition on make.fun. It runs on Node 22 as `node main.ts` under the
agent-fun/replay/v2 harness and paper-trades pump.fun bonding curves on a
6-hour replay. Highest net PnL wins.

## Strategy

Most pump.fun coins die; a few run 2–14x. The bot buys a coin only after real
buy pressure: several distinct buyers, net SOL inflow, price rising and holding
near its window high, real SOL already ≥ 10. It pyramids into strength and
exits fast: −15% stop, +30% take-profit, 15% trailing stop once up 10%, or
1500 slots max hold. One entry per coin, ever (a buy that never fills does
not consume the entry).

Retuned on the kit's full dev window (24h, 1222 coins, 128,058 events) with a
full-window sim port over 4 failed-tx draws: net **+1.352 SOL** mean (+1.148
worst), 623 fills, 147 coins, 147 round trips, 41 wins, max drawdown 0.159.
grade-local --driver process on the dev window: net **+0.696 SOL**, 626 fills,
147 coins, 147 round trips, win rate 27.2%, max drawdown 0.190, guardrails met,
two runs byte-identical. The kit pilot's default on the same window: −9.38 SOL.
Stress note: 19 of 20 rebuilt window blocks lost money (median −3.82 SOL), so
the dev-window score is window-dependent.

## Files

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte from the
  competition kit (`sdk/ts/makefun-bot.ts`)

## License

MIT — see `LICENSE`.
