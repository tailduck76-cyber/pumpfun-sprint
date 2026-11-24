# Pump.fun Replay Sprint — velocity runner

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/tailduck76-cyber/pumpfun-sprint/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/tailduck76-cyber/pumpfun-sprint/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

Built for the [make.fun bounty "Winner Takes All — $5 Pump.fun Replay Sprint"](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3): a TypeScript bot on the `agent-fun/replay/v2` harness that trades 10 SOL of paper money on a 6-hour replay of pump.fun chain data. Best net PnL wins.

## Strategy

A coin's price can never fall below its create price (the bonding curve's
virtual reserves put a floor under it), so buying close to create has limited
downside and open upside. The pump happens in the first ~10 slots, then the
price dumps back to ~1.0–1.3x and goes flat. So: enter small and early, only
on organic launches, add while strength continues, exit fast and tight.

- **Entry** (every gate must pass): age ≤ 6 slots since `CreateEvent`; real
  SOL reserve 0.3–60; the creator bought ≥ 5 SOL (and ≤ 1000 SOL) in the
  create slot; at most 1 non-creator buyer so far; the creator has not sold;
  15-slot net flow positive; run-up since create is not limited.
- **Size**: first buy 0.2 SOL (capped at 1% of the real reserve), then +0.1 SOL
  each time the price rises another 10% from the last buy with positive flow,
  at most 0.5 SOL per position.
- **Exit** (judged on the liquidation value — what selling every token now
  returns after the curve fee and the tx fee): take profit +25% of cost; stop
  loss −15% of cost; trailing stop 8% once the value reaches cost +10%; fuse
  after 900 slots held unless the position is up ≥ 5%; exit at once when the
  creator sells; exit when the 15-slot net flow falls below −1000 SOL.
- **Guardrail pacing**: a 0.01 SOL probe round trip is only ever sent when the
  fills / coins pace trails the guardrail target (20 coins / 40 fills,
  prorated over block time).

Fully deterministic: no clock, no environment, no randomness; every iteration
runs over insertion-ordered maps with exact bigint math, so two executions
produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint (`node /bot/main.ts`).
- `strategy.ts` — the whole strategy (`DEFAULT_PARAMS` + `createBot()`).
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` shim, vendored
  byte-identical (sha256 `4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08`).

## Grade locally

```
cd kit/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3-kit
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun-pumpfun/rebuild3 --driver process
```

## Local grade result

```
net PnL   0.450868797 SOL  (return 0.045086879)
trading   160 fills over 68 coins, 69 round trips, win rate 0.246376811, max drawdown 0.014495958, 8 rejected, 4 failed
fees      0.171580638 SOL curve + 0.017220000 SOL tx
guardrails met (coins ok: 68 hold a round trip of at least 0.010000000 SOL, over 69 such round trips, drawdown ok)
L1 regrade        reproduced byte for byte
```
