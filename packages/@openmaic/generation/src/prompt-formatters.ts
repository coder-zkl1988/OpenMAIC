/**
 * Prompt and context building utilities for the generation pipeline.
 */

import type { PdfImage } from './outline-types.js';
import type { AgentInfo, ClassActivityKind, SceneGenerationContext } from './pipeline-types.js';

/** Build a course context string for injection into action prompts */
export function buildCourseContext(ctx?: SceneGenerationContext): string {
  if (!ctx) return '';

  const lines: string[] = [];

  // Course outline with position marker
  lines.push('Course Outline:');
  ctx.allTitles.forEach((t, i) => {
    const marker = i === ctx.pageIndex - 1 ? ' ← current' : '';
    lines.push(`  ${i + 1}. ${t}${marker}`);
  });

  // Position information
  lines.push('');
  lines.push(
    'IMPORTANT: All pages belong to the SAME class session. Do NOT greet again after the first page. When referencing content from earlier pages, say "we just covered" or "as mentioned on page N" — NEVER say "last class" or "previous session" because there is no previous session.',
  );
  lines.push('');
  if (ctx.pageIndex === 1) {
    lines.push('Position: This is the FIRST page. Open with a greeting and course introduction.');
  } else if (ctx.openEnded && ctx.pageIndex >= ctx.totalPages) {
    lines.push(
      `Position: Page ${ctx.pageIndex}, the latest page so far (the course is being built page by page; more pages may follow). Close the course only if this page's own brief says it is the closing page.`,
    );
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  } else if (ctx.pageIndex === ctx.totalPages) {
    lines.push('Position: This is the LAST page. Conclude the course with a summary and closing.');
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  } else {
    lines.push(`Position: Page ${ctx.pageIndex} of ${ctx.totalPages} (middle of the course).`);
    lines.push(
      'Transition: Continue naturally from the previous page. Do NOT greet or re-introduce.',
    );
  }

  // Previous page speech for transition reference
  if (ctx.previousSpeeches.length > 0) {
    lines.push('');
    lines.push('Previous page speech (for transition reference):');
    const lastSpeech = ctx.previousSpeeches[ctx.previousSpeeches.length - 1];
    lines.push(`  "...${lastSpeech.slice(-150)}"`);
  }

  return lines.join('\n');
}

/** How many pages back a page may still pick up a class moment it answers. */
export const CLASS_MOMENT_CALLBACK_PAGES = 3;

/** The teacher's note of a moment, as much as a later page needs to resolve it. */
const CLASS_MOMENT_NOTE_MAX_CHARS = 200;

/** `text` cut to `max` characters (code points), marked with "…" when cut. */
function cutText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

function cutNote(note: string): string {
  return cutText(note, CLASS_MOMENT_NOTE_MAX_CHARS);
}

/** What the whole class did on an activity page, as the moments list says it. */
const CLASS_ACTIVITY_LINES: Readonly<Record<ClassActivityKind, string>> = {
  quiz: 'quiz — the whole class was answering questions',
  interactive: 'interactive page — the whole class was trying it hands-on',
  pbl: 'project — the whole class was working on it',
};

/** Pages that never follow up a class moment (a quiz, a project): a moment left open stays open across them. */
const NON_SETTLING_KINDS: ReadonlySet<string> = new Set<ClassActivityKind>(['quiz', 'pbl']);

/** What follows a page, as its class moment has to take into account. */
const NEXT_PAGE_LINES: Readonly<Record<string, string>> = {
  quiz: 'After this page: a quiz page, where nothing settles a confusion or wrong guess left open here.',
  pbl: 'After this page: a project page, where nothing settles a confusion or wrong guess left open here.',
};

/**
 * The page of the latest discussion that only quiz or project pages have
 * followed since (no page could follow it up), when it is not the page just
 * before: this page settles it.
 */
function momentLeftOpenAcrossActivities(ctx: SceneGenerationContext): number | undefined {
  const moments = ctx.previousMoments ?? [];
  const latest = [...moments]
    .reverse()
    .find((moment) => !moment.kind || moment.kind === 'discussion');
  if (!latest || latest.page >= ctx.pageIndex - 1) return undefined;
  for (let page = latest.page + 1; page < ctx.pageIndex; page += 1) {
    const activity = moments.find(
      (moment) => moment.page === page && moment.kind && moment.kind !== 'discussion',
    );
    if (!activity?.kind || !NON_SETTLING_KINDS.has(activity.kind)) return undefined;
  }
  return latest.page;
}

/** What comes after this page, when it means a moment left open here stays open. */
function nextPageLine(ctx: SceneGenerationContext): string | undefined {
  if (ctx.pageIndex >= ctx.totalPages) {
    return ctx.openEnded ? undefined : 'After this page: the course ends.';
  }
  const next = ctx.allKinds?.[ctx.pageIndex];
  return next ? NEXT_PAGE_LINES[next] : undefined;
}

/**
 * The class moments of the pages before this one, for the slide actions to
 * pace their own: a page is generated alone, so this is how it knows whether
 * the class just had its say, just worked through a quiz, or has listened
 * for a long stretch. The moment that ended the page just before is marked,
 * and so is one only a quiz or project has followed since; the recent ones
 * carry the teacher's note, so this page can follow up what was left open.
 * Last, what follows this page when nothing there would settle a moment left
 * open here (a quiz, a project, the end of the course).
 */
export function buildClassMoments(ctx?: SceneGenerationContext): string {
  if (!ctx?.previousMoments) return '';
  const after = nextPageLine(ctx);
  const withAfter = (text: string) => (after ? `${text}\n${after}` : text);
  if (ctx.previousMoments.length === 0) {
    return withAfter(
      ctx.pageIndex > 1
        ? `Class moments so far: none yet (pages 1-${ctx.pageIndex - 1}).`
        : 'Class moments so far: none yet (this is the first page).',
    );
  }
  const leftOpenPage = momentLeftOpenAcrossActivities(ctx);
  const lines = ctx.previousMoments.flatMap((moment) => {
    const justBefore = moment.page === ctx.pageIndex - 1;
    if (moment.kind && moment.kind !== 'discussion') {
      const page = justBefore
        ? `page ${moment.page} (the page just before this one)`
        : `page ${moment.page}`;
      return [`  - ${page}: ${CLASS_ACTIVITY_LINES[moment.kind]}`];
    }
    const recent = moment.page >= ctx.pageIndex - CLASS_MOMENT_CALLBACK_PAGES;
    const page = justBefore
      ? `page ${moment.page} (it ended the page just before this one)`
      : moment.page === leftOpenPage
        ? `page ${moment.page} (left open: only a quiz or project came after it, so settle it at the start of this page)`
        : `page ${moment.page}`;
    const who = moment.agentRole ? `${moment.agentName} (${moment.agentRole})` : moment.agentName;
    const line = `  - ${page}: ${who} — "${moment.topic}"`;
    return (recent || moment.page === leftOpenPage) && moment.prompt
      ? [line, `    teacher's note: ${cutNote(moment.prompt)}`]
      : [line];
  });
  return withAfter(['Class moments so far:', ...lines].join('\n'));
}

/** One earlier key point, as much as a callback needs to name the idea. */
const EARLIER_KEY_POINT_MAX_CHARS = 60;
/** The key points of one earlier page a later page is shown. */
const EARLIER_KEY_POINTS_PER_PAGE = 3;
/** All the earlier key points together; over it, the oldest pages are left out. */
const EARLIER_KEY_POINTS_MAX_CHARS = 1200;

/**
 * What the pages before this one taught, as their outlines planned it,
 * compressed: a few short key points per page. A page is generated alone, so
 * this is how its narration knows which earlier idea it builds on and can
 * have the class recall it (spaced retrieval) rather than retell it as "as
 * mentioned on page N". Over the budget, the oldest pages are left out
 * first.
 */
export function buildEarlierKeyPoints(ctx?: SceneGenerationContext): string {
  if (!ctx?.allKeyPoints || ctx.pageIndex <= 1) return '';
  const pages: string[] = [];
  const earlier = ctx.allKeyPoints.slice(0, ctx.pageIndex - 1);
  earlier.forEach((points, index) => {
    const kept = (points ?? [])
      .map((point) => (typeof point === 'string' ? point.replace(/\s+/g, ' ').trim() : ''))
      .filter(Boolean)
      .slice(0, EARLIER_KEY_POINTS_PER_PAGE)
      .map((point) => cutText(point, EARLIER_KEY_POINT_MAX_CHARS));
    if (kept.length > 0) pages.push(`  - page ${index + 1}: ${kept.join('; ')}`);
  });
  let total = pages.reduce((sum, line) => sum + Array.from(line).length + 1, 0);
  while (pages.length > 1 && total > EARLIER_KEY_POINTS_MAX_CHARS) {
    total -= Array.from(pages.shift()!).length + 1;
  }
  if (pages.length === 0) return '';
  return ['Taught on earlier pages (key points):', ...pages].join('\n');
}

/**
 * A persona as an actions prompt quotes it: a persona describes a person in
 * a few sentences, so a longer one (a custom agent's) is cut rather than
 * resent whole on every page (the chat route cuts at the same length).
 */
const PROMPT_PERSONA_MAX_CHARS = 2000;

function personaPart(persona?: string): string {
  const text = persona?.trim();
  return text ? ` — ${cutText(text, PROMPT_PERSONA_MAX_CHARS)}` : '';
}

/** Format agent list for injection into action prompts */
export function formatAgentsForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const lines = ['Classroom Agents:'];
  for (const a of agents) {
    lines.push(`- id: "${a.id}", name: "${a.name}", role: ${a.role}${personaPart(a.persona)}`);
  }
  return lines.join('\n');
}

/**
 * The class for an actions prompt where only the teacher speaks and nobody
 * opens a class moment (a quiz opening, a project introduction): the
 * teacher's persona, for the voice of every line, and everyone else by name
 * and role only, since their personas change nothing there.
 */
export function formatTeacherVoiceForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const teacher = agents.find((a) => a.role === 'teacher');
  const others = agents.filter((a) => a !== teacher);
  const lines = ['Classroom Agents:'];
  if (teacher) {
    lines.push(
      `- Teacher (speaks every line): name: "${teacher.name}"${personaPart(teacher.persona)}`,
    );
  }
  if (others.length > 0) {
    lines.push(
      `- Also in class (they do not speak in your text): ${others
        .map((a) => `${a.name} (${a.role})`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** Extract the teacher agent's persona for injection into outline/content prompts */
export function formatTeacherPersonaForPrompt(agents?: AgentInfo[]): string {
  if (!agents || agents.length === 0) return '';

  const teacher = agents.find((a) => a.role === 'teacher');
  if (!teacher?.persona) return '';

  return `Teacher Persona:\nName: ${teacher.name}\n${teacher.persona}\n\nAdapt the content style and tone to match this teacher's personality. IMPORTANT: The teacher's name and identity must NOT appear on the slides — no "Teacher ${teacher.name}'s tips", no "Teacher's message", etc. Slides should read as neutral, professional visual aids.`;
}

/**
 * Format a single PdfImage description for prompt inclusion.
 * Includes dimension/aspect-ratio info when available.
 */
export function formatImageDescription(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  const sourceInfo = img.sourceDocumentName ? ` from ${img.sourceDocumentName}` : ' from PDF';
  const desc = img.description ? ` | ${img.description}` : '';
  return `- **${img.id}**:${sourceInfo} page ${img.pageNumber}${dimInfo}${desc}`;
}

/**
 * Format a short image placeholder for vision mode.
 * Only ID + page + dimensions + aspect ratio (no description), since the model can see the actual image.
 */
export function formatImagePlaceholder(img: PdfImage): string {
  let dimInfo = '';
  if (img.width && img.height) {
    const ratio = (img.width / img.height).toFixed(2);
    dimInfo = ` | size: ${img.width}×${img.height} (aspect ratio ${ratio})`;
  }
  const sourceInfo = img.sourceDocumentName ? ` from ${img.sourceDocumentName}` : ' from PDF';
  return `- **${img.id}**: image${sourceInfo} page ${img.pageNumber}${dimInfo} [see attached]`;
}

/**
 * Build a multimodal user content array for the AI SDK.
 * Interleaves text and images so the model can associate img_id with actual image.
 * Each image label includes dimensions when available so the model knows the size
 * before seeing the image (important for layout decisions).
 */
export function buildVisionUserContent(
  userPrompt: string,
  images: Array<{ id: string; src: string; width?: number; height?: number }>,
): Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mimeType?: string }> {
  const parts: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string; mimeType?: string }
  > = [{ type: 'text', text: userPrompt }];
  if (images.length > 0) {
    parts.push({ type: 'text', text: '\n\n--- Attached Images ---' });
    for (const img of images) {
      let dimInfo = '';
      if (img.width && img.height) {
        const ratio = (img.width / img.height).toFixed(2);
        dimInfo = ` (${img.width}×${img.height}, aspect ratio ${ratio})`;
      }
      parts.push({ type: 'text', text: `\n**${img.id}**${dimInfo}:` });
      // Strip data URI prefix — AI SDK only accepts http(s) URLs or raw base64
      const dataUriMatch = img.src.match(/^data:([^;]+);base64,(.+)$/);
      if (dataUriMatch) {
        parts.push({
          type: 'image',
          image: dataUriMatch[2],
          mimeType: dataUriMatch[1],
        });
      } else {
        parts.push({ type: 'image', image: img.src });
      }
    }
  }
  return parts;
}

/**
 * Build language instruction text from course-level directive and optional per-scene note.
 * Used by scene content and action generators to inject into prompt templates.
 */
export function buildLanguageText(directive?: string, sceneNote?: string): string {
  if (!directive && !sceneNote) return '';
  let text = directive || '';
  if (sceneNote) {
    text += (text ? '\n\n' : '') + `Additional language note for this scene: ${sceneNote}`;
  }
  return text;
}
