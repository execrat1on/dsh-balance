# dsh-balance

[![self-check](https://github.com/execrat1on/dsh-balance/actions/workflows/test.yml/badge.svg)](https://github.com/execrat1on/dsh-balance/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A **DeepSeek Harness** plugin: the remaining DeepSeek API balance sits in the sidebar
foot, next to the settings gear, and never needs a trip to Settings.

| State | Expanded column | Collapsed rail (56 px) |
|---|---|---|
| Normal tariff | `● $3.92 ! USD` | `$3.92 !` |
| Peak hours | `● $3.92 ! USD` — the mark glows and pulses | `$3.92 !` |
| Loading | `● …` | `…` |
| Error | `● !` in red, the reason on hover | `!` |

## What it does

* **Shows the balance** — `total_balance` from `GET https://api.deepseek.com/user/balance`.
  The hover tooltip breaks it into granted and topped-up money with percentages.
* **Marks peak hours** — an exclamation point in a circle right of the amount:

  | Look | Meaning |
  |---|---|
  | Yellow, glowing and pulsing | Peak hours: tokens cost **2×** |
  | Grey, no glow | Off-peak: the normal (half) price applies |

  The peak window is `01:00–04:00` and `06:00–10:00` UTC, Monday to Friday; weekends are
  off-peak all day. The window is evaluated **on the host, from UTC hours**, not in the
  browser from local time, so the mark does not depend on the visitor's time zone and
  flips within a minute of a boundary. When the tariff is not known yet nothing is drawn:
  the plugin does not guess a price period.
* **Refreshes on click** — clicking the chip issues `?refresh=1` and drops the host cache,
  so the amount moves immediately. Without a click the chip polls once a minute and lands
  in that same cache: no extra calls to the balance API.
* **Localized** — English, Russian, Chinese. It follows the active Harness locale, and the
  same strings feed `title` and `aria-label`, so the mark and the amount are announced by
  screen readers.
* **Follows the theme** — theme tokens only (`--dsw-alias-*`), not one hard-coded colour,
  and `prefers-reduced-motion` turns the glow off.

## Install

Requirements: DSH `>= 0.2.0-rc.2`, Node.js `>= 20`.

**Through the plugin manager.** Settings → Plugins → install a bundle, source `GitHub`,
repository `execrat1on/dsh-balance`. The clone is done by `git`, so it must be on `PATH`.

**From a tarball (when git is unavailable).**

```bash
git clone https://github.com/execrat1on/dsh-balance.git   # or download and unpack the archive
cd dsh-balance
npm pack                                                  # produces dsh-balance-1.0.0.tgz
```

Then install the bundle from that `.tgz` by absolute path — the tarball must stay where it
is, the profile references it.

**API key.** The host reads the key from the environment:

```bash
export DEEPSEEK_API_KEY=sk-...        # Windows PowerShell: $env:DEEPSEEK_API_KEY = 'sk-...'
```

or from the managed `$DSH_HOME/.credentials.yaml` (by default `~/.dsh/.credentials.yaml`):

```yaml
DEEPSEEK_API_KEY: sk-...
```

Without a key the plugin says so honestly: `● !` in red, with the reason on hover. The key
is used to read the balance and nothing else.

**Restart.** Restart Harness after installing: the client module table and the manifest are
read at startup.

## Configuration

The plugin row takes one option:

```yaml
- id: dsh-balance
  config: { cacheSeconds: 60 }
```

`cacheSeconds` is how long the host route serves a cached report (60 by default, which is
also the chip's poll interval). Going lower is not worth it: every cache miss is a call to
`/user/balance`.

## How it works

| Layer | File | Role |
|---|---|---|
| Host | `index.js` | Registers `GET /dsh-balance/usage`, answers loopback only, caches the report |
| Host | `balance.js` | Reads the key, fetches the balance, decides peak/off-peak from UTC. Plain Node — unit-testable and runnable on its own |
| Browser | `client.js` | The chip in the `sidebar.footer.action` slot: one `fetch`, three states, the tariff mark |
| Manifest | `package.json`, `cordis.patch.yml` | The bundle patch plus a client module for the `web` platform |

Run the host logic without Harness:

```bash
node balance.js --table
```

```
tariff: off-peak — normal price
balance: $3.92 USD (granted $1.10 = 28.06%, topped up $2.82 = 71.94%)
prices: https://api-docs.deepseek.com/quick_start/pricing/ (checked 2026-09-29)
```

### Security

* The key is read by the **host only**; the browser receives the amount, the currency and
  the tariff flag — never the key.
* The route answers `127.0.0.1` / `::1` exclusively; a request from any other address gets
  `403` without touching the API. This matters when the webserver is bound to all
  interfaces.
* The browser half requires no Harness package other than `react` and calls nothing but its
  own host route.
* No telemetry and no external CDN: only `api.deepseek.com`, from the host.

## Development

```bash
npm test          # node test/verify.mjs
```

The self-check needs no test framework and no network: 120 assertions covering the UTC peak
window, reading the key from the environment and from `.credentials.yaml`, parsing the
balance response, HTTP failures, the route cache and its loopback filter, the slot
registration, all three chip states, the yellow/grey mark, the three locale tables, plus
"the stylesheet hard-codes no colour" and "the browser half never knows the key".

## License

MIT — see [LICENSE](./LICENSE).

[Русская версия](./README.md)
