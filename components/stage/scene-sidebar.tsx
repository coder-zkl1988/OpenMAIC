'use client';

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PieChart,
  Cpu,
  MousePointer2,
  BookOpen,
  Globe,
  AlertCircle,
  RefreshCw,
  Trophy,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { ThumbnailInteractive } from '@/components/slide-renderer/components/ThumbnailInteractive';
import { useStageStore, useCanvasStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';
import type { SceneType, SlideContent, InteractiveContent } from '@/lib/types/stage';
import { PENDING_SCENE_ID } from '@/lib/store/stage';

interface SceneSidebarProps {
  readonly collapsed: boolean;
  readonly onCollapseChange: (collapsed: boolean) => void;
  readonly onSceneSelect?: (sceneId: string) => void;
  readonly onRetryOutline?: (outlineId: string) => Promise<void>;
  readonly isCourseComplete?: boolean;
  /**
   * `sidebar` (desktop): the resizable column of titled thumbnails. `rail`
   * (tablet and narrower, TabletLandscape.dc.html): a 64px column of 44px
   * numbered targets whose 展开场景栏 button calls `onCollapseChange(false)`
   * (the host swaps in the sidebar); `collapsed` still hides it (fullscreen).
   * `grid` (the stacked layout's 场景 tab, TabletPortrait.dc.html): the same
   * titled thumbnails as the sidebar in a two-column grid that fills its host;
   * no header, no drag handle, and `collapsed` / `onCollapseChange` unused.
   */
  readonly variant?: 'sidebar' | 'rail' | 'grid';
  /**
   * `touch`: the sidebar opened from the rail gets a 44px collapse button, and
   * the rail/sidebar toggles hand focus to their counterpart after the swap.
   */
  readonly density?: 'default' | 'touch';
}

// Classroom.dc.html draws a fixed 180px column; the owner kept drag-resize,
// so 180 is the default and 170–400 stays the resize range.
const DEFAULT_WIDTH = 180;
const MIN_WIDTH = 170;
const MAX_WIDTH = 400;

// Scene row styling (Classroom.dc.html). The primary-* steps are light-only
// swatches, so dark mode switches to the theme-aware accent-* role tokens.
const ACTIVE_ITEM_CLASS =
  'bg-primary-1 ring-1 ring-primary-3 dark:bg-accent-soft dark:ring-accent-line';
const BADGE_CLASS =
  'text-[10px] font-extrabold size-4 rounded-full flex items-center justify-center shrink-0';
const ACTIVE_BADGE_CLASS = 'bg-primary-6 dark:bg-primary-5 text-white';
const ACTIVE_TITLE_CLASS = 'text-primary-7 dark:text-accent-text';

// The 场景 tab's grid: two columns, 12px apart, inside a 16px inset
const GRID_COLUMNS = 2;
const GRID_GAP = 12;
const GRID_INSET = 16;
/** An item's p-1.5 on both sides */
const ITEM_PADDING_X = 12;
/** Before the grid is measured (and without ResizeObserver, e.g. jsdom) */
const GRID_FALLBACK_THUMB = 160;

const RAIL_WIDTH = 64;
// 44px numbered rail targets (TabletLandscape.dc.html), tinted by scene type
const RAIL_ITEM_CLASS =
  'flex size-11 shrink-0 items-center justify-center rounded-[10px] text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 cursor-pointer';
const RAIL_ACTIVE_CLASS =
  'bg-primary-1 text-accent-text ring-[1.5px] ring-inset ring-primary-3 dark:bg-accent-soft dark:ring-accent-line';
const RAIL_TYPE_CLASS: Record<SceneType, string> = {
  slide: 'bg-subtle text-icon hover:text-fg',
  quiz: 'bg-warning-soft text-warning',
  interactive: 'bg-success-soft text-success',
  pbl: 'bg-interactive-soft text-interactive',
};

export function SceneSidebar({
  collapsed,
  onCollapseChange,
  onSceneSelect,
  onRetryOutline,
  isCourseComplete,
  variant = 'sidebar',
  density = 'default',
}: SceneSidebarProps) {
  const { t } = useI18n();
  const router = useRouter();
  const { scenes, currentSceneId, setCurrentSceneId, generatingOutlines, generationStatus } =
    useStageStore();
  const failedOutlines = useStageStore.use.failedOutlines();
  const generationInterrupted = useStageStore.use.generationInterrupted();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  const [retryingOutlineId, setRetryingOutlineId] = useState<string | null>(null);

  const handleRetryOutline = async (outlineId: string) => {
    if (!onRetryOutline) return;
    setRetryingOutlineId(outlineId);
    try {
      await onRetryOutline(outlineId);
    } finally {
      setRetryingOutlineId(null);
    }
  };

  // Swapping rail <-> sidebar unmounts the toggle that was activated, so the
  // variant it asked for receives focus on its counterpart toggle instead.
  const railExpandRef = useRef<HTMLButtonElement>(null);
  const sidebarCollapseRef = useRef<HTMLButtonElement>(null);
  const focusAfterSwapRef = useRef<'sidebar' | 'rail' | null>(null);
  useEffect(() => {
    if (focusAfterSwapRef.current !== variant) return;
    focusAfterSwapRef.current = null;
    (variant === 'rail' ? railExpandRef : sidebarCollapseRef).current?.focus();
  }, [variant]);

  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const isDraggingRef = useRef(false);

  // The grid's thumbnails follow its width (two columns of whatever the tab has)
  const grid = variant === 'grid';
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!grid || !element) return;
    const measure = () => setGridWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [grid]);
  const thumbSize = grid
    ? gridWidth > 0
      ? Math.max(
          80,
          Math.floor(
            (gridWidth - GRID_INSET * 2 - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS -
              ITEM_PADDING_X,
          ),
        )
      : GRID_FALLBACK_THUMB
    : Math.max(100, sidebarWidth - 28);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingRef.current = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth;

      const handleMouseMove = (me: MouseEvent) => {
        const delta = me.clientX - startX;
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
        setSidebarWidth(newWidth);
      };

      const handleMouseUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth],
  );

  const getSceneTypeIcon = (type: SceneType) => {
    const icons = {
      slide: BookOpen,
      quiz: PieChart,
      interactive: MousePointer2,
      pbl: Cpu,
    };
    return icons[type] || BookOpen;
  };

  const selectScene = (sceneId: string) => {
    if (onSceneSelect) {
      onSceneSelect(sceneId);
    } else {
      setCurrentSceneId(sceneId);
    }
  };

  // The grid is a touch surface: its items are real (focusable) buttons, named
  // like the rail's (not after the thumbnail's slide text). The desktop sidebar
  // keeps its plain clickable rows.
  const gridItemProps = (onActivate: () => void, current: boolean, label: string) =>
    grid
      ? {
          role: 'button' as const,
          tabIndex: 0,
          'aria-label': label,
          'aria-current': current ? ('page' as const) : undefined,
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onActivate();
          },
        }
      : {};

  if (variant === 'rail') {
    // The next generating page and the course-complete page as compact icons
    const outline = generatingOutlines[0];
    const outlineFailed =
      !!outline && (generationInterrupted || failedOutlines.some((f) => f.id === outline.id));
    const outlineRetrying = !!outline && retryingOutlineId === outline.id;
    const canRetryOutline = !!onRetryOutline && !generationInterrupted;
    const pendingActive = currentSceneId === PENDING_SCENE_ID;
    const outlineStatus = outlineRetrying
      ? t('generation.retryingScene')
      : generationInterrupted
        ? t('stage.generationInterrupted')
        : outlineFailed
          ? t('stage.generationFailed')
          : generationStatus === 'paused'
            ? t('stage.paused')
            : t('stage.generating');

    return (
      <nav
        aria-label={t('stage.sceneRail')}
        data-testid="scene-rail"
        style={{ width: collapsed ? 0 : RAIL_WIDTH, transition: 'width 0.3s ease' }}
        className={cn(
          'relative z-20 flex shrink-0 flex-col items-center gap-2 overflow-hidden bg-background',
          collapsed ? 'py-0' : 'border-r border-line py-3',
        )}
      >
        {!collapsed && (
          <>
            <button
              type="button"
              onClick={() => router.push('/')}
              aria-label={t('generation.backToHome')}
              title={t('generation.backToHome')}
              className="mb-2 flex size-11 shrink-0 items-center justify-center rounded-[10px] transition-colors hover:bg-subtle cursor-pointer"
            >
              <img src="/openmaic-mark.png" alt="" className="size-7 object-contain" />
            </button>

            <div
              data-testid="scene-rail-list"
              className="flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden py-0.5 scrollbar-hide"
            >
              {scenes.map((scene, index) => {
                const isActive = currentSceneId === scene.id;
                return (
                  <button
                    key={scene.id}
                    type="button"
                    data-testid="scene-rail-item"
                    aria-label={t('stage.sceneRailItem', { n: index + 1, title: scene.title })}
                    aria-current={isActive ? 'page' : undefined}
                    title={scene.title}
                    onClick={() => selectScene(scene.id)}
                    className={cn(
                      RAIL_ITEM_CLASS,
                      isActive ? RAIL_ACTIVE_CLASS : RAIL_TYPE_CLASS[scene.type],
                    )}
                  >
                    {index + 1}
                  </button>
                );
              })}

              {outline && (
                <button
                  key={`generating-${outline.id}`}
                  type="button"
                  data-testid="scene-rail-pending"
                  aria-label={`${t('stage.sceneRailItem', {
                    n: scenes.length + 1,
                    title: outline.title,
                  })} · ${outlineStatus}`}
                  aria-current={pendingActive && !outlineFailed ? 'page' : undefined}
                  title={
                    outlineFailed && canRetryOutline ? t('generation.retryScene') : outlineStatus
                  }
                  disabled={outlineFailed && (!canRetryOutline || outlineRetrying)}
                  onClick={() => {
                    if (outlineFailed) {
                      if (canRetryOutline) void handleRetryOutline(outline.id);
                      return;
                    }
                    selectScene(PENDING_SCENE_ID);
                  }}
                  className={cn(
                    RAIL_ITEM_CLASS,
                    'disabled:cursor-default',
                    outlineFailed
                      ? 'bg-danger-soft text-danger'
                      : pendingActive
                        ? RAIL_ACTIVE_CLASS
                        : 'bg-subtle text-icon-muted',
                  )}
                >
                  {outlineFailed ? (
                    canRetryOutline ? (
                      <RefreshCw className={cn('size-4', outlineRetrying && 'animate-spin')} />
                    ) : (
                      <AlertCircle className="size-4" />
                    )
                  ) : (
                    <Loader2
                      className={cn('size-4', generationStatus !== 'paused' && 'animate-spin')}
                    />
                  )}
                </button>
              )}

              {isCourseComplete && !outline && (
                <button
                  key="course-complete-slot"
                  type="button"
                  data-testid="scene-rail-complete"
                  aria-label={t('stage.courseComplete')}
                  aria-current={pendingActive ? 'page' : undefined}
                  title={t('stage.courseComplete')}
                  onClick={() => selectScene(PENDING_SCENE_ID)}
                  className={cn(
                    RAIL_ITEM_CLASS,
                    'bg-warning-soft text-warning',
                    pendingActive && 'ring-[1.5px] ring-inset ring-warning',
                  )}
                >
                  <Trophy className="size-[18px]" strokeWidth={1.8} />
                </button>
              )}
            </div>

            <button
              ref={railExpandRef}
              type="button"
              onClick={() => {
                focusAfterSwapRef.current = 'sidebar';
                onCollapseChange(false);
              }}
              aria-label={t('stage.expandSceneSidebar')}
              title={t('stage.expandSceneSidebar')}
              className="mt-auto flex size-11 shrink-0 items-center justify-center rounded-[10px] text-icon transition-colors hover:bg-subtle hover:text-fg cursor-pointer"
            >
              <PanelLeftOpen className="size-[18px]" />
            </button>
          </>
        )}
      </nav>
    );
  }

  const displayWidth = collapsed ? 0 : sidebarWidth;
  const sceneLabel = (index: number, title: string) =>
    t('stage.sceneRailItem', { n: index + 1, title });

  const sceneList = (
    <div
      ref={grid ? gridRef : undefined}
      data-testid="scene-list"
      data-variant={grid ? 'grid' : undefined}
      // The grid is the 场景 tab's navigation, like the rail's <nav>
      role={grid ? 'navigation' : undefined}
      aria-label={grid ? t('stage.sceneRail') : undefined}
      className={cn(
        'flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide',
        grid
          ? 'grid min-h-0 grid-cols-2 content-start gap-3 px-4 pt-3 pb-4'
          : 'px-2 pb-2 pt-1 space-y-1.5',
      )}
    >
      {scenes.map((scene, index) => {
        const isActive = currentSceneId === scene.id;
        const Icon = getSceneTypeIcon(scene.type);
        const isSlide = scene.type === 'slide';
        const isInteractive = scene.type === 'interactive';
        const slideContent = isSlide ? (scene.content as SlideContent) : null;
        const interactiveContent = isInteractive ? (scene.content as InteractiveContent) : null;

        return (
          <div
            key={scene.id}
            data-testid="scene-item"
            onClick={() => selectScene(scene.id)}
            {...gridItemProps(
              () => selectScene(scene.id),
              isActive,
              sceneLabel(index, scene.title),
            )}
            className={cn(
              'group relative rounded-[10px] transition-all duration-200 cursor-pointer flex flex-col gap-1 p-1.5',
              isActive ? ACTIVE_ITEM_CLASS : 'hover:bg-subtle',
              grid && 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            )}
          >
            {/* Scene Header */}
            <div className="flex justify-between items-center px-1 pt-0.5">
              <div className="flex items-center gap-1.5 max-w-full min-w-0">
                <span
                  className={cn(BADGE_CLASS, isActive ? ACTIVE_BADGE_CLASS : 'bg-subtle text-icon')}
                >
                  {index + 1}
                </span>
                <span
                  data-testid="scene-title"
                  className={cn(
                    'text-xs font-semibold truncate transition-colors',
                    isActive ? ACTIVE_TITLE_CLASS : 'text-fg-secondary group-hover:text-fg',
                  )}
                >
                  {scene.title}
                </span>
              </div>
            </div>

            {/* Thumbnail (in the grid it is decoration of the named tile: an
                interactive scene's iframe must not add a tab stop inside it) */}
            <div
              aria-hidden={grid || undefined}
              inert={grid || undefined}
              className="relative aspect-video w-full rounded overflow-hidden bg-white dark:bg-gray-800 ring-1 ring-black/[0.06] dark:ring-white/5"
            >
              <div className="absolute inset-0 flex items-center justify-center">
                {isSlide && slideContent ? (
                  <LazySlideThumbnail
                    slide={slideContent.canvas}
                    sceneId={scene.id}
                    viewportSize={viewportSize}
                    viewportRatio={viewportRatio}
                    size={thumbSize}
                  />
                ) : scene.type === 'quiz' ? (
                  /* Quiz: question bar + 2x2 option grid */
                  <div className="w-full h-full bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/20 p-2 flex flex-col">
                    <div className="h-1.5 w-4/5 bg-orange-200/70 dark:bg-orange-700/30 rounded-full mb-1.5" />
                    <div className="flex-1 grid grid-cols-2 gap-1">
                      {[0, 1, 2, 3].map((i) => (
                        <div
                          key={i}
                          className={cn(
                            'rounded flex items-center gap-1 px-1',
                            i === 1
                              ? 'bg-orange-400/20 dark:bg-orange-500/20 border border-orange-300/50 dark:border-orange-600/30'
                              : 'bg-white/60 dark:bg-white/5 border border-orange-100/60 dark:border-orange-800/20',
                          )}
                        >
                          <div
                            className={cn(
                              'w-1.5 h-1.5 rounded-full shrink-0',
                              i === 1
                                ? 'bg-orange-400 dark:bg-orange-500'
                                : 'bg-orange-200 dark:bg-orange-700/50',
                            )}
                          />
                          <div
                            className={cn(
                              'h-1 rounded-full flex-1',
                              i === 1
                                ? 'bg-orange-300/60 dark:bg-orange-600/40'
                                : 'bg-orange-100/80 dark:bg-orange-800/30',
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : scene.type === 'interactive' && interactiveContent?.html ? (
                  /* Interactive: live iframe preview */
                  <ThumbnailInteractive content={interactiveContent} size={thumbSize} />
                ) : scene.type === 'interactive' ? (
                  /* Interactive: browser window with chrome + content */
                  <div className="w-full h-full bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20 p-1.5 flex flex-col">
                    <div className="flex items-center gap-1 mb-1 pb-1 border-b border-emerald-200/40 dark:border-emerald-700/20">
                      <div className="flex gap-0.5">
                        <div className="w-1 h-1 rounded-full bg-red-300 dark:bg-red-500/60" />
                        <div className="w-1 h-1 rounded-full bg-amber-300 dark:bg-amber-500/60" />
                        <div className="w-1 h-1 rounded-full bg-green-300 dark:bg-green-500/60" />
                      </div>
                      <div className="h-1.5 flex-1 bg-emerald-200/40 dark:bg-emerald-700/30 rounded-full ml-0.5" />
                    </div>
                    <div className="flex-1 flex gap-1">
                      <div className="w-1/4 space-y-1 pt-0.5">
                        {[1, 2, 3].map((i) => (
                          <div
                            key={i}
                            className="h-0.5 w-full bg-emerald-200/60 dark:bg-emerald-700/30 rounded-full"
                          />
                        ))}
                      </div>
                      <div className="flex-1 bg-emerald-100/40 dark:bg-emerald-800/20 rounded flex items-center justify-center border border-emerald-200/40 dark:border-emerald-700/20">
                        <Globe className="w-4 h-4 text-emerald-300/80 dark:text-emerald-600/50" />
                      </div>
                    </div>
                  </div>
                ) : scene.type === 'pbl' ? (
                  /* PBL: kanban board with 3 columns */
                  <div className="w-full h-full bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/20 p-1.5 flex flex-col">
                    <div className="flex items-center gap-1 mb-1.5">
                      <div className="w-1.5 h-1.5 rounded bg-blue-300 dark:bg-blue-600" />
                      <div className="h-1 w-8 bg-blue-200/60 dark:bg-blue-700/30 rounded-full" />
                    </div>
                    <div className="flex-1 flex gap-1 overflow-hidden">
                      {[0, 1, 2].map((col) => (
                        <div
                          key={col}
                          className="flex-1 bg-white/50 dark:bg-white/5 rounded p-0.5 flex flex-col gap-0.5"
                        >
                          <div
                            className={cn(
                              'h-0.5 w-3 rounded-full mb-0.5',
                              col === 0
                                ? 'bg-blue-300/70'
                                : col === 1
                                  ? 'bg-amber-300/70'
                                  : 'bg-green-300/70',
                            )}
                          />
                          {Array.from({
                            length: col === 0 ? 3 : col === 1 ? 2 : 1,
                          }).map((_, i) => (
                            <div
                              key={i}
                              className="h-2 w-full bg-blue-100/60 dark:bg-blue-800/20 rounded border border-blue-200/30 dark:border-blue-700/20"
                            />
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* Fallback */
                  <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-500">
                    <Icon className="w-4 h-4" />
                    <span className="text-[9px] font-bold uppercase tracking-wider opacity-80">
                      {scene.type}
                    </span>
                  </div>
                )}

                {isSlide && (
                  <div
                    className={cn(
                      'absolute inset-0 bg-purple-500/0 transition-colors',
                      isActive
                        ? 'bg-purple-500/0'
                        : 'group-hover:bg-black/5 dark:group-hover:bg-white/5',
                    )}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Single placeholder for the next generating page (clickable) */}
      {generatingOutlines.length > 0 &&
        (() => {
          const outline = generatingOutlines[0];
          const isFailed = generationInterrupted || failedOutlines.some((f) => f.id === outline.id);
          const isRetrying = retryingOutlineId === outline.id;
          const isPaused = generationStatus === 'paused';
          const isActive = currentSceneId === PENDING_SCENE_ID;
          const status = isPaused ? t('stage.paused') : t('stage.generating');

          return (
            <div
              key={`generating-${outline.id}`}
              onClick={() => {
                if (isFailed) return;
                selectScene(PENDING_SCENE_ID);
              }}
              // A failed page holds its own retry button instead
              {...(isFailed
                ? {}
                : gridItemProps(
                    () => selectScene(PENDING_SCENE_ID),
                    isActive,
                    `${sceneLabel(scenes.length, outline.title)} · ${status}`,
                  ))}
              className={cn(
                'group relative rounded-[10px] flex flex-col gap-1 p-1.5 transition-all duration-200',
                isFailed ? 'opacity-100 cursor-default' : 'cursor-pointer hover:bg-subtle',
                !isFailed && !isActive && 'opacity-60',
                isActive && !isFailed && cn(ACTIVE_ITEM_CLASS, 'opacity-100'),
              )}
            >
              {/* Scene Header */}
              <div className="flex justify-between items-center px-1 pt-0.5">
                <div className="flex items-center gap-1.5 max-w-full min-w-0">
                  <span
                    className={cn(
                      BADGE_CLASS,
                      isActive && !isFailed ? ACTIVE_BADGE_CLASS : 'bg-subtle text-icon-muted',
                    )}
                  >
                    {scenes.length + 1}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-semibold truncate transition-colors',
                      isActive && !isFailed
                        ? ACTIVE_TITLE_CLASS
                        : isFailed
                          ? 'text-fg-secondary'
                          : 'text-fg-tertiary',
                    )}
                  >
                    {outline.title}
                  </span>
                </div>
              </div>

              {/* Skeleton Thumbnail */}
              <div
                className={cn(
                  'relative aspect-video w-full rounded overflow-hidden ring-1',
                  isFailed
                    ? 'bg-red-50/30 dark:bg-red-950/10 ring-red-100 dark:ring-red-900/20'
                    : 'bg-gray-100 dark:bg-gray-800 ring-black/5 dark:ring-white/5',
                )}
              >
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                  {isFailed ? (
                    <div className="flex items-center gap-1 text-xs font-medium text-red-500/90 dark:text-red-400">
                      {onRetryOutline && !generationInterrupted ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetryOutline(outline.id);
                          }}
                          disabled={isRetrying}
                          className={cn(
                            'rounded-md hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95 disabled:opacity-50 disabled:active:scale-100',
                            // The grid's only control on a failed tile: a 44px target
                            grid
                              ? 'flex size-11 shrink-0 items-center justify-center'
                              : 'p-1 -ml-1',
                          )}
                          title={t('generation.retryScene')}
                          aria-label={t('generation.retryScene')}
                        >
                          <RefreshCw className={cn('w-3.5 h-3.5', isRetrying && 'animate-spin')} />
                        </button>
                      ) : (
                        <AlertCircle className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isRetrying
                          ? t('generation.retryingScene')
                          : generationInterrupted
                            ? t('stage.generationInterrupted')
                            : t('stage.generationFailed')}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div
                        className={cn(
                          'h-2 w-3/5 bg-gray-200 dark:bg-gray-700 rounded',
                          !isPaused && 'animate-pulse',
                        )}
                      />
                      <div
                        className={cn(
                          'h-1.5 w-2/5 bg-gray-200 dark:bg-gray-700 rounded',
                          !isPaused && 'animate-pulse',
                        )}
                      />
                      <span className="text-[9px] font-medium text-gray-400 dark:text-gray-500 mt-0.5">
                        {status}
                      </span>
                    </>
                  )}
                </div>
                {!isFailed && !isPaused && (
                  <div className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite] bg-gradient-to-r from-transparent via-white/40 dark:via-white/10 to-transparent" />
                )}
              </div>
            </div>
          );
        })()}

      {/* Course-complete placeholder (shown when outline is exhausted) */}
      {isCourseComplete &&
        generatingOutlines.length === 0 &&
        (() => {
          const isActive = currentSceneId === PENDING_SCENE_ID;
          return (
            <div
              key="course-complete-slot"
              onClick={() => selectScene(PENDING_SCENE_ID)}
              {...gridItemProps(
                () => selectScene(PENDING_SCENE_ID),
                isActive,
                t('stage.courseComplete'),
              )}
              className={cn(
                'group relative rounded-[10px] flex flex-col gap-1 p-1.5 transition-all duration-200 cursor-pointer hover:bg-amber-50/60 dark:hover:bg-amber-900/10',
                !isActive && 'opacity-80',
                isActive &&
                  'bg-amber-50 dark:bg-amber-900/20 ring-1 ring-amber-200 dark:ring-amber-700 opacity-100',
              )}
            >
              <div className="flex justify-between items-center px-1 pt-0.5">
                <div className="flex items-center gap-1.5 max-w-full min-w-0">
                  <span
                    className={cn(
                      BADGE_CLASS,
                      isActive
                        ? 'bg-amber-500 dark:bg-amber-400 text-white shadow-sm shadow-amber-500/30'
                        : 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {scenes.length + 1}
                  </span>
                  <span
                    className={cn(
                      'text-xs font-semibold truncate transition-colors',
                      isActive
                        ? 'text-amber-700 dark:text-amber-300'
                        : 'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {t('stage.courseComplete')}
                  </span>
                </div>
              </div>
              <div
                className={cn(
                  'relative aspect-video w-full rounded overflow-hidden ring-1 flex items-center justify-center transition-all',
                  'bg-amber-50/80 dark:bg-amber-950/20',
                  isActive
                    ? 'ring-amber-300 dark:ring-amber-700'
                    : 'ring-amber-100 dark:ring-amber-900/40',
                )}
              >
                {/* soft radial glow */}
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      'radial-gradient(circle at 50% 55%, rgba(251, 191, 36, 0.14), transparent 65%)',
                  }}
                />
                {/* sparkles (subtle) */}
                <svg
                  viewBox="0 0 20 20"
                  className="absolute top-1 right-1.5 w-1.5 h-1.5 text-amber-300/70 dark:text-amber-400/60"
                  aria-hidden
                >
                  <path
                    d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                    fill="currentColor"
                  />
                </svg>
                <svg
                  viewBox="0 0 20 20"
                  className="absolute bottom-1 left-1.5 w-1 h-1 text-amber-300/60 dark:text-amber-400/50"
                  aria-hidden
                >
                  <path
                    d="M10 1 L12 8 L19 10 L12 12 L10 19 L8 12 L1 10 L8 8 Z"
                    fill="currentColor"
                  />
                </svg>
                <Trophy
                  className="relative w-8 h-8 text-amber-500 dark:text-amber-400"
                  strokeWidth={1.6}
                />
              </div>
            </div>
          );
        })()}
    </div>
  );

  if (grid) return sceneList;

  return (
    <div
      style={{
        width: displayWidth,
        transition: isDraggingRef.current ? 'none' : 'width 0.3s ease',
      }}
      className="bg-white/85 dark:bg-slate-900/85 border-r border-line flex flex-col shrink-0 z-20 relative overflow-visible"
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          onMouseDown={handleDragStart}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-50 group hover:bg-purple-400/30 dark:hover:bg-purple-600/30 active:bg-purple-500/40 dark:active:bg-purple-500/40 transition-colors"
        >
          <div className="absolute right-0.5 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-purple-400 dark:group-hover:bg-purple-500 transition-colors" />
        </div>
      )}

      <div className={cn('flex flex-col w-full h-full overflow-hidden', collapsed && 'hidden')}>
        {/* Logo Header */}
        <div
          className={cn(
            'flex items-center justify-between gap-2 shrink-0 relative mt-2 mb-1 pl-3 pr-2.5',
            density === 'touch' ? 'h-11' : 'h-10',
          )}
        >
          <button
            onClick={() => router.push('/')}
            className="flex min-w-0 items-center gap-2 cursor-pointer rounded-[10px] px-1.5 -mx-1.5 py-1 -my-1 hover:bg-subtle active:scale-[0.97] transition-all duration-150"
            title={t('generation.backToHome')}
          >
            <img src="/logo-horizontal.png" alt="OpenMAIC" className="h-[22px] w-auto" />
          </button>
          <button
            ref={sidebarCollapseRef}
            type="button"
            onClick={() => {
              // Only the touch host swaps the sidebar for the rail on collapse
              if (density === 'touch') focusAfterSwapRef.current = 'rail';
              onCollapseChange(true);
            }}
            aria-label={t('stage.collapseSceneSidebar')}
            title={t('stage.collapseSceneSidebar')}
            className={cn(
              'shrink-0 rounded-[10px] flex items-center justify-center bg-subtle text-icon ring-1 ring-black/[0.04] dark:ring-white/[0.06] hover:bg-line hover:text-fg active:scale-90 transition-all duration-200',
              density === 'touch' ? 'size-11' : 'size-7',
            )}
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>

        {/* Scenes List */}
        {sceneList}

        {/* Spacer to push toggle button area */}
        <div className="mt-auto" />
      </div>
    </div>
  );
}

/**
 * Viewport-gated slide thumbnail for the playback sidebar. Scenes far outside
 * the viewport render SlideThumbnail's cheap placeholder instead of a full
 * SlideCanvas — which also spares every off-screen video element its
 * `preload="metadata"` fetch when the classroom opens. The placeholder keeps
 * the same box size, so gating never shifts layout.
 */
function LazySlideThumbnail({
  slide,
  sceneId,
  viewportSize,
  viewportRatio,
  size,
}: {
  readonly slide: SlideContent['canvas'];
  readonly sceneId: string;
  readonly viewportSize: number;
  readonly viewportRatio: number;
  readonly size: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref);
  return (
    <div ref={ref} className="flex h-full w-full items-center justify-center">
      <SlideThumbnail
        slide={slide}
        sceneId={sceneId}
        viewportSize={viewportSize}
        viewportRatio={viewportRatio}
        size={size}
        visible={visible}
      />
    </div>
  );
}
