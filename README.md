# Unzipping the Night

The night sky is a sheet of cloth with a brass zipper in it. Someone has climbed a ladder
from the hill and is pulling the slider down: where the zipper is open, the morning pours out.

`main.ts` draws the whole picture procedurally (Node 22, standard library only, no image
files, no network) and writes it to `/output/entry.png`, or to `$MAKEFUN_OUTPUT_DIR` when set:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

The output is deterministic: two runs write the same bytes.

The first commit of this repository drew an earlier piece, "Side B of the Universe"
(a black hole played as a vinyl record); it is kept in the history.

MIT licensed.
