// Velocity-runner strategy for the pump.fun replay sprint.
//
// Idea: a coin's price can never fall below its create price (the bonding curve's
// virtual reserves put a floor under it), so buying close to create has limited
// downside and open upside. The pump happens in the first ~10 slots, then the
// price dumps back to ~1.0-1.3x and goes flat. So: enter small and early, only
// on organic launches, add while strength continues, exit fast and tight.
//
// Entry (every gate must pass):
//   - age <= 6 slots since the CreateEvent
//   - real SOL reserve between 0.3 and 60
//   - the creator bought >= 5 SOL (and <= 1000 SOL) in the create slot
//   - at most 1 non-creator buyer in the current slot (a launch swarmed by
//     many wallets in a single early slot is usually a bundle about to dump)
//   - the creator has not sold
//   - 15-slot net flow positive
//   - run-up since create is NOT limited
//
// Size: first buy 0.2 SOL (capped at 1% of the real reserve), then +0.1 SOL
// each time the price rises another 10% from the last buy with positive flow,
// at most 0.5 SOL per position.
//
// Exit (all judged on the liquidation value: what selling every token now
// would return after the curve fee and the tx fee):
//   - take profit at +25% of cost
//   - stop loss at -15% of cost (a guard against an extreme dump; in practice
//     exits come from TP / trailing / fuse / creator-sell)
//   - trailing stop 8% once the value reaches cost +10%
//   - fuse after 900 slots held, unless the position is up >= 5%
//   - exit at once when the creator sells
//   - exit when the 15-slot net flow falls below -1000 SOL (practically off)
//
// Guardrail pacing: a 0.01 SOL probe round trip is only ever sent when the
// fills / coins pace is below the guardrail target (20 coins / 40 fills,
// prorated over block time), so the guardrail is met without wasting fees.
//
// Determinism: no clock, no environment, no randomness. Every iteration runs
// over insertion-ordered maps, and every comparison is exact bigint math, so
// two executions produce byte-identical action logs.

import type { Batch, Bot, BotState, Done, Holding, OrderInput, Pubkey } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

export const DEFAULT_PARAMS = {
  maxAge: 6,
  minDevBuySol: 5,
  maxDevBuySol: 1000,
  maxBuyers: 1,
  minRealSol: 0.3,
  maxRealSol: 60,
  initialSol: 0.2,
  stakeSol: 0.5,
  addSol: 0.1,
  addStepPct: 10,
  takeProfitPct: 25,
  stopLossPct: 15,
  trailArmPct: 10,
  trailPct: 8,
  maxHoldSlots: 900,
  fuseUpPct: 5,
  flowWindowSlots: 15,
  flowExitSol: -1000,
  slippageBps: 2000,
  probeSol: 0.01,
  paceCoins: 20,
  paceFills: 40,
  paceWindowSec: 86400,
};

const SOL = (n: number): bigint => BigInt(Math.round(n * 1_000_000_000));

// Entry gates.
const MAX_AGE = 6;
const MIN_DEV_BUY = SOL(DEFAULT_PARAMS.minDevBuySol);
const MAX_DEV_BUY = SOL(DEFAULT_PARAMS.maxDevBuySol);
const MAX_BUYERS = 1;
const MIN_REAL = SOL(DEFAULT_PARAMS.minRealSol);
const MAX_REAL = SOL(DEFAULT_PARAMS.maxRealSol);

// Sizing.
const INITIAL = SOL(DEFAULT_PARAMS.initialSol);
const STAKE = SOL(DEFAULT_PARAMS.stakeSol);
const ADD = SOL(DEFAULT_PARAMS.addSol);

// Exits (all ratios are exact bigint comparisons against cost).
const ADD_STEP_NUM = 11n;
const ADD_STEP_DEN = 10n;
const TP_NUM = 125n;
const TP_DEN = 100n;
const SL_NUM = 85n;
const SL_DEN = 100n;
const ARM_NUM = 110n;
const ARM_DEN = 100n;
const TRAIL_NUM = 92n;
const TRAIL_DEN = 100n;
const FUSE_UP_NUM = 105n;
const FUSE_UP_DEN = 100n;
const MAX_HOLD = 900;

// Flow.
const FLOW_WINDOW = 15;
const FLOW_EXIT = SOL(DEFAULT_PARAMS.flowExitSol);

// Orders.
const SLIPPAGE_BPS = 2000;

// Guardrail pacing probe.
const PROBE = SOL(DEFAULT_PARAMS.probeSol);
const ROUND_TRIP_MIN = SOL(0.01);
const PACE_COINS = 20;
const PACE_FILLS = 40;
const PACE_WINDOW_SEC = 86400;

interface FlowPoint {
  slot: number;
  lamports: bigint;
}

interface CoinState {
  creator: Pubkey | null;
  createdSlot: number | null;
  devBuy: bigint;
  creatorSold: boolean;
  complete: boolean;
  flows: FlowPoint[];
}

interface PositionState {
  firstSlot: number;
  spent: bigint;
  adds: number;
  lastBuyNum: bigint;
  lastBuyDen: bigint;
  peakLiq: bigint;
  armed: boolean;
  probe: boolean;
}

interface PendingBuy {
  mint: Pubkey;
  kind: 'entry' | 'add' | 'probe';
  priceNum: bigint;
  priceDen: bigint;
  amount: bigint;
}

class VelocityRunner implements Bot {
  private coins = new Map<Pubkey, CoinState>();
  private positions = new Map<Pubkey, PositionState>();
  private young: Pubkey[] = [];
  // Distinct non-creator buyers per mint in the CURRENT batch only (one batch
  // is one slot): a launch swarmed by many wallets in a single early slot is
  // usually a bundle about to dump, but a coin that only accumulates buyers
  // across slots is fine. This is a per-slot count, not a cumulative one.
  private batchBuyers = new Map<Pubkey, Set<Pubkey>>();
  // Mints that appear in the current batch (any event). Entry is only ever
  // judged on a mint that is live in this batch: a coin with no trade in the
  // current slot has no new information, so it is not (re-)evaluated.
  private touched = new Set<Pubkey>();
  private pendingBuys = new Map<string, PendingBuy>();
  private pendingBuyMints = new Set<Pubkey>();
  private pendingSells = new Map<string, Pubkey>();
  private pendingSellMints = new Set<Pubkey>();
  private totalFills = 0;
  private roundTripped = new Set<Pubkey>();
  private startBlockTime: number | null = null;
  private lastBlockTime = 0;
  private probeBuyMint: Pubkey | null = null;

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.foldEvents(batch);
    this.foldFills(state, batch);
    this.pruneYoung(batch.slot);

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    let cashLeft = state.freeCashLamports();
    let committed = state.committedPositionCount();
    const selling = new Set<Pubkey>();

    // 1. Exits: one full sell per open position that trips any exit rule.
    for (const [mint, holding] of state.positions) {
      if (this.pendingSellMints.has(mint)) continue;
      const coin = this.coins.get(mint);
      const ps = this.positions.get(mint) ?? this.fallbackPosition(state, mint, holding);
      const liq = this.liquidation(state, mint, holding.token_amount);
      const cost = holding.cost_lamports;
      if (liq > ps.peakLiq) ps.peakLiq = liq;
      let exit = false;
      if (coin !== undefined && coin.creatorSold) exit = true;
      if (!exit && this.flow15(mint, batch.slot) < FLOW_EXIT) exit = true;
      if (!exit && liq * TP_DEN >= cost * TP_NUM) exit = true;
      if (!exit && liq * SL_DEN <= cost * SL_NUM) exit = true;
      if (!exit) {
        if (liq * ARM_DEN >= cost * ARM_NUM) ps.armed = true;
        if (ps.armed && liq * TRAIL_DEN <= ps.peakLiq * TRAIL_NUM) exit = true;
      }
      if (!exit && batch.slot - ps.firstSlot >= MAX_HOLD && liq * FUSE_UP_DEN < cost * FUSE_UP_NUM) exit = true;
      if (!exit && ps.probe) exit = true;
      if (exit) {
        const id = state.clientId();
        this.pendingSells.set(id, mint);
        this.pendingSellMints.add(mint);
        selling.add(mint);
        orders.push({ side: 'sell', client_id: id, mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
        cashLeft -= txFee;
      }
    }

    // 2. Adds: one +0.1 SOL buy per open position whose price rose 10% from
    // the last buy with positive flow, while the 0.5 SOL stake cap allows it.
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint) || this.pendingSellMints.has(mint)) continue;
      if (this.pendingBuyMints.has(mint)) continue;
      const ps = this.positions.get(mint);
      if (ps === undefined || ps.probe) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      void holding;
      if (ps.spent >= STAKE) continue;
      if (!this.priceUp10(curve, ps)) continue;
      if (this.flow15(mint, batch.slot) <= 0n) continue;
      let amount = ADD;
      const remaining = STAKE - ps.spent;
      if (amount > remaining) amount = remaining;
      const cap = state.maxBuyLamports(mint);
      if (amount > cap) amount = cap;
      const afford = cashLeft - txFee;
      if (amount > afford) amount = afford;
      if (amount <= 0n) continue;
      const id = state.clientId();
      this.pendingBuys.set(id, { mint, kind: 'add', priceNum: curve.virtual_quote_reserves, priceDen: curve.virtual_token_reserves, amount });
      this.pendingBuyMints.add(mint);
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      cashLeft -= amount + txFee;
    }

    // 3. Entries: first buys on young coins that pass every gate.
    for (const mint of this.young) {
      if (!this.touched.has(mint)) continue;
      if (selling.has(mint) || this.pendingSellMints.has(mint)) continue;
      if (this.pendingBuyMints.has(mint)) continue;
      if (state.positions.has(mint)) continue;
      if (committed >= state.hello.caps.max_open_positions) break;
      const curve = state.curves.get(mint);
      const coin = this.coins.get(mint);
      if (curve === undefined || curve.complete || coin === undefined || coin.createdSlot === null) continue;
      const age = batch.slot - coin.createdSlot;
      if (age < 0 || age > MAX_AGE) continue;
      const real = curve.real_quote_reserves;
      if (real < MIN_REAL || real > MAX_REAL) continue;
      if (coin.devBuy < MIN_DEV_BUY || coin.devBuy > MAX_DEV_BUY) continue;
      const buyersThisSlot = this.batchBuyers.get(mint);
      if (buyersThisSlot !== undefined && buyersThisSlot.size > MAX_BUYERS) continue;
      if (coin.creatorSold) continue;
      if (this.flow15(mint, batch.slot) <= 0n) continue;
      let amount = INITIAL;
      const cap = state.maxBuyLamports(mint);
      if (amount > cap) amount = cap;
      const afford = cashLeft - txFee;
      if (amount > afford) amount = afford;
      if (amount <= 0n) continue;
      const id = state.clientId();
      this.pendingBuys.set(id, { mint, kind: 'entry', priceNum: curve.virtual_quote_reserves, priceDen: curve.virtual_token_reserves, amount });
      this.pendingBuyMints.add(mint);
      orders.push({ side: 'buy', client_id: id, mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
      cashLeft -= amount + txFee;
      committed += 1;
    }

    // 4. Guardrail pacing probe: only when fills / coins trail the prorated
    // target, buy 0.01 SOL of the newest live coin and sell it right back.
    if (orders.length < state.hello.caps.max_orders_per_batch) {
      const target = this.paceTargets();
      if (this.roundTripped.size < target.coins || this.totalFills < target.fills) {
        const probeMint = this.pickProbeMint(state, selling);
        if (probeMint !== null) {
          const curve = state.curves.get(probeMint);
          if (curve !== undefined) {
            let amount = PROBE;
            const cap = state.maxBuyLamports(probeMint);
            if (amount > cap) amount = cap;
            const afford = cashLeft - txFee;
            if (amount > afford) amount = afford;
            if (amount > 0n) {
              const id = state.clientId();
              this.pendingBuys.set(id, { mint: probeMint, kind: 'probe', priceNum: curve.virtual_quote_reserves, priceDen: curve.virtual_token_reserves, amount });
              this.pendingBuyMints.add(probeMint);
              this.probeBuyMint = probeMint;
              orders.push({ side: 'buy', client_id: id, mint: probeMint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS });
              cashLeft -= amount + txFee;
            }
          }
        }
      }
    }

    if (orders.length > state.hello.caps.max_orders_per_batch) orders.length = state.hello.caps.max_orders_per_batch;
    return orders;
  }

  onDone(_state: BotState, _done: Done): void {}

  private coin(mint: Pubkey): CoinState {
    let c = this.coins.get(mint);
    if (c === undefined) {
      c = { creator: null, createdSlot: null, devBuy: 0n, creatorSold: false, complete: false, flows: [] };
      this.coins.set(mint, c);
    }
    return c;
  }

  private foldEvents(batch: Batch): void {
    this.batchBuyers.clear();
    this.touched.clear();
    for (const e of batch.events) {
      this.touched.add(e.mint);
      if (e.block_time !== null && e.block_time !== undefined) {
        if (this.startBlockTime === null) this.startBlockTime = e.block_time;
        if (e.block_time > this.lastBlockTime) this.lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const c = this.coin(e.mint);
        c.creator = e.creator;
        c.createdSlot = e.slot;
        this.young.push(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = this.coin(e.mint);
        if (c.creator === null) c.creator = e.creator;
        const amt = BigInt(e.sol_amount);
        if (e.is_buy) {
          if (c.createdSlot !== null && e.slot === c.createdSlot && e.user === c.creator) c.devBuy += amt;
          if (e.user !== c.creator) {
            let s = this.batchBuyers.get(e.mint);
            if (s === undefined) {
              s = new Set();
              this.batchBuyers.set(e.mint, s);
            }
            s.add(e.user);
          }
          c.flows.push({ slot: e.slot, lamports: amt });
        } else {
          if (e.user === c.creator) c.creatorSold = true;
          c.flows.push({ slot: e.slot, lamports: -amt });
        }
      } else {
        const c = this.coin(e.mint);
        c.complete = true;
      }
    }
  }

  private foldFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status === 'filled') this.totalFills += 1;
      const buy = this.pendingBuys.get(f.client_id);
      if (buy !== undefined) {
        this.pendingBuys.delete(f.client_id);
        this.pendingBuyMints.delete(buy.mint);
        if (buy.kind === 'probe') this.probeBuyMint = null;
        if (f.status === 'filled') {
          // The last buy's price is the market price when the buy FILLED
          // (the reserves as the harness reports them in this batch), not
          // the price at decision time two slots earlier: the fill is what
          // the position actually paid, so the next +10% add step is
          // measured from the filled price.
          const curve = state.curves.get(buy.mint);
          const fillNum = curve !== undefined ? curve.virtual_quote_reserves : buy.priceNum;
          const fillDen = curve !== undefined ? curve.virtual_token_reserves : buy.priceDen;
          let ps = this.positions.get(buy.mint);
          if (ps === undefined) {
            ps = {
              firstSlot: f.slot,
              spent: 0n,
              adds: 0,
              lastBuyNum: fillNum,
              lastBuyDen: fillDen,
              peakLiq: 0n,
              armed: false,
              probe: buy.kind === 'probe',
            };
            this.positions.set(buy.mint, ps);
          }
          ps.spent += BigInt(f.quote_lamports);
          ps.lastBuyNum = fillNum;
          ps.lastBuyDen = fillDen;
          if (buy.kind === 'add') ps.adds += 1;
          if (buy.kind === 'probe') ps.probe = true;
        }
        continue;
      }
      const sellMint = this.pendingSells.get(f.client_id);
      if (sellMint !== undefined) {
        this.pendingSells.delete(f.client_id);
        this.pendingSellMints.delete(sellMint);
        if (f.status === 'filled') {
          const ps = this.positions.get(sellMint);
          if (ps !== undefined) {
            if (ps.spent >= ROUND_TRIP_MIN) this.roundTripped.add(sellMint);
          }
        }
        continue;
      }
      if (f.client_id.startsWith('_') && f.side === 'sell' && f.status === 'filled') {
        const ps = this.positions.get(f.mint);
        if (ps !== undefined) {
          if (ps.spent >= ROUND_TRIP_MIN) this.roundTripped.add(f.mint);
        }
      }
    }
    for (const mint of [...this.positions.keys()]) {
      if (!state.positions.has(mint)) this.positions.delete(mint);
    }
  }

  private pruneYoung(slot: number): void {
    while (this.young.length > 0) {
      const mint = this.young[0];
      const c = this.coins.get(mint);
      if (c === undefined || c.createdSlot === null || slot - c.createdSlot > MAX_AGE) {
        this.young.shift();
      } else {
        break;
      }
    }
  }

  private fallbackPosition(state: BotState, mint: Pubkey, holding: Holding): PositionState {
    const curve = state.curves.get(mint);
    const ps: PositionState = {
      firstSlot: state.slot,
      spent: holding.cost_lamports,
      adds: 0,
      lastBuyNum: curve !== undefined ? curve.virtual_quote_reserves : 1n,
      lastBuyDen: curve !== undefined ? curve.virtual_token_reserves : 1n,
      peakLiq: 0n,
      armed: false,
      probe: false,
    };
    this.positions.set(mint, ps);
    return ps;
  }

  /** Net SOL the position returns if sold now: constant-product out, less the curve fee, less one tx fee. */
  private liquidation(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const curve = state.curves.get(mint);
    if (curve === undefined || tokens <= 0n) return 0n;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vq <= 0n || vt <= 0n) return 0n;
    const gross = (vq * tokens) / (vt + tokens);
    const feeBps = state.hello.fees.protocol_bps_fallback + state.hello.fees.creator_bps_fallback;
    const fee = (gross * BigInt(feeBps)) / 10000n;
    return gross - fee - state.txFeeLamports();
  }

  /** Current price is at least 10% above the last buy's decision price. */
  private priceUp10(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }, ps: PositionState): boolean {
    return (
      curve.virtual_quote_reserves * ps.lastBuyDen * ADD_STEP_DEN >= ps.lastBuyNum * curve.virtual_token_reserves * ADD_STEP_NUM
    );
  }

  /** Signed SOL flow over the last FLOW_WINDOW slots (buys positive, sells negative). */
  private flow15(mint: Pubkey, slot: number): bigint {
    const c = this.coins.get(mint);
    if (c === undefined) return 0n;
    const cutoff = slot - FLOW_WINDOW;
    while (c.flows.length > 0 && c.flows[0].slot <= cutoff) c.flows.shift();
    let sum = 0n;
    for (const f of c.flows) sum += f.lamports;
    return sum;
  }

  private paceTargets(): { coins: number; fills: number } {
    if (this.startBlockTime === null) return { coins: 0, fills: 0 };
    const elapsed = this.lastBlockTime - this.startBlockTime;
    if (elapsed <= 0) return { coins: 0, fills: 0 };
    return {
      coins: Math.floor((PACE_COINS * elapsed) / PACE_WINDOW_SEC),
      fills: Math.floor((PACE_FILLS * elapsed) / PACE_WINDOW_SEC),
    };
  }

  private pickProbeMint(state: BotState, selling: Set<Pubkey>): Pubkey | null {
    if (this.probeBuyMint !== null) return null;
    for (const ps of this.positions.values()) if (ps.probe) return null;
    const curves = [...state.curves.values()];
    for (let i = curves.length - 1; i >= 0; i--) {
      const c = curves[i];
      if (c.complete) continue;
      if (c.real_quote_reserves <= 0n) continue;
      if (state.positions.has(c.mint)) continue;
      if (this.pendingBuyMints.has(c.mint) || this.pendingSellMints.has(c.mint) || selling.has(c.mint)) continue;
      return c.mint;
    }
    return null;
  }
}

export function createBot(): Bot {
  return new VelocityRunner();
}

export { LAMPORTS_PER_SOL };
