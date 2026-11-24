// Crossing-runner strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Research behind it (dev window, full 24h, local engine port — the shipped sims only
// read the first ~11h, so all numbers below are from a harness that loads all 3 parts):
// - The shipped momentum pilot loses ~-9.4 SOL: it pyramids into pumps that then collapse.
//   Chasing a pump on pump.fun is a trap; the tape after a run-up is mostly sellers.
// - The shipped sniper pilot is near breakeven (~-0.5 SOL) but caps every win at +15% and
//   exits after 10 slots, so it never sees the right tail.
// - Offline tape analysis: once a curve's real SOL crosses ~1 SOL, the median price 100
//   slots later is flat but the mean is +43% — the distribution is a lottery ticket: ~8%
//   of coins more than double within 100 slots, ~3% go 5x+, while the median coin goes
//   nowhere. A coin that never trades again simply stays at its entry price.
// - What actually flipped the local backtest positive was selectivity, not holding longer:
//   letting winners run (trail 25%, TP 100%, hold 1500) lost MORE (-0.69), and bigger
//   entries lost more too (-1.03). The winning shape is a quick flip on a strict entry:
//   TP +10%, stop -8%, out after 100 slots, buys guarded by 10% slippage so a fill that
//   jumps in the 2-slot latency is refused. The single best filter was the creator's own
//   buy: requiring the dev to have bought at least 0.05 SOL (skin in the game, not a
//   bundle) cut the field to ~30-40 coins and flipped net PnL from -0.49 to +0.02 SOL.
//   Wins are spread over 8+ coins; losses are small and numerous — the runners pay for
//   the fee bleed. Split-half check: -0.026 on first-half coins, +0.048 on second-half
//   coins, so treat the +0.024 full-window figure as a small positive tilt, not a promise.
// So this bot buys the crossing itself (real SOL first reaching the entry band), only when
// the early tape looks organic, sizes in over several batches as the curve's own cap
// allows, and flips fast. Fees are ~1.25% of size per curve leg plus 105k lamports per
// order, so every buy is sized so the tx fee stays a small share of it.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream. Two graded executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL (lamports) a curve must reach before an entry is considered. */
  entryRqLamports: bigint;
  /** ...and must not already be above at decision time. */
  maxEntryRqLamports: bigint;
  /** Distinct non-creator buyers seen since creation before entry. */
  minBuyers: number;
  /** Trades seen since creation before entry. */
  minTrades: number;
  /** Creator's own buys since creation, at most (a dev who bought huge is a bundle). */
  maxDevBuyLamports: bigint;
  /** Creator's own buys since creation, at least (skin in the game; 0 = off). */
  minDevBuyLamports: bigint;
  /** Price now over the price flowWindow slots ago, at least (rising now; 0 = off). */
  minMomentum: number;
  /** Slots since creation after which an entry is no longer allowed (0 = off). */
  maxAge: number;
  /** Skip the coin when the creator sold before entry. */
  skipDevSold: boolean;
  /** Price now over the create price, at most (do not buy the top of a spike). */
  maxRunup: number;
  /** Net SOL bought minus sold over the last flowWindow slots, at least. */
  flowWindow: number;
  minFlowLamports: bigint;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** First buy (SOL); later buys are the same size while the signal holds. */
  firstBuySol: number;
  /** Add only while the price is at least this far above the last buy's price. */
  addStep: number;
  /** Add only while net SOL over flowWindow is still positive. */
  addNeedsFlow: boolean;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells go out wide open. */
  buySlipBps: number;
  /** Sell everything once liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell half once up this much, let the rest ride the trail. */
  partialTp: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm); exit on a fall of trail. */
  trailArm: number;
  trail: number;
  /** Hard stop against cost. */
  stopLoss: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  entryRqLamports: 1_100_000_000n,
  maxEntryRqLamports: 8_000_000_000n,
  minBuyers: 11,
  minTrades: 12,
  maxDevBuyLamports: 2_500_000_000n,
  minDevBuyLamports: 50_000_000n,
  minMomentum: 0.1,
  maxAge: 0,
  skipDevSold: true,
  maxRunup: 1.8,
  flowWindow: 20,
  minFlowLamports: 0n,
  stakeSol: 0.1,
  firstBuySol: 0.02,
  addStep: 0.0,
  addNeedsFlow: true,
  minBuySol: 0.01,
  buySlipBps: 1000,
  takeProfit: 0.1,
  partialTp: 1.0,
  trailArm: 10.0,
  trail: 0.12,
  stopLoss: 0.08,
  maxHold: 100,
  exitOnDevSell: true,
  bigSellSol: 1.0,
  staleSlots: 300,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  maxExposureSol: 8,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Coin {
  created: number | null;
  createPrice: number;
  creator: string;
  trades: Trade[];
  buyers: Set<string>;
  devBuy: number;
  devSold: boolean;
  entries: number;
  lastExit: number;
  crossed: boolean;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastBuyPrice: number;
  lastValue: number;
  tookPartial: boolean;
  buys: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const keep = p.flowWindow + 5;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null, createPrice: 0, creator: '', trades: [], buyers: new Set(),
        devBuy: 0, devSold: false, entries: 0, lastExit: -1e12, crossed: false,
        lastTradeSlot: -1,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (c: Coin, now: number, w: number): number => {
    let net = 0;
    for (let i = c.trades.length - 1; i >= 0; i--) {
      const tr = c.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  const priceOf = (state: BotState, mint: Pubkey, marks: Map<Pubkey, { vq: bigint; vt: bigint }>): number => {
    const mk = marks.get(mint);
    if (mk) return Number(mk.vq) / Number(mk.vt);
    const cv = state.curves.get(mint);
    if (cv === undefined) return 0;
    return Number(cv.virtual_quote_reserves) / Number(cv.virtual_token_reserves);
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (e.is_buy) {
            if (e.user === c.creator) c.devBuy += sol;
            else c.buyers.add(e.user);
          } else {
            if (e.user === c.creator) c.devSold = true;
            else if (sol >= p.bigSellSol) bigSell.add(e.mint);
          }
        }
      }
      for (const mint of traded) {
        const c = coins.get(mint)!;
        let cut = 0;
        while (cut < c.trades.length && c.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) c.trades.splice(0, cut);
      }
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: full exits, then one partial take-profit per position.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const c = coinOf(mint);
            if (h.filled) c.lastExit = now;
            else c.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(state, mint, marks);
        const tokens = Number(pos.token_amount);
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.vq) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.vt) : Number(curve.virtual_token_reserves);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const c = coinOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - c.lastTradeSlot > p.staleSlots) exit = true;
        if (exit) {
          h.exiting = true;
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
            if (sellPending) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          continue;
        }
        // One partial take-profit: sell half once up partialTp, then let the rest ride the trail.
        if (!h.tookPartial && value >= cost * (1 + p.partialTp) && !pendingByMint.has(mint)) {
          const half = pos.token_amount / 2n;
          if (half > 0n && half < pos.token_amount && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            h.tookPartial = true;
          }
        }
      }

      // Entries and scale-in adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const c = coins.get(mint)!;
        const rq = Number(curve.real_quote_reserves);
        const price = priceOf(state, mint, marks);
        const h = held.get(mint);
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (c.entries >= p.maxEntries || now - c.lastExit < p.cooldown) continue;
          if (c.created === null) continue;
          // The crossing: real SOL first reaching the entry band on this batch.
          if (rq < Number(p.entryRqLamports) || rq > Number(p.maxEntryRqLamports)) continue;
          if (c.crossed) continue;
          if (c.devSold && p.skipDevSold) { c.crossed = true; continue; }
          if (c.devBuy > Number(p.maxDevBuyLamports) / LAMPORTS) { c.crossed = true; continue; }
          // Dev buy only grows, so a coin below the minimum now may qualify later:
          // do not mark it crossed, just skip this batch.
          if (c.devBuy < Number(p.minDevBuyLamports) / LAMPORTS) continue;
          if (p.maxAge > 0 && c.created !== null && now - c.created > p.maxAge) { c.crossed = true; continue; }
          if (c.buyers.size < p.minBuyers || c.trades.length < p.minTrades) continue;
          if (p.minMomentum > 0) {
            let oldPrice = 0;
            for (let i = c.trades.length - 1; i >= 0; i--) {
              if (c.trades[i]!.slot <= now - p.flowWindow) { oldPrice = c.trades[i]!.price; break; }
            }
            if (oldPrice > 0 && price < oldPrice * (1 + p.minMomentum)) continue;
          }
          if (c.createPrice > 0 && price > c.createPrice * p.maxRunup) { c.crossed = true; continue; }
          if (flow(c, now, p.flowWindow) < Number(p.minFlowLamports) / LAMPORTS) continue;
          c.crossed = true;
          want = p.firstBuySol;
        } else {
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - p.minBuySol) continue;
          if (h.buys >= 5) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastBuyPrice * (1 + p.addStep)) continue;
          if (p.addNeedsFlow && flow(c, now, p.flowWindow) < 0) continue;
          if (rq > Number(p.maxEntryRqLamports) * 4) continue;
          want = Math.min(p.firstBuySol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint)) * 0.97) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastBuyPrice: price, lastValue: 0, tookPartial: false, buys: 1 });
          c.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.lastBuyPrice = price;
          h.buys++;
        }
      }
      return orders;
    },
  };
}
