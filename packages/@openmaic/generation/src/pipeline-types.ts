/**
 * Type definitions for the generation pipeline.
 */

// ==================== Agent Info ====================

/** Lightweight agent info passed to the generation pipeline */
export interface AgentInfo {
  id: string;
  name: string;
  role: string;
  persona?: string;
}

// ==================== Cross-Page Context ====================

/** Cross-page context for maintaining speech coherence across scenes */
export interface SceneGenerationContext {
  pageIndex: number; // Current page (1-based)
  totalPages: number; // Total number of pages
  allTitles: string[]; // All page titles in order
  previousSpeeches: string[]; // Speech texts from the previous page only
  /**
   * Every page's key points as its outline planned them, in page order like
   * `allTitles` (a page without known key points has none). The slide
   * actions read the pages before this one, so a page that builds on an
   * earlier idea can have the class recall it rather than retell it.
   */
  allKeyPoints?: ReadonlyArray<readonly string[]>;
  /**
   * Every page's type in page order like `allTitles` ('slide', 'quiz',
   * 'interactive', 'pbl'): a page knows whether an activity follows it, where
   * nothing would settle a confusion it leaves open.
   */
  allKinds?: ReadonlyArray<string>;
  /**
   * The class moments of the pages generated before this one, in page order:
   * the discussions, and the pages the class spent on an activity.
   */
  previousMoments?: ClassMoment[];
  /**
   * The course is being built page by page and more pages may follow the
   * last one counted (the workbench): the last page counted is not taken for
   * the course's closing page.
   */
  openEnded?: boolean;
}

/** What happened in class on a page before this one, as later pages read it. */
export type ClassMoment = ClassDiscussionMoment | ClassActivity;

/** The kinds of page a whole class spends working, not listening. */
export type ClassActivityKind = 'quiz' | 'interactive' | 'pbl';

/** A page the whole class spent on an activity (a quiz, an interactive page, a project). */
export interface ClassActivity {
  page: number; // 1-based
  kind: ClassActivityKind;
}

/** A page's class moment: who spoke up during the lecture, and about what. */
export interface ClassDiscussionMoment {
  /** Absent on moments recorded before activities were: a discussion. */
  kind?: 'discussion';
  page: number; // 1-based
  agentName: string;
  /** The opener's role (teacher / assistant / student), when known. */
  agentRole?: string;
  /** What the opener said, as the learner saw it on the card. */
  topic: string;
  /**
   * The teacher's private note for the moment (the discussion's `prompt`):
   * where it should go and, for a confusion or a guess, what is right. A
   * later page that follows the moment up resolves it with this.
   */
  prompt?: string;
}

// ==================== Generated Slide Data Interface ====================

/**
 * AI-generated slide data structure
 * Used to parse AI responses
 */
export interface GeneratedSlideData {
  elements: Array<{
    type: 'text' | 'image' | 'video' | 'shape' | 'chart' | 'latex' | 'line';
    left: number;
    top: number;
    width: number;
    height: number;
    [key: string]: unknown;
  }>;
  background?: {
    type: 'solid' | 'gradient';
    color?: string;
    gradient?: {
      type: 'linear' | 'radial';
      colors: Array<{ pos: number; color: string }>;
      rotate: number;
    };
  };
  remark?: string;
}

// ==================== Types ====================

export interface GenerationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type AICallFn = (
  systemPrompt: string,
  userPrompt: string,
  images?: Array<{ id: string; src: string }>,
) => Promise<string>;
