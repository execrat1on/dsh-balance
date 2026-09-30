/**
 * Self-check for the `dsh-balance` plugin. No test framework, no network:
 *
 *   node test/verify.mjs
 *
 * It covers the four things a plugin like this can get wrong silently:
 *
 *   1. the host clock — the peak window must be the official one, in UTC;
 *   2. the host route — loopback only, cached, refreshable, key never leaked;
 *   3. the browser half — slot registration, the three chip states, the tariff
 *      mark, and reading nothing but `react`;
 *   4. the manifest — every file it points at exists and parses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { isPeak, readApiKey, fetchBalance, buildReport, collectReport } from '../balance.js';
import { apply as applyHost, name as hostName, inject as hostInject } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(read(relative));

const passed = [];
const failed = [];
const expect = (condition, message) => (condition ? passed : failed).push(message);

/* --------------------------------------------------------------- 1. the clock */

/** A Monday, verified below, so weekday assertions cannot drift. */
const MONDAY = Date.UTC(2026, 8, 28);
const at = (dayOffset, hour, minute = 0) => new Date(MONDAY + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000);

expect(new Date(MONDAY).getUTCDay() === 1, 'isPeak fixture: 2026-09-28 is a Monday');

const peakCases = [
  [at(0, 0, 59), false, 'Mon 00:59 UTC is off-peak'],
  [at(0, 1), true, 'Mon 01:00 UTC is peak'],
  [at(0, 3, 59), true, 'Mon 03:59 UTC is peak'],
  [at(0, 4), false, 'Mon 04:00 UTC is off-peak (the 04:00–06:00 gap)'],
  [at(0, 5, 59), false, 'Mon 05:59 UTC is off-peak'],
  [at(0, 6), true, 'Mon 06:00 UTC is peak'],
  [at(0, 9, 59), true, 'Mon 09:59 UTC is peak'],
  [at(0, 10), false, 'Mon 10:00 UTC is off-peak'],
  [at(0, 23), false, 'Mon 23:00 UTC is off-peak'],
  [at(4, 2), true, 'Fri 02:00 UTC is peak'],
  [at(5, 2), false, 'Sat 02:00 UTC is off-peak all day'],
  [at(6, 7), false, 'Sun 07:00 UTC is off-peak all day'],
];
for (const [date, expected, message] of peakCases) expect(isPeak(date) === expected, message);
expect(typeof isPeak() === 'boolean', 'isPeak() defaults to now and returns a boolean');

/* ------------------------------------------------------------------ 2. the key */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-balance-'));
const credentials = path.join(tmp, '.credentials.yaml');
fs.writeFileSync(credentials, 'DEEPSEEK_API_KEY: "sk-from-file"\nOTHER: x\n', 'utf8');

const savedKey = process.env.DEEPSEEK_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
expect(readApiKey(tmp)?.key === 'sk-from-file', 'readApiKey reads the key from .credentials.yaml and strips quotes');
expect(readApiKey(path.join(tmp, 'nope')) === null, 'readApiKey returns null when no key is configured');
process.env.DEEPSEEK_API_KEY = 'sk-from-env';
expect(readApiKey(tmp)?.source === 'environment', 'the environment wins over the credential file');
delete process.env.DEEPSEEK_API_KEY;

/* -------------------------------------------------------------- 3. balance fetch */

const realFetch = globalThis.fetch;
const balancePayload = {
  is_available: true,
  balance_infos: [{ currency: 'USD', total_balance: '3.92', granted_balance: '1.10', topped_up_balance: '2.82' }],
};
let fetchCalls = 0;
let lastFetchUrl = '';
globalThis.fetch = async (url, options) => {
  fetchCalls += 1;
  lastFetchUrl = String(url);
  if (String(url).includes('/user/balance')) {
    return { ok: true, status: 200, json: async () => balancePayload };
  }
  return { ok: false, status: 500, json: async () => ({}) };
};

const balance = await fetchBalance('sk-test');
expect(balance.total === 3.92 && balance.granted === 1.1 && balance.toppedUp === 2.82, 'fetchBalance parses total/granted/topped-up');
expect(balance.currency === 'USD' && balance.available === true, 'fetchBalance keeps the currency and availability flag');
expect(lastFetchUrl === 'https://api.deepseek.com/user/balance', 'fetchBalance calls the documented endpoint');

globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
let thrown = null;
try {
  await fetchBalance('sk-test');
} catch (error) {
  thrown = error;
}
expect(thrown !== null && /429/.test(thrown.message), 'a non-2xx balance response throws with the status');

/* ----------------------------------------------------------------- 4. the report */

const peakReport = buildReport({ balance, now: at(0, 2) });
expect(peakReport.tariff.peak === true && peakReport.tariff.window === 'peak', 'the report marks peak hours from the host clock');
expect(peakReport.balance.grantedPercent === 28.06, 'grantedPercent is computed against the total');
expect(peakReport.balance.toppedUpPercent === 71.94, 'toppedUpPercent is computed against the total');
expect(peakReport.generatedAt === at(0, 2).toISOString(), 'the report stamps the instant it was built');
expect(buildReport({ balance: null, now: at(0, 12) }).balance === null, 'no balance yet still yields a tariff');
expect(buildReport({ balance: null, now: at(0, 12) }).tariff.peak === false, 'the tariff is off-peak at noon');
const zero = buildReport({ balance: { total: 0, granted: 0, toppedUp: 0, currency: 'USD', available: false } });
expect(zero.balance.grantedPercent === 0 && zero.balance.toppedUpPercent === 0, 'a zero total divides by nothing and stays 0');

/* ------------------------------------------------------- 5. collectReport paths */

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => balancePayload });
const withKey = await (async () => {
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = tmp;
  const report = await collectReport({ now: at(0, 2) });
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  return report;
})();
expect(withKey.balance !== null && withKey.balance.total === 3.92, 'collectReport reads the balance when a credential exists');
expect(withKey.error === null, 'collectReport reports no error on the happy path');

const withoutKey = await collectReport({ home: path.join(tmp, 'empty'), now: at(0, 2) });
expect(withoutKey.balance === null && /key/i.test(withoutKey.error), 'a missing key is reported as an error, not as a zero balance');
expect(withoutKey.tariff.peak === true, 'the tariff is still reported when the balance is unavailable');

/* ----------------------------------------------------- 6. the host route wiring */

function makeCtx() {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    logger: { warn() {} },
    webServer: { register: (spec) => { registered.push(spec); return () => {}; } },
    effect(fn, label) { const dispose = fn(); effects.push({ dispose, label }); },
  };
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {}; },
    end(body) { this.body = body ?? null; },
  };
}

const loopback = { url: '/dsh-balance/usage', socket: { remoteAddress: '127.0.0.1' } };
const remote = { url: '/dsh-balance/usage', socket: { remoteAddress: '10.0.0.7' } };

const ctx = makeCtx();
applyHost(ctx, {});
expect(hostName === 'dsh-balance', 'the host half exports its plugin name');
expect(hostInject.includes('webServer'), 'the host half injects the webserver service');
expect(ctx.registered.length === 1, 'the host half registers exactly one route');
expect(ctx.registered[0]?.kind === 'prefix' && ctx.registered[0]?.path === '/dsh-balance', 'the route is a prefix on /dsh-balance');
expect(ctx.effects.length === 1 && typeof ctx.effects[0].label === 'string', 'the route is registered inside ctx.effect');

process.env.DEEPSEEK_API_KEY = 'sk-route';
let apiCalls = 0;
globalThis.fetch = async () => { apiCalls += 1; return { ok: true, status: 200, json: async () => balancePayload }; };

const denied = makeRes();
await ctx.registered[0].handler(remote, denied);
expect(denied.status === 403, 'a non-loopback request is refused with 403');
expect(apiCalls === 0, 'a refused request never touches the balance API');

const first = makeRes();
await ctx.registered[0].handler(loopback, first);
const firstReport = JSON.parse(first.body);
expect(first.status === 200 && first.headers['content-type'].startsWith('application/json'), 'a loopback request gets JSON');
expect(firstReport.balance.total === 3.92 && typeof firstReport.tariff.peak === 'boolean', 'the payload carries the balance and the tariff');
expect(apiCalls === 1, 'the first read hits the API once');
expect(first.headers['cache-control'] === 'no-store', 'the browser is told not to cache the report');
expect(!/sk-route/.test(first.body), 'the API key never appears in the payload');

const second = makeRes();
await ctx.registered[0].handler(loopback, second);
expect(apiCalls === 1, 'a second read inside the cache window does not call the API again');

const forced = makeRes();
await ctx.registered[0].handler({ ...loopback, url: '/dsh-balance/usage?refresh=1' }, forced);
expect(apiCalls === 2, '?refresh=1 bypasses the host cache');

const custom = makeCtx();
applyHost(custom, { cacheSeconds: 5 });
expect(custom.registered.length === 1, 'a cacheSeconds config still registers one route');

/* ------------------------------------------- 7. the browser half, in a sandbox */

const React = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children } };
  },
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
};
const requiredModules = [];
const win = {};
const sandbox = {
  window: win,
  self: win,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  Date,
  JSON,
  Map,
  Set,
  Symbol,
  RegExp,
  Error,
  TypeError,
  Function,
  Reflect,
  Proxy,
  AbortController,
  URL,
  navigator: { language: 'ru-RU', languages: ['ru-RU', 'ru'] },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { baseURI: 'http://127.0.0.1:3080/' },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
};
sandbox.globalThis = sandbox;
win.__ModuleLoader__ = { load(definition) { win.__definition = definition; } };
win.window = win;

const context = vm.createContext(sandbox);
vm.runInContext(read('client.js'), context, { filename: 'client.js' });

const definition = win.__definition;
expect(definition?.id === 'dsh-balance', 'the client module registers under the package name');
expect(typeof definition?.factory === 'function', 'the client module exposes a factory');

const client = definition.factory((spec) => {
  requiredModules.push(spec);
  if (spec === 'react') return React;
  throw new Error('unexpected require: ' + spec);
});
expect(requiredModules.join(',') === 'react', 'the client half requires nothing but react');
expect(client.inject.includes('slots') && client.inject.includes('locale'), 'the client half injects slots and locale');

const clientCtx = {
  effects: [],
  locales: [],
  slotInjections: [],
  registrations: [],
  effect(fn, label) { const dispose = fn(); this.effects.push({ dispose, label }); },
  locale: {
    register: (...args) => { clientCtx.locales.push(args); },
    bind: () => (key) => key,
    getSnapshot: () => ({ active: 'en' }),
  },
  slots: {
    inject(name, callback) { clientCtx.slotInjections.push({ name, callback }); },
    register(options, component) { clientCtx.registrations.push({ options, component }); },
  },
};
client.apply(clientCtx);

expect(clientCtx.locales.length === 2, 'the client half registers its dictionaries in two calls');
const dictCall = clientCtx.locales.find((call) => call[1] && call[1].en);
const ruCall = clientCtx.locales.find((call) => call[1] === 'ru');
expect(dictCall !== undefined && dictCall[0] === 'dsh.balance', 'dictionaries are registered under the dsh.balance namespace');
expect(ruCall !== undefined && typeof ruCall[2] === 'object', 'the Russian dictionary is registered separately');
expect(clientCtx.slotInjections.length === 1 && clientCtx.slotInjections[0].name === 'sidebar.footer.action', 'the chip registers into sidebar.footer.action');
clientCtx.slotInjections[0].callback();
const registration = clientCtx.registrations[0];
expect(registration?.options.id === 'dsh-balance', 'the slot entry is identified as dsh-balance');
expect(typeof registration?.options.order === 'number', 'the slot entry declares an order');
expect(registration?.options.locale === 'dsh.balance', 'the slot entry declares its locale namespace');

const dictionaries = { en: dictCall[1].en, zh: dictCall[1].zh, ru: ruCall[2] };
const enKeys = Object.keys(dictionaries.en).sort();
expect(enKeys.length >= 8, 'the English table carries the chip vocabulary');
for (const [locale, dict] of Object.entries(dictionaries)) {
  expect(JSON.stringify(Object.keys(dict).sort()) === JSON.stringify(enKeys), 'the ' + locale + ' table has exactly the English key set');
  expect(Object.values(dict).every((value) => typeof value === 'string' && value.length > 0), 'every ' + locale + ' string is non-empty');
}

/* ---- render the registered component with a controllable state ---- */

/** Flatten a React-element tree into host nodes, calling function components. */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push({ tag: '#text', props: {}, text: String(node) });
    return out;
  }
  if (typeof node.type === 'function') return flatten(node.type(node.props), out);
  out.push({ tag: typeof node.type === 'symbol' ? 'Fragment' : node.type, props: node.props ?? {} });
  flatten(node.props?.children ?? [], out);
  return out;
}

const textOf = (nodes) => nodes.filter((n) => n.tag === '#text').map((n) => n.text).join('');
const byClass = (nodes, fragment) => nodes.find((n) => typeof n.props.className === 'string' && n.props.className.includes(fragment));

/** Render the slot occupant with one fixed state and one active locale. */
function renderChip(state, wide, localeId) {
  const dict = dictionaries[localeId];
  const t = (key) => (dict[key] !== undefined ? dict[key] : key);
  let calls = 0;
  // The module captured the sandbox's React object, so its hooks are patched in
  // place: the first useState is the refresh counter, the second the chip state.
  const savedState = React.useState;
  React.useState = () => { calls += 1; return [calls === 1 ? 0 : state, () => {}]; };
  try {
    return flatten(React.createElement(registration.component, { wide, t }));
  } finally {
    React.useState = savedState;
  }
}

const ready = { status: 'ready', report: { balance: { ...balance, grantedPercent: 28.06, toppedUpPercent: 71.94 }, tariff: { peak: true, window: 'peak' } } };
const wide = renderChip(ready, true, 'en');
expect(textOf(wide).includes('$3.92'), 'the ready chip shows the balance amount');
expect(textOf(wide).includes('USD'), 'the wide chip shows the currency caption');
expect(byClass(wide, 'dshb-wallet-dot') !== undefined, 'the wide chip shows the status dot');
const markPeak = byClass(wide, 'dshb-tariff');
expect(markPeak !== undefined, 'the tariff mark is drawn beside the amount');
const chipButtonIndex = wide.indexOf(byClass(wide, 'dshb-wallet'));
const chipTexts = wide.slice(chipButtonIndex + 1)
  .filter((node) => node.tag === '#text')
  .map((node) => node.text);
expect(chipTexts.join('|') === '$3.92|!|USD', 'the wide chip reads amount, mark, currency — in that order');
expect(markPeak?.props.className.includes('dshb-tariff-peak'), 'the mark glows while peak pricing is in effect');
expect(markPeak?.props['aria-label'] === dictionaries.en.tariffPeakHint, 'the peak mark is announced with the peak hint');
const chipButton = byClass(wide, 'dshb-wallet');
expect(chipButton?.props.title.includes('$3.92') && chipButton.props.title.includes('click to refresh'), 'the tooltip carries the amount and the refresh hint');
expect(chipButton?.props.title.includes('granted') && chipButton.props.title.includes('topped up'), 'the tooltip breaks the balance into granted and topped up');
expect(chipButton?.props['aria-label'] === chipButton.props.title, 'the chip is announced with the same text it shows on hover');

const offPeak = renderChip({ ...ready, report: { ...ready.report, tariff: { peak: false, window: 'off-peak' } } }, true, 'en');
const offMark = byClass(offPeak, 'dshb-tariff');
expect(offMark !== undefined && !offMark.props.className.includes('-peak'), 'the mark loses its glow off-peak');
expect(offMark?.props.title === dictionaries.en.tariffOffPeakHint, 'the off-peak mark explains the normal price');

const unknown = renderChip({ status: 'ready', report: { balance: ready.report.balance, tariff: null } }, true, 'en');
expect(byClass(unknown, 'dshb-tariff') === undefined, 'an unknown tariff draws no mark instead of guessing');

const rail = renderChip(ready, false, 'ru');
expect(byClass(rail, 'dshb-wallet-rail') !== undefined, 'the 56px rail state is applied when the column is collapsed');
expect(byClass(rail, 'dshb-wallet-dot') === undefined && byClass(rail, 'dshb-wallet-caption') === undefined, 'the rail drops the dot and the currency caption');
expect(textOf(rail).includes('$3.92'), 'the rail keeps the amount');

const loading = renderChip({ status: 'loading', report: null }, true, 'zh');
expect(textOf(loading).includes('…'), 'the loading chip shows an ellipsis');
expect(byClass(loading, 'dshb-wallet-loading') !== undefined, 'the loading chip is styled as loading');

const errored = renderChip({ status: 'error', report: null, message: 'HTTP 500' }, true, 'en');
expect(textOf(errored).includes('!') && byClass(errored, 'dshb-wallet-error') !== undefined, 'the error chip shows a red exclamation point');
expect(byClass(errored, 'dshb-wallet')?.props.title.includes('HTTP 500'), 'the error tooltip carries the reason');

/* --------------------------------------------------- 8. styles and no secrets */

const clientSource = read('client.js');
const cssBlock = /const CSS = `([\s\S]*?)`;/.exec(clientSource)?.[1] ?? '';
expect(cssBlock.length > 200, 'the chip carries its own stylesheet');
expect(!/#[0-9a-fA-F]{3,8}\b/.test(cssBlock), 'the stylesheet hard-codes no colours — theme tokens only');
expect(!/\b(rgb|hsl)a?\(/.test(cssBlock), 'the stylesheet uses no literal colour functions');
for (const token of ['--dsw-alias-bg-layer-2', '--dsw-alias-label-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-idle-primary']) {
  expect(cssBlock.includes(token), 'the stylesheet uses the theme token ' + token);
}
expect(cssBlock.includes('prefers-reduced-motion'), 'the peak glow respects prefers-reduced-motion');
expect(/dshb-/.test(cssBlock) && !/\.adp-/.test(cssBlock), 'the stylesheet is namespaced to this plugin');
expect(!/DEEPSEEK_API_KEY|api\.deepseek\.com|sk-/.test(clientSource), 'the browser half never mentions the key or the balance API');
expect(!/from ['"]@deepseek-ai\//.test(clientSource) && !/require\(['"]@deepseek-ai\//.test(clientSource), 'the browser half imports no Harness package');

/* ---------------------------------------------------------------- 9. the manifest */

const pkg = readJson('package.json');
expect(pkg.name === 'dsh-balance' && /^\d+\.\d+\.\d+$/.test(pkg.version), 'the manifest carries the package name and a semver version');
expect(pkg.license === 'MIT', 'the manifest declares the MIT licence');
expect(fs.existsSync(path.join(ROOT, pkg.icon)), 'the declared icon file exists');
expect(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'the bundle points at the patch file');
expect(pkg.dsh?.client?.platform === 'web' && pkg.dsh.client.immediately === true, 'the client half is a web module loaded in the first batch');
expect(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), 'the client half declares the sidebar package that owns its slot');
expect(pkg.exports?.['.'] === './index.js' && pkg.exports?.['./client'] === './client.js', 'the manifest exports the host and client entry points');
expect(typeof pkg.engines?.dsh === 'string' && typeof pkg.engines?.node === 'string', 'the manifest declares the DSH and Node ranges');
expect(pkg.dependencies === undefined, 'the plugin has no runtime dependencies to install');
expect(pkg.private !== true, 'the manifest does not mark the package private');

const patch = read('cordis.patch.yml');
expect(/dsh-balance/.test(patch) && patch.includes('insert:'), 'the patch inserts the dsh-balance host row');
const icon = read('icon.svg');
expect(icon.startsWith('<svg') && icon.includes('</svg>'), 'the icon is a standalone SVG');

for (const locale of ['en', 'ru', 'zh']) {
  const file = 'locale/' + locale + '.json';
  const card = readJson(file);
  expect(typeof card.meta?.title === 'string' && card.meta.title.length > 0, file + ' carries a plugin title');
  expect(typeof card.meta?.description === 'string' && card.meta.description.length > 0, file + ' carries a plugin description');
}
for (const file of ['README.md', 'README.en.md', 'LICENSE', '.gitignore']) {
  expect(fs.existsSync(path.join(ROOT, file)), file + ' ships with the repository');
}
expect(read('LICENSE').includes('MIT License') && read('LICENSE').includes('execrat1on'), 'the licence names MIT and the author');

/* --------------------------------------------------- 10. the host half is inert */
/* apply() must not touch the network at registration time: the route fetches. */
const quiet = makeCtx();
apiCalls = 0;
applyHost(quiet, {});
expect(apiCalls === 0, 'registering the route performs no API call');

/* ------------------------------------------------------------------- teardown */

globalThis.fetch = realFetch;
fs.rmSync(tmp, { recursive: true, force: true });

const total = passed.length + failed.length;
const list = (items) => items.map((message, index) => '  ' + String(index + 1).padStart(2) + '. ' + message).join('\n');
if (failed.length > 0) {
  console.log('dsh-balance self-check: ' + passed.length + '/' + total + ' passed\n');
  console.log('failed:\n' + list(failed) + '\n');
  process.exitCode = 1;
} else {
  console.log('dsh-balance self-check: ' + passed.length + '/' + total + ' checks passed');
}
