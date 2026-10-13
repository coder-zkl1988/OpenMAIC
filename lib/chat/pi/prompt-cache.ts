/**
 * Prompt-cache seam of the Pi chat prompts. A Pi system prompt runs from the
 * most stable text (rules, roster) to the most volatile (this request's
 * state); this marker separates those segments. The stream adapter
 * (createCallLlmStreamFn with `systemPromptSegmentBreak`) always removes it,
 * and with prompt caching on an Anthropic Claude model it marks every segment
 * but the last as a cache breakpoint, so the stable prefix is reused across
 * the director loop's calls and across requests.
 *
 * A Private Use Area character: it never occurs in course text, and it reads
 * as nothing if it ever slipped through.
 */
export const PROMPT_CACHE_BREAK = '';

/** The stream-adapter options every Pi chat LLM call uses */
export const PI_PROMPT_CACHE_OPTIONS = {
  systemPromptSegmentBreak: PROMPT_CACHE_BREAK,
  promptCaching: true,
} as const;
