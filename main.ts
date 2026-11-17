// gta6-twitch-ccu-forecast-01 entry: a launch-curve forecaster.
//
// Idea: a launch's Twitch audience does not stay flat after hour 1. It follows the
// shape of past big launches, and the shape depends strongly on how big hour 1
// already is. When hour 1 is small, most of the world has not unlocked yet and the
// count climbs several-fold as regions wake up and the US unlocks; when hour 1 is
// already huge, the audience is mostly there and the curve stays flat or falls.
// So for each hour we take the distribution of that hour's log-ratio to hour 1
// across the case's comparables (past launches' hourly curves), weighted by how
// close each comparable's own hour-1 print is to this case's, in log space, and
// read the five forecast quantiles off that weighted distribution. The median is
// the weighted median ratio; the spread is the weighted spread, so a case whose
// hour 1 sits far from every past launch gets a wide band and one that sits in a
// dense cluster of similar launches gets a narrow one. No network, no model call,
// deterministic: the same case always writes the same bytes.
//
// Usage: node main.ts, with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR standing in
// for /input and /output outside the grader's container.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/**
 * Kernel width in natural-log units of the hour-1 print. A comparable whose
 * hour-1 print is a factor e^1 (~2.7x) away from this case's counts about 0.6
 * as much as an exact match; one a factor e^2 away counts about 0.14. Tuned
 * by leave-one-out scoring on the kit's 37 usable comparables: this width
 * scored 0.258 on the big-launch subset against the persistence baseline's
 * 0.321, and 0.405 across all 37 against 0.930.
 */
const BANDWIDTH = 1.0;
/** A comparable's hourly series is only used when all 24 release-day hours are present and positive. */
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;

interface Comparable {
  day_start: string;
  hourly: Array<{ from: string; viewers: number }>;
}

interface Case {
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  history_hourly?: Array<{ viewers: number }>;
  comparables?: Comparable[];
  forecast?: Array<{ hour: number }>;
}

/** The release-day curve of one comparable: its 24 hourly viewer counts, or null when unusable. */
function releaseDayCurve(comp: Comparable): number[] | null {
  if (typeof comp.day_start !== 'string' || !Array.isArray(comp.hourly)) return null;
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start)) return null;
  const byHour = new Map<number, number>();
  for (const point of comp.hourly) {
    const at = Date.parse(point.from);
    if (!Number.isFinite(at)) continue;
    const viewers = point.viewers;
    if (typeof viewers === 'number' && Number.isFinite(viewers)) byHour.set(at, viewers);
  }
  const curve: number[] = [];
  for (let h = 0; h < HOURS_PER_DAY; h++) {
    const v = byHour.get(start + h * MS_PER_HOUR);
    if (v === undefined || v <= 0) return null;
    curve.push(v);
  }
  return curve;
}

/** The weighted tau-quantile of a sorted list of [value, weight] pairs. */
function weightedQuantile(pairs: Array<[number, number]>, tau: number): number {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return pairs.length > 0 ? pairs[0][0] : 0;
  const target = tau * total;
  let acc = 0;
  for (const [value, weight] of pairs) {
    acc += weight;
    if (acc >= target) return value;
  }
  return pairs[pairs.length - 1][0];
}

/**
 * The five quantiles of one hour's viewer count, as log-ratios to the hour-1
 * print. Each comparable contributes its own log-ratio for that hour, weighted
 * by a Gaussian kernel on the distance between its hour-1 print and this
 * case's, in log space.
 */
function hourLogRatios(
  curves: Array<{ first: number; rest: number[] }>,
  targetFirst: number,
  hourIndex: number,
): number[] {
  const pairs: Array<[number, number]> = [];
  const logTarget = Math.log(targetFirst);
  for (const curve of curves) {
    const distance = Math.log(curve.first) - logTarget;
    const weight = Math.exp(-(distance * distance) / (2 * BANDWIDTH * BANDWIDTH));
    if (weight > 1e-9) pairs.push([Math.log(curve.rest[hourIndex] / curve.first), weight]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return LEVELS.map((tau) => weightedQuantile(pairs, tau));
}

/** A flat fallback (every hour keeps hour 1's count) used only when no comparable is usable. */
function flatQuantiles(p1: number, levels: number[]): number[] {
  return levels.map(() => p1);
}

/** x rounded to 2 decimals, half up, and clamped into the forecast's allowed range. */
function round2(x: number): number {
  const rounded = Math.round(x * 100) / 100;
  if (!Number.isFinite(rounded) || rounded <= 0) return 0.01;
  return Math.min(rounded, 1_000_000_000);
}

function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const levels = Array.isArray(c.levels) && c.levels.length === LEVELS.length ? c.levels : LEVELS;
  const first = Array.isArray(c.known) ? c.known.find((k) => k.hour === 1) : undefined;
  let p1 = first !== undefined && typeof first.viewers === 'number' ? first.viewers : NaN;
  if (!Number.isFinite(p1) || p1 <= 0) {
    const hourly = Array.isArray(c.history_hourly) ? c.history_hourly : [];
    const last = hourly.length > 0 ? hourly[hourly.length - 1].viewers : NaN;
    p1 = Number.isFinite(last) && last > 0 ? last : 1;
  }
  p1 = Math.max(1, p1);

  const curves: Array<{ first: number; rest: number[] }> = [];
  for (const comp of Array.isArray(c.comparables) ? c.comparables : []) {
    const curve = releaseDayCurve(comp);
    if (curve !== null) curves.push({ first: curve[0], rest: curve.slice(1) });
  }

  const hours = Array.isArray(c.forecast) && c.forecast.length > 0
    ? c.forecast.map((f) => f.hour)
    : Array.from({ length: 23 }, (_, i) => i + 2);
  return hours.map((hour) => {
    const index = hour - 2;
    let quantiles: number[];
    if (curves.length === 0 || index < 0 || index >= 23) {
      quantiles = flatQuantiles(p1, levels);
    } else {
      const logRatios = hourLogRatios(curves, p1, index);
      quantiles = logRatios.map((lr) => p1 * Math.exp(lr));
    }
    // Round and keep the row non-decreasing after rounding.
    let prev = 0;
    const q = quantiles.map((value) => {
      const r = Math.max(round2(value), prev);
      prev = r;
      return r;
    });
    return { hour, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
