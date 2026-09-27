// SIRDS round trip.
// Forward: exact port of the "simple noise" path of vendor/gf-source.html.
// Reverse: per-pixel winner-take-all block matching on the generator's own
// (asymmetric) pairing, plus link-table rebuild for base-pattern recovery.
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.SIRDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const DEFAULTS = {
		P: 100,
		depthScale: 20,
		noiseScale: 2,
		winX: 4,
		winY: 2,
		// below the cost of a single mismatched pixel in a 9x5 window (1/45), so
		// the default confidence means a pixel-exact match; raise it for lossy
		// (JPEG) uploads where exact copies no longer survive.
		confRel: 0.02,
		seed: 1
	};

	function defaultParams(over) {
		const p = Object.assign({}, DEFAULTS, over || {});
		p.sMin = p.sMin === undefined ? Math.max(1, p.P - p.depthScale) : p.sMin;
		p.sMax = p.sMax === undefined ? p.P : p.sMax;
		return p;
	}

	// frac(sin(...)*43758.5453123) - not bit-identical across engines, so only
	// compare hashes generated inside one process run (see findings file).
	function hashNoise(x, y, seed) {
		const h = Math.sin(x * 12.9898 + y * 78.233 + seed * 11.17) * 43758.5453123;
		return h - Math.floor(h);
	}

	function patternGray(x, y, p) {
		const ns = p.noiseScale;
		const v = hashNoise(Math.floor(x / ns) * ns, Math.floor(y / ns) * ns, p.seed);
		return v > 0.5 ? 255 : 0;
	}

	// The single place the depth quantization lives: s = floor(P - z*depthScale).
	// The epsilon only matters when z*depthScale lands exactly on an integer (the
	// 8-bit grid makes those exact rationals), where float error would otherwise
	// round the wrong way and break the s -> z -> s inversion.
	function sFromZ(z, p) {
		return Math.max(1, Math.floor(p.P - z * p.depthScale + 1e-9));
	}

	function zFromS(s, p) {
		const z = (p.P - s) / p.depthScale;
		return z < 0 ? 0 : z > 1 ? 1 : z;
	}

	function fillRect(out, w, h, x0, y0, rw, rh, v) {
		const xe = Math.min(w, x0 + rw);
		const ye = Math.min(h, y0 + rh);
		for (let y = Math.max(0, y0); y < ye; y++) {
			const row = y * w;
			for (let x = Math.max(0, x0); x < xe; x++) out[row + x] = v;
		}
	}

	function presetShapes(out, w, h) {
		fillRect(out, w, h, Math.floor(w * 0.2), Math.floor(h * 0.25), Math.floor(w * 0.26), Math.floor(h * 0.4), 140);
		const cx = w * 0.66;
		const cy = h * 0.47;
		const r = h * 0.22;
		const r2 = r * r;
		for (let y = 0; y < h; y++) {
			const dy = y - cy;
			const row = y * w;
			for (let x = 0; x < w; x++) {
				const dx = x - cx;
				if (dx * dx + dy * dy <= r2) out[row + x] = 255;
			}
		}
	}

	function presetTorus(out, w, h) {
		const cx = w / 2;
		const cy = h / 2;
		const maxR = h * 0.32;
		const minR = h * 0.11;
		const mid = (minR + maxR) / 2;
		const thickness = (maxR - minR) / 2;
		for (let y = 0; y < h; y++) {
			const dy = y - cy;
			const row = y * w;
			for (let x = 0; x < w; x++) {
				const dx = x - cx;
				const dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < minR || dist > maxR) continue;
				const intensity = 1 - Math.abs(dist - mid) / thickness;
				out[row + x] = Math.floor((intensity < 0 ? 0 : intensity) * 230);
			}
		}
	}

	function presetRamp(out, w, h) {
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) out[row + x] = Math.floor((x / (w - 1)) * 255);
		}
	}

	function depthPreset(kind, w, h, out) {
		out.fill(0);
		if (kind === 'shapes') presetShapes(out, w, h);
		else if (kind === 'torus') presetTorus(out, w, h);
		else if (kind === 'ramp') presetRamp(out, w, h);
		// 'flat' and unknown kinds stay black (z = 0, the far background)
		return out;
	}

	// 8-bit height that maps back to s under sFromZ. The height grid is coarser
	// than the s grid, but every s has a representative on it, which is what
	// makes "re-generate from recovered" an exact round trip.
	function heightFromS(s, p) {
		const h = Math.floor((255 * (p.P - s)) / p.depthScale);
		return h > 255 ? 255 : h < 0 ? 0 : h;
	}

	function createScratch(w) {
		return {
			same: new Int32Array(w),
			colSAD: new Int32Array(w),
			best: new Int32Array(w),
			bestS: new Int16Array(w),
			parent: new Int32Array(w),
			origin: new Int32Array(w)
		};
	}

	function createReverseOut(w, h, params) {
		const P = params.P;
		return {
			s: new Int16Array(w * h),
			z: new Float32Array(w * h),
			conf: new Float32Array(w * h),
			pattern: new Uint8Array(P * h),
			patternValid: new Uint8Array(P * h)
		};
	}

	function generateSirds(height, w, h, p, out, scratch) {
		if (!scratch) scratch = createScratch(w);
		const same = scratch.same;
		for (let y = 0; y < h; y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) same[x] = x;
			for (let x = 0; x < w; x++) {
				const s = sFromZ(height[row + x] / 255, p);
				const l = Math.floor(x - s / 2);
				const r = l + s;
				if (l >= 0 && r < w) same[r] = l;
			}
			for (let x = 0; x < w; x++) {
				const src = same[x];
				const g = src === x ? patternGray(x, y, p) : out[(row + src) * 4];
				const i = (row + x) * 4;
				out[i] = g;
				out[i + 1] = g;
				out[i + 2] = g;
				out[i + 3] = 255;
			}
		}
	}

	// Column-pair SAD for one separation, then a sliding horizontal window.
	// Both are integer-exact, so this matches the naive quadruple loop bit for bit
	// while doing ~5x less work.
	function columnPairSad(rgba, w, y, s, winY, colSAD) {
		const lim = w - s;
		for (let c = 0; c < lim; c++) colSAD[c] = 0;
		for (let dy = -winY; dy <= winY; dy++) {
			const row = (y + dy) * w;
			for (let c = 0; c < lim; c++) {
				const a = rgba[(row + c) * 4];
				const b = rgba[(row + c + s) * 4];
				colSAD[c] += a > b ? a - b : b - a;
			}
		}
	}

	function reverseRow(rgba, w, y, p, scratch) {
		const { colSAD, best, bestS } = scratch;
		const winX = p.winX;
		for (let x = 0; x < w; x++) {
			best[x] = 0x7fffffff;
			bestS[x] = 0;
		}
		for (let s = p.sMin; s <= p.sMax; s++) {
			columnPairSad(rgba, w, y, s, p.winY, colSAD);
			const half = Math.ceil(s / 2);
			const x0 = winX + half;
			const x1 = w - 1 - (s - half) - winX;
			if (x1 < x0) continue;
			let sum = 0;
			for (let c = 0; c <= 2 * winX; c++) sum += colSAD[c];
			// ascending s with strict < keeps the smallest separation among ties,
			// which is the true one: multiples of s also match exactly.
			if (sum < best[x0]) {
				best[x0] = sum;
				bestS[x0] = s;
			}
			for (let x = x0 + 1; x <= x1; x++) {
				const l = x - half;
				sum += colSAD[l + winX] - colSAD[l - winX - 1];
				if (sum < best[x]) {
					best[x] = sum;
					bestS[x] = s;
				}
			}
		}
	}

	// Rebuild the generator's per-row link table from the recovered separations.
	// Only confident matches are recorded: a wrong-but-noisy s in a border band
	// would otherwise redirect chains and punch holes in the pattern strip.
	function rowLinks(best, bestS, w, p, parent) {
		const limit = p.confRel * 255 * (2 * p.winX + 1) * (2 * p.winY + 1);
		for (let x = 0; x < w; x++) parent[x] = x;
		for (let x = 0; x < w; x++) {
			const s = bestS[x];
			if (s === 0 || best[x] > limit) continue;
			const l = x - Math.ceil(s / 2);
			const r = l + s;
			if (l >= 0 && r < w) parent[r] = l;
		}
	}

	function reverseSirds(rgba, w, h, p, out, scratch) {
		if (!scratch) scratch = createScratch(w);
		const { best, bestS, parent, origin } = scratch;
		const P = p.P;
		const maxCost = 255 * (2 * p.winX + 1) * (2 * p.winY + 1);
		out.s.fill(0);
		out.z.fill(0);
		out.conf.fill(0);
		out.pattern.fill(0);
		out.patternValid.fill(0);
		for (let y = 0; y < h; y++) {
			const row = y * w;
			if (y >= p.winY && y < h - p.winY) {
				reverseRow(rgba, w, y, p, scratch);
				for (let x = 0; x < w; x++) {
					const s = bestS[x];
					if (s === 0) continue;
					const i = row + x;
					out.s[i] = s;
					out.z[i] = zFromS(s, p);
					out.conf[i] = 1 - best[x] / maxCost;
				}
				rowLinks(best, bestS, w, p, parent);
			} else {
				// border rows carry no links, but their free pixels are still
				// valid pattern samples
				for (let x = 0; x < w; x++) parent[x] = x;
			}
			for (let x = 0; x < w; x++) {
				const par = parent[x];
				origin[x] = par === x ? x : origin[par];
			}
			for (let x = 0; x < w; x++) {
				const o = origin[x];
				if (o >= P) continue;
				const j = o + y * P;
				if (out.patternValid[j]) continue;
				out.pattern[j] = rgba[(row + x) * 4];
				out.patternValid[j] = 1;
			}
		}
	}

	return {
		DEFAULTS: DEFAULTS,
		defaultParams: defaultParams,
		hashNoise: hashNoise,
		patternGray: patternGray,
		sFromZ: sFromZ,
		zFromS: zFromS,
		heightFromS: heightFromS,
		depthPreset: depthPreset,
		createScratch: createScratch,
		createReverseOut: createReverseOut,
		generateSirds: generateSirds,
		reverseSirds: reverseSirds,
	};
});
