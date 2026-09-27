// Node test runner. Exit code is the result.
//
// Independence rule: ground-truth separations and the reference matcher below
// are written from the documented forward model, not imported from sirds.js, so
// formula drift in the implementation fails the tests.
'use strict';

const SIRDS = require('../sirds.js');

// ---------------------------------------------------------------- test-local model

function tSFromZ(z, P, depthScale) {
	return Math.max(1, Math.floor(P - z * depthScale));
}

function tZFromS(s, P, depthScale) {
	const z = (P - s) / depthScale;
	return z < 0 ? 0 : z > 1 ? 1 : z;
}

function tGtSMap(depth, w, h, P, depthScale) {
	const g = new Int16Array(w * h);
	for (let i = 0; i < g.length; i++) g[i] = tSFromZ(depth[i] / 255, P, depthScale);
	return g;
}

// naive quadruple-loop WTA, the reference the incremental matcher must match
function tNaiveReverse(rgba, w, h, P, depthScale, winX, winY, sMin, sMax) {
	const n = w * h;
	const sMap = new Int16Array(n);
	const resMap = new Float32Array(n);
	const maxCost = 255 * (2 * winX + 1) * (2 * winY + 1);
	resMap.fill(1);
	for (let y = winY; y < h - winY; y++) {
		for (let x = 0; x < w; x++) {
			let best = Infinity;
			let bestS = 0;
			for (let s = sMin; s <= sMax; s++) {
				const l = x - Math.ceil(s / 2);
				const r = l + s;
				if (l - winX < 0 || r + winX >= w) continue;
				let cost = 0;
				for (let dy = -winY; dy <= winY; dy++) {
					const row = (y + dy) * w;
					for (let dx = -winX; dx <= winX; dx++) {
						const a = rgba[(row + l + dx) * 4];
						const b = rgba[(row + r + dx) * 4];
						cost += a > b ? a - b : b - a;
					}
				}
				if (cost < best) {
					best = cost;
					bestS = s;
				}
			}
			sMap[y * w + x] = bestS;
			resMap[y * w + x] = bestS === 0 ? 1 : best / maxCost;
		}
	}
	return { sMap, resMap };
}

// Two-pass chamfer (L-infinity, capped) distance transform over an array whose
// zeros are the targets.
function tChamfer(dist, w, h) {
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			let d = dist[i];
			if (x > 0) d = Math.min(d, dist[i - 1] + 1);
			if (y > 0) d = Math.min(d, dist[i - w] + 1);
			if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1] + 1);
			if (x < w - 1 && y > 0) d = Math.min(d, dist[i - w + 1] + 1);
			dist[i] = d;
		}
	}
	for (let y = h - 1; y >= 0; y--) {
		for (let x = w - 1; x >= 0; x--) {
			const i = y * w + x;
			let d = dist[i];
			if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
			if (y < h - 1) d = Math.min(d, dist[i + w] + 1);
			if (x < w - 1 && y < h - 1) d = Math.min(d, dist[i + w + 1] + 1);
			if (x > 0 && y < h - 1) d = Math.min(d, dist[i + w - 1] + 1);
			dist[i] = d;
		}
	}
}

// L-infinity distance (capped) from each pixel to the nearest pixel holding a
// different separation, i.e. the distance to the closest depth discontinuity.
function tValueDistance(gt, w, h, cap) {
	const seen = {};
	const values = [];
	for (let i = 0; i < gt.length; i++) {
		const v = gt[i];
		if (!seen[v]) {
			seen[v] = true;
			values.push(v);
		}
	}
	const dist = new Int16Array(w * h);
	const d = new Int16Array(w * h);
	for (let i = 0; i < dist.length; i++) dist[i] = cap;
	// d_v is the distance to the nearest pixel holding value v, so the wanted
	// distance for a pixel of value u is the min over all v != u
	for (const v of values) {
		for (let i = 0; i < d.length; i++) d[i] = gt[i] === v ? 0 : cap;
		tChamfer(d, w, h);
		for (let i = 0; i < dist.length; i++) {
			if (gt[i] !== v && d[i] < dist[i]) dist[i] = d[i];
		}
	}
	return dist;
}

// ---------------------------------------------------------------------- harness

let failed = 0;
let total = 0;

function check(name, ok, detail) {
	total++;
	if (!ok) failed++;
	const tag = ok ? 'ok  ' : 'FAIL';
	console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function section(title) {
	console.log(`\n== ${title}`);
}

function pct(a, b) {
	return b === 0 ? 0 : (100 * a) / b;
}

// Round-trip metrics on pixels whose ground-truth pair is evaluable.
function metrics(rec, gt, depth, w, h, p) {
	const winX = p.winX;
	const winY = p.winY;
	const confLimit = p.confRel;
	let n = 0;
	let exact = 0;
	let within1 = 0;
	let confident = 0;
	let confExact = 0;
	let confWithin1 = 0;
	let zMae = 0;
	let zMaeQ = 0;
	for (let y = winY; y < h - winY; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sg = gt[i];
			const l = x - Math.ceil(sg / 2);
			if (l - winX < 0 || l + sg + winX >= w) continue;
			n++;
			const sr = rec.s[i];
			const d = sr === 0 ? 999 : Math.abs(sr - sg);
			if (d === 0) exact++;
			if (d <= 1) within1++;
			if (rec.conf[i] >= 1 - confLimit) {
				confident++;
				if (sr === sg) confExact++;
				if (d <= 1) confWithin1++;
			}
			const zr = rec.z[i];
			zMae += Math.abs(zr - depth[i] / 255);
			zMaeQ += Math.abs(zr - tZFromS(sg, p.P, p.depthScale));
		}
	}
	return {
		n: n,
		exactPct: pct(exact, n),
		within1Pct: pct(within1, n),
		confPct: pct(confident, n),
		confExactPct: pct(confExact, confident),
		confWithin1Pct: pct(confWithin1, confident),
		zMae: n === 0 ? 0 : zMae / n,
		zMaeQ: n === 0 ? 0 : zMaeQ / n
	};
}

function printMetrics(m) {
	console.log(`     evaluable=${m.n} exact=${m.exactPct.toFixed(1)}% within1=${m.within1Pct.toFixed(1)}%` +
		` confident=${m.confPct.toFixed(1)}% (of those exact=${m.confExactPct.toFixed(1)}% within1=${m.confWithin1Pct.toFixed(1)}%)` +
		` zMAE=${m.zMae.toFixed(4)} zMAE_quant=${m.zMaeQ.toFixed(4)}`);
}

function roundTrip(kind, w, h, p) {
	const depth = SIRDS.depthPreset(kind, w, h, new Uint8Array(w * h));
	const rgba = new Uint8ClampedArray(w * h * 4);
	const scratch = SIRDS.createScratch(w);
	SIRDS.generateSirds(depth, w, h, p, rgba, scratch);
	const out = SIRDS.createReverseOut(w, h, p);
	SIRDS.reverseSirds(rgba, w, h, p, out, scratch);
	const gt = tGtSMap(depth, w, h, p.P, p.depthScale);
	return { depth, rgba, out, gt, metrics: metrics(out, gt, depth, w, h, p) };
}

// regenerate the SIRDS from a recovered s map; unevaluable or low-confidence
// pixels read as background, which is what makes the flat round trip exact
function regenerate(rec, w, h, p, out) {
	const height = new Uint8Array(w * h);
	for (let i = 0; i < height.length; i++) {
		const s = rec.s[i];
		height[i] = s === 0 || rec.conf[i] < 1 - p.confRel ? 0 : SIRDS.heightFromS(s, p);
	}
	SIRDS.generateSirds(height, w, h, p, out, null);
}

function identicalFraction(a, b) {
	let same = 0;
	for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
	return pct(same, a.length);
}

// ------------------------------------------------------------------------ cases

const P = 100;
const DEPTH_SCALE = 20;
const base = SIRDS.defaultParams({});

section('1. quantization round trip');
{
	const sLo = base.sMin;
	const sHi = base.sMax;
	let okInvert = true;
	let okHeight = true;
	let okFormula = true;
	for (let s = sLo; s <= sHi; s++) {
		const z = SIRDS.zFromS(s, base);
		if (Math.abs(z - tZFromS(s, P, DEPTH_SCALE)) > 1e-12) okInvert = false;
		if (SIRDS.sFromZ(z, base) !== s) okInvert = false;
		if (SIRDS.sFromZ(SIRDS.heightFromS(s, base) / 255, base) !== s) okHeight = false;
	}
	for (let k = 0; k <= 255; k++) {
		const z = k / 255;
		if (SIRDS.sFromZ(z, base) !== tSFromZ(z, P, DEPTH_SCALE)) okFormula = false;
	}
	check(`zFromS/sFromZ invert on the s grid ${sLo}..${sHi}`, okInvert);
	check('heightFromS(s) maps back to s for every reachable s', okHeight);
	check('sFromZ matches the documented formula on the 8-bit z grid', okFormula);
}

section('2. determinism');
{
	const w = 160;
	const h = 80;
	const depth = SIRDS.depthPreset('shapes', w, h, new Uint8Array(w * h));
	const a = new Uint8ClampedArray(w * h * 4);
	const b = new Uint8ClampedArray(w * h * 4);
	SIRDS.generateSirds(depth, w, h, base, a, null);
	SIRDS.generateSirds(depth, w, h, base, b, SIRDS.createScratch(w));
	let same = true;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
	check('same height + params -> byte-identical SIRDS', same);
}

section('3. flat depth');
{
	const w = 320;
	const h = 60;
	const { rgba, out, gt, metrics: m } = roundTrip('flat', w, h, base);
	printMetrics(m);
	let interiorExact = true;
	let interiorConf = true;
	for (let y = base.winY; y < h - base.winY; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sg = gt[i];
			const l = x - Math.ceil(sg / 2);
			if (l - base.winX < 0 || l + sg + base.winX >= w) continue;
			if (out.s[i] !== P || out.conf[i] !== 1) {
				interiorExact = false;
				interiorConf = false;
			}
		}
	}
	check('recovered s == P and conf == 1 on every evaluable interior pixel', interiorExact && interiorConf);
	const regen = new Uint8ClampedArray(w * h * 4);
	regenerate(out, w, h, base, regen);
	const ident = identicalFraction(rgba, regen);
	console.log(`     regenerate-from-recovered identical: ${ident.toFixed(2)}%`);
	check('regenerating from the recovered s map reproduces the SIRDS', ident === 100);
}

section('4. shapes');
{
	const w = 320;
	const h = 200;
	const { metrics: m } = roundTrip('shapes', w, h, base);
	printMetrics(m);
	check('confident pixels within 1 of ground truth >= 95%', m.confWithin1Pct >= 95, `${m.confWithin1Pct.toFixed(1)}%`);
}

section('5. smooth presets');
{
	const w = 320;
	const h = 200;
	const torus = roundTrip('torus', w, h, base);
	printMetrics(torus.metrics);
	check('torus: confident pixels within 1 >= 90%', torus.metrics.confWithin1Pct >= 90, `${torus.metrics.confWithin1Pct.toFixed(1)}%`);
	const ramp = roundTrip('ramp', w, h, base);
	printMetrics(ramp.metrics);
	const bound = 0.25 / base.depthScale;
	check(`ramp: mean |z_rec - z_quant| <= ${bound.toFixed(4)}`, ramp.metrics.zMaeQ <= bound, `${ramp.metrics.zMaeQ.toFixed(4)}`);
}

section('6. seam masking on shapes');
{
	const w = 320;
	const h = 200;
	const { out, gt } = roundTrip('shapes', w, h, base);
	const dist = tValueDistance(gt, w, h, 64);
	let maxJump = 0;
	for (let y = 0; y < h; y++) {
		for (let x = 1; x < w; x++) {
			const d = Math.abs(gt[y * w + x] - gt[y * w + x - 1]);
			if (d > maxJump) maxJump = d;
		}
	}
	const band = base.winX + Math.ceil(maxJump / 2) + 1;
	let farN = 0;
	let farExact = 0;
	let farLow = 0;
	let nearLow = 0;
	let nearN = 0;
	for (let y = base.winY; y < h - base.winY; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sg = gt[i];
			const l = x - Math.ceil(sg / 2);
			if (l - base.winX < 0 || l + sg + base.winX >= w) continue;
			const low = out.conf[i] < 1 - base.confRel;
			if (dist[i] > band) {
				farN++;
				if (out.s[i] === sg) farExact++;
				if (low) farLow++;
			}
			if (dist[i] <= 2) {
				nearN++;
				if (low) nearLow++;
			}
		}
	}
	const farExactPct = pct(farExact, farN);
	const farLowPct = pct(farLow, farN);
	const nearLowPct = pct(nearLow, nearN);
	console.log(`     max s jump=${maxJump} band=${band}px far(exact=${farExactPct.toFixed(2)}% low=${farLowPct.toFixed(2)}% n=${farN}) near2px(low=${nearLowPct.toFixed(1)}% n=${nearN})`);
	check('outside the edge band recovery is exact', farExactPct === 100, `${farExactPct.toFixed(2)}%`);
	check('outside the edge band low-confidence rate ~ 0', farLowPct <= 0.5, `${farLowPct.toFixed(2)}%`);
	check('within 2 px of an edge >= 90% are low-confidence', nearLowPct >= 90, `${nearLowPct.toFixed(1)}%`);
}

section('7. pattern recovery on flat depth');
{
	const w = 320;
	const h = 60;
	const { rgba, out } = roundTrip('flat', w, h, base);
	const strip = out.pattern;
	const valid = out.patternValid;
	let cells = 0;
	let validCells = 0;
	let correct = 0;
	for (let y = 0; y < h; y++) {
		for (let j = 0; j < P; j++) {
			cells++;
			if (valid[j + y * P]) {
				validCells++;
				if (strip[j + y * P] === rgba[(y * w + j) * 4]) correct++;
			}
		}
	}
	console.log(`     strip cells=${cells} valid=${pct(validCells, cells).toFixed(1)}% correct=${pct(correct, cells).toFixed(1)}%`);
	check('every strip cell is filled', validCells === cells, `${validCells}/${cells}`);
	check('strip equals the first P columns of the SIRDS', correct === cells, `${correct}/${cells}`);
}

section('8. window sensitivity');
{
	const w = 320;
	const h = 200;
	const depth = SIRDS.depthPreset('shapes', w, h, new Uint8Array(w * h));
	const rgba = new Uint8ClampedArray(w * h * 4);
	const scratch = SIRDS.createScratch(w);
	SIRDS.generateSirds(depth, w, h, base, rgba, scratch);
	const gt = tGtSMap(depth, w, h, P, DEPTH_SCALE);
	const results = {};
	for (const winX of [2, 4]) {
		const p = SIRDS.defaultParams({ winX: winX });
		const out = SIRDS.createReverseOut(w, h, p);
		SIRDS.reverseSirds(rgba, w, h, p, out, scratch);
		const m = metrics(out, gt, depth, w, h, p);
		results[winX] = m;
		console.log(`     winX=${winX}:`);
		printMetrics(m);
	}
	check('default winX=4 keeps confident within-1 >= 95%', results[4].confWithin1Pct >= 95, `${results[4].confWithin1Pct.toFixed(1)}%`);
	console.log(`     recorded: winX=2 exact=${results[2].exactPct.toFixed(1)}% conf=${results[2].confPct.toFixed(1)}% within1=${results[2].confWithin1Pct.toFixed(1)}%`);
}

section('9. incremental matcher vs naive reference');
{
	const w = 160;
	const h = 100;
	const kinds = ['flat', 'shapes', 'torus', 'ramp'];
	let allOk = true;
	let details = [];
	for (const kind of kinds) {
		const depth = SIRDS.depthPreset(kind, w, h, new Uint8Array(w * h));
		const rgba = new Uint8ClampedArray(w * h * 4);
		const scratch = SIRDS.createScratch(w);
		SIRDS.generateSirds(depth, w, h, base, rgba, scratch);
		const fast = SIRDS.createReverseOut(w, h, base);
		SIRDS.reverseSirds(rgba, w, h, base, fast, scratch);
		const naive = tNaiveReverse(rgba, w, h, P, DEPTH_SCALE, base.winX, base.winY, base.sMin, base.sMax);
		let sDiff = 0;
		let resDiff = 0;
		for (let i = 0; i < fast.s.length; i++) {
			if (fast.s[i] !== naive.sMap[i]) sDiff++;
			if (Math.abs(fast.conf[i] - (1 - naive.resMap[i])) > 1e-6) resDiff++;
		}
		if (sDiff !== 0 || resDiff !== 0) allOk = false;
		details.push(`${kind}:s=${sDiff},res=${resDiff}`);
	}
	check('fast and naive agree on s and residual', allOk, details.join(' '));
}

section('10. degenerate separations (depthScale > P/2)');
{
	// s = 40 and 2s = 80 both match exactly; only the smallest-s tie-break
	// recovers the true separation.
	const p = SIRDS.defaultParams({ depthScale: 60 });
	const w = 240;
	const h = 60;
	const depth = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = Math.floor(w / 2); x < w; x++) depth[y * w + x] = 255;
	}
	const rgba = new Uint8ClampedArray(w * h * 4);
	SIRDS.generateSirds(depth, w, h, p, rgba, null);
	const out = SIRDS.createReverseOut(w, h, p);
	SIRDS.reverseSirds(rgba, w, h, p, out, null);
	let right = 0;
	let wrong = 0;
	for (let y = p.winY; y < h - p.winY; y++) {
		for (let x = Math.floor(w / 2) + 40; x < w - 40; x++) {
			const i = y * w + x;
			if (out.s[i] === p.P - p.depthScale) right++;
			else if (out.s[i] !== 0) wrong++;
		}
	}
	console.log(`     right-half recovered s: correct=${right} other=${wrong}`);
	check('smallest zero-cost s wins over its multiples', wrong === 0, `other=${wrong}`);
}

// ---------------------------------------------------------------------- summary

console.log(`\n${total - failed}/${total} checks passed`);
if (failed > 0) {
	console.log(`${failed} FAILED`);
	process.exit(1);
}
process.exit(0);
