/**
 * Browser half of the `dsh-balance` plugin.
 *
 * One occupant of the sidebar foot (`sidebar.footer.action`): the remaining
 * DeepSeek API balance and an exclamation mark that glows while peak pricing
 * doubles the token price. The amount never leaves the eye: it sits in the left
 * column on every page and needs no trip to Settings.
 *
 * All data comes from the host route `GET /dsh-balance/usage`, which reads the
 * API key, asks DeepSeek for the balance and decides peak/off-peak from its own
 * clock. The browser therefore never holds a credential and never re-derives the
 * tariff from the visitor's local time.
 *
 * States:
 *   loading  dot in the idle colour, `…` as the amount
 *   ready    green dot, the amount, the tariff mark, the currency
 *   error    red dot, `!` instead of the amount; hover for the reason
 * A click forces a refresh (`?refresh=1`, which drops the host cache).
 */
window.__ModuleLoader__.load({
	id: 'dsh-balance',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = 'dsh.balance';
		/** Host route, resolved against the page URL. */
		const USAGE_URL = 'dsh-balance/usage';
		/** Poll cadence; matches the host route cache, so polling is free. */
		const POLL_MS = 60_000;

		const EN = {
			walletLabel: 'API balance',
			walletRefresh: 'click to refresh',
			usageLoading: 'Loading…',
			usageFailed: 'Could not read the balance.',
			usageGranted: 'granted',
			usageToppedUp: 'topped up',
			usagePeakNote: 'Peak hours (01:00–04:00 and 06:00–10:00 UTC, Mon–Fri)',
			usageOffPeakNote: 'Off-peak (tokens cost half as much; weekends are off-peak all day)',
			tariffPeakHint: '! Peak hours: tokens cost 2× the off-peak price',
			tariffOffPeakHint: '! Normal price: off-peak rates are in effect',
		};
		const ZH = {
			walletLabel: 'API 余额',
			walletRefresh: '点击刷新',
			usageLoading: '加载中…',
			usageFailed: '无法读取余额。',
			usageGranted: '赠送',
			usageToppedUp: '充值',
			usagePeakNote: '高峰时段（UTC 01:00–04:00 与 06:00–10:00，周一至周五）',
			usageOffPeakNote: '低谷时段（令牌价格为一半；周末全天为低谷）',
			tariffPeakHint: '! 高峰时段：令牌价格为低谷时段的 2 倍',
			tariffOffPeakHint: '! 正常价格：当前为低谷时段费率',
		};
		const RU = {
			walletLabel: 'Остаток на API',
			walletRefresh: 'нажмите, чтобы обновить',
			usageLoading: 'Загрузка…',
			usageFailed: 'Не удалось прочитать баланс.',
			usageGranted: 'подарочные',
			usageToppedUp: 'пополнение',
			usagePeakNote: 'Пиковые часы (01:00–04:00 и 06:00–10:00 UTC, пн–пт)',
			usageOffPeakNote: 'Вне пика (токены вдвое дешевле; выходные целиком вне пика)',
			tariffPeakHint: '! Пиковые часы: токены стоят в 2 раза дороже, чем вне пика',
			tariffOffPeakHint: '! Обычная цена: действует тариф вне пика',
		};

		/**
		 * Styles for the chip. Theme tokens only, so it follows the active theme
		 * and the light/dark switch; no colour is hard-coded here except none.
		 */
		const CSS = `
.dshb-wallet { display: inline-flex; align-items: center; gap: 6px; flex: none; height: 28px; max-width: 100%; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.dshb-wallet:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dshb-wallet:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.dshb-wallet-value { font-weight: 650; }
.dshb-wallet-caption { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dshb-wallet-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); }
/* Rail state: the foot sits in a 56px column, so the chip shrinks to the amount. */
.dshb-wallet-rail { height: 22px; padding: 0 4px; font-size: 9px; letter-spacing: -0.02em; }
.dshb-wallet-loading { color: var(--dsw-alias-label-secondary); }
.dshb-wallet-loading .dshb-wallet-dot { background: var(--dsw-alias-state-idle-primary); }
.dshb-wallet-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.dshb-wallet-error .dshb-wallet-dot { background: var(--dsw-alias-state-error-primary); }
/* Tariff mark beside the amount: glows while peak pricing is in effect and
   stays grey at the normal off-peak price. */
.dshb-tariff { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 15px; height: 15px; border-radius: 50%; border: 1px solid var(--dsw-alias-state-idle-primary); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-idle-primary); font-size: 10px; font-weight: 700; line-height: 1; }
.dshb-tariff-peak { border-color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); box-shadow: 0 0 7px 1px var(--dsw-alias-state-warn-primary); animation: dshb-tariff-glow 2s ease-in-out infinite; }
@keyframes dshb-tariff-glow {
	0%, 100% { box-shadow: 0 0 7px 1px var(--dsw-alias-state-warn-primary); }
	50% { box-shadow: 0 0 12px 3px var(--dsw-alias-state-warn-primary); }
}
@media (prefers-reduced-motion: reduce) {
	.dshb-tariff-peak { animation: none; }
}
`;

		/** `$3.92`, or `$3.920` when more digits are asked for. */
		function money(value, digits) {
			const number = Number(value || 0);
			return '$' + number.toFixed(digits === undefined ? 2 : digits);
		}

		/** The locale lookup, falling back to the English table. */
		const lookup = (t) => (typeof t === 'function' ? t : (key) => (EN[key] !== undefined ? EN[key] : key));

		/**
		 * The tariff mark: an exclamation point in a circle.
		 * `peak === null` means the tariff is not known yet, and then nothing is
		 * drawn at all — the chip does not guess a price period.
		 * @param props - `{ peak, t }`.
		 */
		function TariffMark(props) {
			const t = lookup(props.t);
			if (props.peak === null || props.peak === undefined) return null;
			const peak = props.peak === true;
			const label = t(peak ? 'tariffPeakHint' : 'tariffOffPeakHint');
			return h('span', {
				className: 'dshb-tariff' + (peak ? ' dshb-tariff-peak' : ''),
				role: 'img',
				'aria-label': label,
				title: label,
			}, '!');
		}

		/**
		 * The chip body for one resolved state. Kept pure and separate from the
		 * fetch so the amount, the mark and the caption order can be checked
		 * without a browser.
		 * @param state - `{ status, report, message }`.
		 * @param wide - expanded column (`true`) or the 56px rail (`false`).
		 * @param t - locale lookup.
		 */
		function chipContent(state, wide, t, h) {
			const balance = state.report && state.report.balance ? state.report.balance : null;
			const tariff = state.report && state.report.tariff ? state.report.tariff : null;
			const peak = tariff && typeof tariff.peak === 'boolean' ? tariff.peak : null;
			if (balance) {
				const tariffText = peak === null
					? ''
					: ' · ' + t(peak ? 'usagePeakNote' : 'usageOffPeakNote');
				return {
					className: 'dshb-wallet' + (wide ? '' : ' dshb-wallet-rail'),
					label: t('walletLabel') + ': ' + money(balance.total) + ' ' + balance.currency
						+ ' · ' + t('usageGranted') + ' ' + money(balance.granted) + ' (' + balance.grantedPercent + '%)'
						+ ' · ' + t('usageToppedUp') + ' ' + money(balance.toppedUp) + ' (' + balance.toppedUpPercent + '%)'
						+ tariffText
						+ ' — ' + t('walletRefresh'),
					body: [
						wide ? h('span', { className: 'dshb-wallet-dot', key: 'dot' }) : null,
						h('span', { className: 'dshb-wallet-value', key: 'value' }, money(balance.total)),
						h(TariffMark, { key: 'tariff', peak, t }),
						wide ? h('span', { className: 'dshb-wallet-caption', key: 'unit' }, balance.currency) : null,
					],
				};
			}
			if (state.status === 'error') {
				return {
					className: 'dshb-wallet dshb-wallet-error' + (wide ? '' : ' dshb-wallet-rail'),
					label: t('usageFailed') + ' ' + (state.message || '') + ' — ' + t('walletRefresh'),
					body: [
						wide ? h('span', { className: 'dshb-wallet-dot', key: 'dot' }) : null,
						h('span', { className: 'dshb-wallet-value', key: 'value' }, '!'),
					],
				};
			}
			return {
				className: 'dshb-wallet dshb-wallet-loading' + (wide ? '' : ' dshb-wallet-rail'),
				label: t('walletLabel') + ': ' + t('usageLoading'),
				body: [
					wide ? h('span', { className: 'dshb-wallet-dot', key: 'dot' }) : null,
					h('span', { className: 'dshb-wallet-value', key: 'value' }, '…'),
				],
			};
		}

		/**
		 * The chip itself, for one already-fetched state.
		 * @param props - `{ state, wide, t, onRefresh }`.
		 */
		function BalanceChip(props) {
			const t = lookup(props.t);
			const wide = props.wide !== false;
			const { className, label, body } = chipContent(props.state, wide, t, h);
			return h('button', {
				type: 'button',
				className,
				title: label,
				'aria-label': label,
				onClick: props.onRefresh,
			}, body);
		}

		/**
		 * The slot occupant: fetches the report, polls it, and re-fetches on click.
		 * @param props - slot props: the sidebar passes `{ wide }`, the locale
		 *   layer adds `t`.
		 */
		function BalanceBadge(props) {
			const t = lookup(props.t);
			const wide = props.wide !== false;
			const [attempt, setAttempt] = React.useState(0);
			const [state, setState] = React.useState({ status: 'loading', report: null });

			React.useEffect(() => {
				let cancelled = false;
				const load = (force) => {
					const url = new URL(USAGE_URL, document.baseURI).href + (force ? '?refresh=1' : '');
					fetch(url, { cache: 'no-store' })
						.then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
						.then((report) => {
							if (cancelled) return;
							if (report && report.error && !report.balance) {
								setState({ status: 'error', report: null, message: report.error });
							} else {
								setState({ status: 'ready', report });
							}
						})
						.catch((error) => {
							if (!cancelled) {
								setState({ status: 'error', report: null, message: String(error && error.message ? error.message : error) });
							}
						});
				};
				// The first read uses the host cache; every click after that asks
				// for a fresh one, which is why `attempt` maps to `refresh=1`.
				load(attempt > 0);
				const timer = setInterval(() => load(false), POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [attempt]);

			return h(React.Fragment, null,
				h('style', { key: 'css' }, CSS),
				h(BalanceChip, {
					key: 'chip',
					state,
					wide,
					t,
					onRefresh: () => setAttempt((value) => value + 1),
				}));
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				const t = ctx.locale.bind(NS);
				ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-balance: dictionaries');
				ctx.effect(() => ctx.locale.register(NS, 'ru', RU), 'dsh-balance: russian dictionary');
				ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
					name: 'sidebar.footer.action',
					id: 'dsh-balance',
					order: 10,
					label: () => t('walletLabel'),
					locale: NS,
					inject: () => ({}),
				}, BalanceBadge));
			},
		};
	},
});
