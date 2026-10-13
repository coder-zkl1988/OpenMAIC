### Whiteboard (write and draw while explaining)

The teacher can open a whiteboard over the slide and build content up step by step while speaking, then close it and return to the slide. Use it for what the slide cannot show by itself:

- a derivation or proof, one line at a time
- a worked example: substitute numbers, compute, reach the result
- a formula built up term by term, with each symbol explained
- a sketch of a relationship: a waveform or function curve, a before/after comparison, a small table of values, arrows between ideas

**When to use it**: decide per page from its key points and description. Use it when the page has a formula, derivation, worked example or process that is clearer when written out step by step, and whenever the description says the teacher works on the whiteboard. Do NOT use it to redraw what the slide already shows — spotlight the slide element instead. Most pages of a non-mathematical course need no whiteboard.

#### Whiteboard actions

All whiteboard actions are `{"type":"action","name":"wb_...","params":{...}}` items in the same JSON array as the speech.

| Action | Params | Use |
|---|---|---|
| `wb_open` | `{}` | Open the whiteboard. Start every whiteboard segment with it. |
| `wb_clear` | `{}` | Erase the board. Put it right after `wb_open` so the segment starts on a clean board. |
| `wb_draw_latex` | `latex`, `x`, `y`, `height` (50-120), optional `color` | Any math. |
| `wb_draw_text` | `content`, `x`, `y`, `width`, `height`, `fontSize`, optional `color` | Plain words: titles, step labels, short notes. No LaTeX inside. |
| `wb_draw_line` | `startX`, `startY`, `endX`, `endY`, optional `color`, `width` (stroke 2-4), `style` (`"solid"`/`"dashed"`), `points` (`["","arrow"]` for an arrowhead at the end) | Arrows, connectors, underlines, axes. |
| `wb_draw_shape` | `shape` (`"rectangle"`/`"circle"`/`"triangle"`), `x`, `y`, `width`, `height`, optional `fillColor` | Boxes and simple markers. Not for curves. |
| `wb_draw_chart` | `chartType` (`"line"`/`"bar"`/`"column"`/`"pie"`/`"scatter"`/...), `x`, `y`, `width`, `height`, `data`: `{labels, legends, series}` | Curves and data. **A waveform or function curve is a `"line"` chart of 12-40 sampled points**: `labels` are the x values as strings, `series` holds one array of y values per curve, `legends` names each curve. |
| `wb_draw_table` | `x`, `y`, `width`, `height`, `data` (rows of strings, first row is the header) | Small tables of values. No LaTeX in cells. |
| `wb_draw_code` | `language`, `code`, `x`, `y`, `width`, `height` (≈ 32 + 22 per line + 16) | Short code snippets in programming courses. |
| `wb_delete` | `elementId` | Remove one element drawn earlier with that `elementId` (give `elementId` in its draw params). |
| `wb_close` | `{}` | Close the whiteboard and return to the slide. |

#### Sequencing rules

1. `wb_open`, then `wb_clear`, then the drawings. Put each drawing **before** the speech that explains it (draw first, then talk), like spotlight.
2. Interleave drawing and speech: one to three drawings, then a `text` explaining them, then the next step. Never draw the whole board silently and explain it afterwards.
3. Close with `wb_close` before any `spotlight` or `laser` (they point at slide elements, which the open whiteboard covers), and at the end of the page. The page must end with the whiteboard closed.
4. Keep one board to at most 8 elements. For a longer derivation, `wb_clear` and continue on a clean board.
5. A page may use the whiteboard once or a few times; a typical whiteboard segment is 4-10 items.

#### Canvas and layout

- The board is **1000 × 563** pixels; `x` grows to the right, `y` grows downward; `(x, y)` is an element's top-left corner.
- Keep everything inside `20 ≤ x`, `x + width ≤ 980`, `20 ≤ y`, `y + height ≤ 543`. Leave at least 20px between elements.
- Stack top to bottom: `next.y = previous.y + previous.height + 30`. Two columns: left `x ∈ [20, 480]`, right `x ∈ [520, 980]`.
- Text sizes: title 28-32, heading 20-24, body 16-18; a one-line text needs `height ≈ fontSize × 1.5 + 20`.
- Give every step of a derivation the same `wb_draw_latex` `height` (60-80 for one-line formulas, 80-120 for sums, integrals and fractions).

#### LaTeX in JSON (critical)

Every backslash in a `latex` value must be written as `\\` in the JSON string: `"\\frac{1}{2\\pi}\\int_{-\\infty}^{\\infty} F(\\omega) e^{i\\omega t}\\,d\\omega"`. A single backslash turns `\frac`, `\theta`, `\times`, `\rightarrow`, `\beta`, `\varphi`, `\nu` into control characters and the formula breaks.

#### Example (a whiteboard segment inside a slide's actions)

```json
[
  {"type":"action","name":"spotlight","params":{"elementId":"text_formula"}},
  {"type":"text","content":"The slide gives the Fourier series. Let's see on the whiteboard how it turns into the transform."},
  {"type":"action","name":"wb_open","params":{}},
  {"type":"action","name":"wb_clear","params":{}},
  {"type":"action","name":"wb_draw_latex","params":{"latex":"f(t)=\\sum_{n=-\\infty}^{\\infty} c_n e^{i n \\omega_0 t}","x":60,"y":40,"height":80}},
  {"type":"text","content":"A periodic signal is a sum of harmonics, spaced omega zero apart."},
  {"type":"action","name":"wb_draw_line","params":{"startX":330,"startY":140,"endX":330,"endY":220,"width":3,"points":["","arrow"]}},
  {"type":"action","name":"wb_draw_text","params":{"content":"Let the period T grow without bound","x":350,"y":160,"width":420,"height":43,"fontSize":18}},
  {"type":"text","content":"Now let the period grow longer and longer. The harmonics move closer together."},
  {"type":"action","name":"wb_draw_latex","params":{"latex":"F(\\omega)=\\int_{-\\infty}^{\\infty} f(t)\\, e^{-i\\omega t}\\,dt","x":60,"y":240,"height":80}},
  {"type":"text","content":"In the limit the sum becomes an integral, and that is the Fourier transform."},
  {"type":"action","name":"wb_close","params":{}},
  {"type":"text","content":"Keep this picture in mind as we read the formula on the slide."}
]
```
