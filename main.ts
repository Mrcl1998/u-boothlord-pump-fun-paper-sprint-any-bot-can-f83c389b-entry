// Pump.fun paper-trading bot for the agent-fun/replay/v2 harness.
//
// Idea: most pump.fun coins die, a few run 2-14x. Buy a coin only after it shows
// real buy pressure (several distinct buyers, net SOL inflow, price rising and
// holding near its window high, real SOL already >= 10 so the curve is not brand
// new), then pyramid into strength and exit fast: -15% stop, +30% take-profit,
// 15% trailing stop once up 10%, or 1500 slots max hold. One entry per coin ever:
// re-entering a coin after an exit lost money in every backtest. No fade or
// big-sell exits: they sold winners too early on the dev window.
//
// The harness speaks agent-fun/replay/v2: it sends a hello line, then one batch
// per slot with the slot's events, and the bot answers each batch with its
// orders. Everything here is deterministic: no clock, no randomness, iteration
// only over insertion-ordered maps fed by the batch stream, so the two grading
// runs produce byte-identical action logs.
//
// Tuned on the kit's full dev window (24h, 1222 coins, 128,058 events) with a
// full-window sim port over 4 failed-tx draws: net +1.352 SOL mean (+1.148
// worst), 623 fills, 147 coins, 147 round trips, 41 wins, max drawdown 0.159.
// grade-local --driver process on the dev window: net +0.696 SOL, 626 fills,
// 147 coins, 147 round trips, win rate 27.2%, max drawdown 0.190, guardrails
// met; two runs byte-identical (result_sha256 6ae94c65...). Note: the kit's own
// sim port only loads the first dataset part, so the builder's original
// +2.591 SOL figure was tuned on ~40% of the window and does not reproduce.
// Stress: 19 of 20 rebuilt window blocks lost money (median -3.82 SOL) — the
// dev-window score is window-dependent. See SPEC.md in the scratch dir.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

// --- tuned constants (see SPEC.md) -----------------------------------------
const WINDOW = 30; // entry lookback, slots
const MIN_NET_SOL = 1; // min net buy SOL (buys minus sells) over WINDOW
const MIN_BUYS = 3; // min buy trades over WINDOW
const MIN_BUYERS = 5; // min distinct buying wallets over WINDOW
const MIN_PRICE_UP = 0.05; // min price rise over WINDOW
const MAX_PRICE_UP = 1.5; // max price rise over WINDOW (skip vertical spikes)
const NEAR_HIGH = 0.9; // price now >= this share of the window high
const MIN_RQ_SOL = 10; // min real SOL in the curve at entry
const MAX_RQ_SOL = 60; // max real SOL in the curve at entry
const MIN_AGE = 100; // min slots since CreateEvent before an entry
const STAKE_SOL = 1; // target SOL per position (1%-of-reserve cap binds first)
const MIN_BUY_SOL = 0.01; // smallest buy worth sending (also the guardrail size)
const BUY_SLIP_BPS = 500; // slippage on buys; sells always go out wide open
const STOP_LOSS = 0.15; // exit when value < cost * (1 - STOP_LOSS)
const TRAIL = 0.15; // exit when value < peak * (1 - TRAIL), once armed
const TRAIL_ARM = 0.1; // trailing stop arms once peak >= cost * (1 + TRAIL_ARM)
const TAKE_PROFIT = 0.3; // hard exit when value >= cost * (1 + TAKE_PROFIT)
const MAX_HOLD = 1500; // exit after this many slots held (unless far up)
const HOLD_IF_UP = 1000; // max-hold does not apply while up at least this much
const ADD_SOL = 0.4; // each pyramid add-on buy, SOL
const MAX_EXPOSURE_SOL = 6; // most SOL at cost across all positions at once

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps fallback

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number; // SOL per token from virtual reserves
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
}

interface Held {
  opened: number;
  peak: number; // best close value seen, SOL
  invested: number; // SOL sent in buys for this position
  exiting: boolean;
  filled: boolean; // some buy of this position filled
  lastAddPrice: number; // recorded price when the last buy was decided
  lastValue: number; // close value at the latest batch, SOL
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();

function tapeOf(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0 };
    tapes.set(mint, t);
  }
  return t;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Drop tape older than the entry window (+5 slots of slack).
    const keep = WINDOW + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<string, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: sell the whole position on the first trigger.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          // A buy that never filled does not consume the coin's one entry:
          // the sweep this config was tuned on re-tries such coins.
          if (!h.filled) tapeOf(mint).entries--;
          held.delete(mint);
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peak) h.peak = value;
      h.lastValue = value;
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peak >= cost * (1 + TRAIL_ARM) && value < h.peak * (1 - TRAIL)) exit = true;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      if (pendingByMint.has(mint)) {
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
      }
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Entries and pyramid adds.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= 1) continue; // one entry per coin, ever
        if (!entrySignal(t, now, rqSol)) continue;
        want = STAKE_SOL;
      } else {
        // Pyramid into strength only: price at or above the last add and net
        // SOL still flows in over the entry window. (No "position must be up"
        // gate: the sweep this config was tuned on adds whenever the price
        // holds, even if fees leave the position a touch under cost.)
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice) continue;
        if (flow(t, now, WINDOW) < 0) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peak: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }
    return orders;
  },
});
