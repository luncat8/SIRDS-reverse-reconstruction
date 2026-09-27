# findings, pitfalls, skills

## fetching reference code in the sandbox

curl/wget to github raw URLs can fail with SSL errors here. Reliable path:

	gh api repos/{owner}/{repo}/contents/{path} --jq .content | base64 -d > out

## gf.html link pairing is asymmetric for odd shifts

The generator pairs pixels centered on the depth pixel x:

	l = floor(x - s/2) = x - ceil(s/2),  r = l + s = x + floor(s/2)

For odd s this is NOT (x - floor(s/2), x + ceil(s/2)) and not decode.c's
`l = x - s/2` with C integer division. A reverse that splits s symmetrically
around x misaligns odd shifts by 1 px and loses the exact-match property.
Always invert with the generator's exact pairing.

## exact copies give a free confidence signal

The generator copies pixel values verbatim along chains (white noise included).
At the true separation the window residual is exactly 0 away from seams, so
winner-take-all matching is near-perfect in flat regions and the residual
itself is the confidence map. Residual > 0 flags depth edges and "echo" seams
(fresh noise inserted where the right() sweep skips columns) — mask those
pixels instead of smoothing them into fake depth.

## the smallest zero-cost separation is the true one

A region of constant s is periodic with period s, so EVERY multiple k*s that
stays inside the search range also scores residual 0. Measured: P=100,
depthScale=60, a z=1 half-plane (true s=40) scores 0 at both s=40 and s=80.
Iterate s ascending and accept a new best only on a strictly lower cost; the
opposite tie-break recovers 80. This matters as soon as depthScale > P/2, so
either keep depthScale <= P/2 in the UI or state the rule.

## only confident matches may rebuild the link table

Pattern recovery needs the generator's per-row `same[]` table, which the
reverse has to rebuild from recovered s. In the border bands (see below) the
best available s is wrong but noisy, and recording those links redirects the
chains: measured on flat input, recording all links gave a 91.6% valid pattern
strip, recording only links whose residual is under the cut gave 100% valid and
100% correct.

## the outer ceil(P/2) columns carry no depth at all

`if (l >= 0 && r < w)` means a pair exists only when both endpoints are inside
the row, so the first and last ceil(P/2) columns never encode any depth. On
top of that the vertical window costs winY rows. Both are "no information",
not "zero depth": mark them unevaluable instead of letting the matcher invent a
value there, or the recovered map grows a false frame around the picture.

## do not golden-test Math.sin hashes

hashNoise uses frac(sin(...)*43758.545...). Math.sin is not bit-identical
across JS engines (or builds). Determinism tests must generate and compare
within one process run; never commit golden hash-noise files and assert on
them across platforms.

## float error breaks s -> z -> s on the 8-bit grid

`z = k/255` and `depthScale = 20` make `z*depthScale` an exact dyadic rational,
so `P - z*depthScale` can land a hair below an integer and `Math.floor` returns
the neighbouring s. That breaks the s -> z -> s inversion the whole reverse
depends on. Nudge by 1e-9 inside `sFromZ` and keep it in one place.

## a binary confidence mask lies about smooth gradients

On a smooth ramp the window straddles a depth step, so the true s does not
score 0 and most pixels are "low confidence" — yet 97-100% of them are recovered
within one step. Painting them all red hides a map that is actually good. Tint
the recovered view continuously by the residual and keep the binary cut for
the statistics only.

## verify pages without a browser

This sandbox has no browser and no puppeteer. Two cheap checks that catch real
bugs anyway:

- run the page's inline script under `node:vm` with a ~60 line stub for
  document/canvas/Image. Every handler runs, and typos in the element id map
  (a class of bug that no parse check catches) blow up immediately.
- render the views to PNG from node and look at them: a zlib-only PNG encoder
  is ~20 lines and makes "does the recovered map actually look right" a
  question with a yes/no answer. It found the confidence-mask problem above
  that every number in the test suite had happily passed.
