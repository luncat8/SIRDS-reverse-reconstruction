## SIRDS-reverse-reconstruction

input: SIRDS
output: heightmap and pattern

### these projects

SIRDS https://github.com/luncat8/SIRDS-stereo-image.git
reverse SIRDS https://github.com/luncat8/SIRDS-reverse-reconstruction.git

### what this does

Generates a single image random dot stereogram from a height map with white
noise, then reads the height map and the base pattern back out of the pixels
alone: winner-take-all block matching over the generator's own pairing, with the
match residual as the confidence signal, and the background noise strip
recovered from the rebuilt per-row link table.

    node tests/run.js             # 17 checks, exit code is the result
    node experiments/accuracy.js  # parameter sweeps -> experiments/logs/
    open index.html               # the lab, file:// is fine

`index.html` shows input / stereogram / recovered height / error / recovered
pattern side by side, and takes an external image for a reverse-only run.

### found

Neural Autostereograms from https://github.com/jiupinjia/neural-magic-eye
promising. but i cant see stereo effect on it and they seems do not provide easy to use scripts to reproduce.

### notes

    archive/0.1.0-plan.md      what 0.1.0 is, standalone
    archive/0.1.0-worklog.md   how it was built and measured
    0.1.1-draft.md             next step
    findings-pitfalls-skills.md
