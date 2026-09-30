/**
 * Host-side data for the sidebar balance chip.
 *
 * This module is plain Node — no Cordis vocabulary — so it can be unit-tested
 * from the command line and reused unchanged by the plugin entry:
 *
 *   node balance.js            # print the JSON the chip renders
 *   node balance.js --table    # the same report, human readable
 *
 * Two independent facts, both taken from the host so the browser never guesses:
 *
 *   - balance : GET https://api.deepseek.com/user/balance (live, needs the key)
 *   - tariff  : DeepSeek's peak window, computed from the UTC clock
 *
 * The API key is read here and never leaves the host: the route that serves the
 * report answers loopback requests only.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the official peak/off-peak schedule is documented. */
export const TARIFF_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
/** The day the schedule below was last checked against that page. */
export const TARIFF_RETRIEVED = '2026-09-29';

/**
 * Peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday. Outside them
 * tokens cost half as much. Chinese public holidays are entirely off-peak; that
 * calendar is not shipped, so a holiday reads as an ordinary weekday here.
 * @param now - the instant to classify; defaults to the current time.
 */
export function isPeak(now = new Date()) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** The harness home directory, i.e. where sessions and credentials live. */
export function harnessHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

/**
 * Read the DeepSeek API key from the environment, or from the managed
 * credential file `$DSH_HOME/.credentials.yaml`.
 * @param home - harness home override, mainly for tests.
 * @returns `{ key, source }`, or `null` when no key is configured.
 */
export function readApiKey(home = harnessHome()) {
  if (process.env.DEEPSEEK_API_KEY) return { key: process.env.DEEPSEEK_API_KEY, source: 'environment' };
  const file = path.join(home, '.credentials.yaml');
  if (!fs.existsSync(file)) return null;
  const match = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(fs.readFileSync(file, 'utf8'));
  if (!match) return null;
  return { key: match[1].replace(/^["']|["']$/g, ''), source: file };
}

/**
 * Ask the DeepSeek API for the account balance.
 * @param key - API key.
 * @param baseUrl - API base; overridable for tests.
 */
export async function fetchBalance(key, baseUrl = 'https://api.deepseek.com') {
  const response = await fetch(baseUrl + '/user/balance', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('balance endpoint answered HTTP ' + response.status);
  const body = await response.json();
  const info = (body.balance_infos ?? [])[0] ?? {};
  return {
    available: body.is_available === true,
    currency: info.currency ?? 'USD',
    total: Number(info.total_balance ?? 0),
    granted: Number(info.granted_balance ?? 0),
    toppedUp: Number(info.topped_up_balance ?? 0),
  };
}

const round = (value, digits = 2) => Number(value.toFixed(digits));
const money = (value) => '$' + Number(value).toFixed(2);

/**
 * Shape one report for the chip. Pure: same inputs, same output.
 * @param options - `{ balance, now }`; `balance` may be null when the key is
 *   missing or the endpoint failed, and the tariff is still reported.
 */
export function buildReport({ balance = null, now = new Date() } = {}) {
  const peak = isPeak(now);
  return {
    balance: balance
      ? {
        ...balance,
        grantedPercent: balance.total > 0 ? round((balance.granted / balance.total) * 100, 2) : 0,
        toppedUpPercent: balance.total > 0 ? round((balance.toppedUp / balance.total) * 100, 2) : 0,
      }
      : null,
    tariff: {
      peak,
      window: peak ? 'peak' : 'off-peak',
      source: TARIFF_SOURCE,
      retrieved: TARIFF_RETRIEVED,
    },
    generatedAt: now.toISOString(),
  };
}

/**
 * The full host-side call: balance plus tariff, with a graceful failure. A
 * missing key or a failed request is reported in `error` while the tariff is
 * still returned, so the chip can show a truthful state instead of nothing.
 * @param options - `{ home, baseUrl, now }`.
 */
export async function collectReport(options = {}) {
  const home = options.home ?? harnessHome();
  const now = options.now ?? new Date();
  let balance = null;
  let error = null;
  try {
    const credential = readApiKey(home);
    if (!credential) {
      throw new Error('API key not found: set DEEPSEEK_API_KEY or add it to ' + path.join(home, '.credentials.yaml'));
    }
    balance = await fetchBalance(credential.key, options.baseUrl);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return { ...buildReport({ balance, now }), error };
}

/** A `node:http` handler that writes one report as JSON, uncached. */
export function jsonHandler(report) {
  return (_req, res) => {
    const body = JSON.stringify(report);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  };
}

/* --------------------------------------------------------------- CLI entry */

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const report = await collectReport();
  if (!process.argv.includes('--table')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(report.tariff.peak
      ? 'tariff: PEAK — tokens cost 2x the off-peak price'
      : 'tariff: off-peak — normal price');
    if (report.balance) {
      console.log('balance: ' + money(report.balance.total) + ' ' + report.balance.currency
        + ' (granted ' + money(report.balance.granted) + ' = ' + report.balance.grantedPercent + '%,'
        + ' topped up ' + money(report.balance.toppedUp) + ' = ' + report.balance.toppedUpPercent + '%)');
    }
    if (report.error) console.log('error: ' + report.error);
    console.log('prices: ' + report.tariff.source + ' (checked ' + report.tariff.retrieved + ')');
  }
}
