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

## do not golden-test Math.sin hashes

hashNoise uses frac(sin(...)*43758.545...). Math.sin is not bit-identical
across JS engines (or builds). Determinism tests must generate and compare
within one process run; never commit golden hash-noise files and assert on
them across platforms.

## decode.c loop nit

Proudfoot's decode.c iterates `for (i = 0; i <= lrcount; i++)` over a window
of `lrcount` samples — one extra pixel. Harmless there; when porting the idea,
iterate strictly over the window.
