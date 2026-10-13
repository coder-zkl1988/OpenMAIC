## Display Viewport (CRITICAL)

The classroom shows this page in a frame that fills the space next to the chat panel. Its CSS viewport is **at least 1280×720 px and usually taller or wider** (for example 1280×1150 on a laptop, 1600×720 on a wide monitor), and it can change while the page is open (the learner resizes the window, goes fullscreen or collapses a panel). Lay the page out to use all of it:

- Fill the whole viewport: `html, body { height: 100%; margin: 0; }` and a root layout of `height: 100vh` (or `min-height: 100vh` when the page scrolls), built with flex or grid. The main interactive area (canvas, SVG, diagram, editor, game board, 3D view) takes the remaining space (`flex: 1; min-height: 0`) instead of a fixed size.
- Never build the page as a fixed-size stage (1280×720 or any other size) centered in the viewport, and never give the root a fixed pixel height: the extra room would be left as empty bands around it.
- Size canvases, SVG view boxes and 3D renderers from their container (`ResizeObserver` or the `resize` event), not once at load, and redraw on resize without resetting the learner's state.
- Give extra height to the interactive area, not to larger margins or gaps. Keep text at a steady, readable size; do not scale fonts with the viewport.
- A side panel with more content than fits may scroll inside itself, but the main interactive area stays fully visible without scrolling the page.
