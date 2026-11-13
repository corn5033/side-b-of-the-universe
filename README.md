# Side B of the Universe

A black hole whose accretion disk is a vinyl record. A tonearm pivoting on a small moon
drops the needle on it, and an astronaut in headphones sits on the rim to listen.

`main.ts` draws the whole picture procedurally (Node 22, standard library only, no image
files, no network) and writes it to `/output/entry.png`, or to `$MAKEFUN_OUTPUT_DIR` when set:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

The output is deterministic: two runs write the same bytes.

MIT licensed.
