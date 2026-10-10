'use client';

import { useState, useEffect, useMemo, useRef, useDeferredValue } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Folder,
  FolderPlus,
  ImagePlus,
  Pencil,
  Search,
  Settings,
  Sun,
  Moon,
  Monitor,
  ChevronUp,
  Upload,
  Sparkles,
  X,
  Presentation,
  Loader2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { LanguageSwitcher } from '@/components/language-switcher';
import { createLogger } from '@/lib/logger';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { SettingsDialog } from '@/components/settings';
import { GenerationToolbar } from '@/components/generation/generation-toolbar';
import { AgentBar } from '@/components/agent/agent-bar';
import { useTheme } from '@/lib/hooks/use-theme';
import {
  courseGenerationUsable,
  requireModelCapabilities,
} from '@/lib/model-settings/capabilities';
import {
  RunApiError,
  discardGenerationRun,
  runApiErrorText,
} from '@/lib/generation-run-client/api';
import {
  RunStartRefusedError,
  startClassicRun,
  startDefinitelyRefused,
} from '@/lib/generation-run-client/start';
import {
  useCourseMaterials,
  type CourseMaterialMessage,
} from '@/lib/generation-run-client/use-course-materials';
import { useOwnerRuns } from '@/lib/generation-run-client/use-owner-runs';
import {
  courseRunHref,
  courseRunStatus,
  pendingCourseName,
  pendingCourseRuns,
  runsByCourse,
} from '@/lib/generation-run-client/course-card';
import type { RunSnapshot } from '@/lib/generation-run-client/types';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  setStageFolder,
  FolderNameError,
  LIBRARY_CHANGED_EVENT,
  type DeleteFolderMode,
} from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/types/folder';
import { displayNameWidth, FOLDER_NAME_MAX_WIDTH } from '@/lib/utils/folder-name-validation';
import { FolderCard } from '@/components/discovery/folder-card';
import { NewFolderDialog } from '@/components/discovery/folder-dialogs';
import { ClassroomCard } from '@/components/discovery/classroom-card';
import { LibrarySkeleton } from '@/components/discovery/library-skeleton';
import type { Slide } from '@openmaic/dsl';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCourseThumbnails } from '@/lib/hooks/use-course-thumbnails';
import { useEscapeLayer } from '@/lib/hooks/use-escape-layer';
import { SpeechButton } from '@/components/audio/speech-button';
import { useImportClassroom } from '@/lib/import/use-import-classroom';
import {
  isProWorkbenchEnabled,
  isPptxImportEnabled,
  shouldShowVocationalTestUi,
} from '@/lib/config/feature-flags';
import { useImportPptx } from '@/lib/import/use-import-pptx';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';
import { ProBadge } from '@/components/workbench/ProBadge';
import { arrivedByProSwap, startProSwap } from '@/lib/workbench/pro-swap';
import {
  readLastWorkspaceSessionId,
  workspaceResumeHref,
} from '@/lib/workbench/workspace-session-memory';

const log = createLogger('Home');

const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';
/** The library header's labeled text actions (导入课堂, the flag-gated PPTX import). */
const LIBRARY_TEXT_ACTION =
  'inline-flex items-center gap-1 h-7 rounded-full px-2.5 text-xs text-icon whitespace-nowrap hover:text-fg hover:bg-subtle disabled:opacity-50 disabled:pointer-events-none transition-colors cursor-pointer';
const INTERACTIVE_MODE_STORAGE_KEY = 'interactiveModeEnabled';

// PPTX import is still scaffolding: `useImportPptx` has no `onImported` consumer
// yet, so the flow only logs the parsed slides. Hide the entry point behind a
// flag until it's wired end-to-end, so the UI doesn't expose a no-op button.
const PPTX_IMPORT_ENABLED = isPptxImportEnabled();

/** The configured runtime probe result, retained across client navigations. */
let workbenchRuntimeCache: boolean | null = null;

interface FormState {
  requirement: string;
  interactiveMode: boolean;
  vocationalTestMode: boolean;
}

const initialFormState: FormState = {
  requirement: '',
  interactiveMode: false,
  vocationalTestMode: false,
};

function HomePage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  // Do not replay the classic hero's entrance after the route handoff already
  // carried the lockup and composer into place. The entrance is CSS, not a
  // JS-driven animation, so the server-rendered hero is painted (and fades in)
  // before the page's scripts have loaded instead of staying invisible.
  const [swapped] = useState(arrivedByProSwap);
  const heroEnter = (classes: string) =>
    swapped
      ? undefined
      : `animate-in fill-mode-both ease-out motion-reduce:animate-none ${classes}`;
  const showVocationalTestUi = shouldShowVocationalTestUi();
  const workbenchBuildEnabled = isProWorkbenchEnabled();
  const [workbenchRuntimeEnabled, setWorkbenchRuntimeEnabled] = useState(
    workbenchRuntimeCache === true,
  );
  useEffect(() => {
    if (!workbenchBuildEnabled || workbenchRuntimeCache !== null) return;
    let cancelled = false;
    fetch('/api/agent/runtime')
      .then((response) => {
        // Not cached: a 401 before the access code is accepted is not an answer.
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((body) => {
        workbenchRuntimeCache = body?.enabled === true;
        if (!cancelled) setWorkbenchRuntimeEnabled(workbenchRuntimeCache);
      })
      .catch(() => {
        // A failed probe keeps the entry hidden and allows a later visit to retry.
      });
    return () => {
      cancelled = true;
    };
  }, [workbenchBuildEnabled]);
  const workbenchEntryEnabled = workbenchBuildEnabled && workbenchRuntimeEnabled;
  const enterWorkbench = () => {
    const href = workspaceResumeHref(readLastWorkspaceSessionId());
    startProSwap(href, (next) => router.push(next));
  };
  useEffect(() => {
    if (workbenchEntryEnabled) router.prefetch('/workspace');
  }, [router, workbenchEntryEnabled]);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    import('@/lib/types/settings').SettingsSection | undefined
  >(undefined);

  // Generation needs the course slots it resolves (outline, content, actions)
  // to name a model, whether or not the llm root does (the server's view;
  // while it cannot be read the server has the last word).
  const hasUsableProvider = courseGenerationUsable(useModelCapabilities());
  const [recentOpen, setRecentOpen] = useState(true);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
      if (saved !== null) setRecentOpen(saved !== 'false');
    } catch {
      /* localStorage unavailable */
    }
    try {
      const savedInteractiveMode = localStorage.getItem(INTERACTIVE_MODE_STORAGE_KEY);
      if (savedInteractiveMode === 'true') {
        setForm((prev) => ({ ...prev, interactiveMode: true }));
      }
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True while the Generate click starts the run. Doubles as the guard flag
  // that freezes the course material set for the duration of the start and as
  // the switch that disables the toolbar's add/remove/Retry affordances, so
  // the run is always started from a set that cannot change under it.
  const [preparingGenerate, setPreparingGenerate] = useState(false);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  // First-slide thumbnails load lazily, per card near the viewport: the list
  // renders as soon as /api/stages answers, never behind every course's
  // document and media.
  const { thumbnails, requestThumbnail, retainThumbnails } = useCourseThumbnails();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Course folders — device-local grouping. `currentFolderId === undefined`
  // is the root view (folders + unfiled courses); a folder id navigates into
  // that folder's course list. Searching flattens every course regardless of
  // folder and annotates each with its folder name.
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  // True once the initial classroom + folder loads resolve. Guards layout
  // selection so the hero does not flip between full-screen and compact as the
  // two async reads land (avoids a visible layout shift on first paint).
  const [hydrated, setHydrated] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // When set, the new-folder dialog is creating a folder AND moving this course
  // into it (entered via the move-menu's "new folder" entry).
  const [createAndMoveTarget, setCreateAndMoveTarget] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!themeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeOpen]);

  const loadClassrooms = async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      retainThumbnails(new Set(list.map((c) => c.id)));
    } catch (err) {
      log.error('Failed to load classrooms:', err);
      toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
    }
  };

  // Courses being generated on the server: a card from the moment the run
  // starts, live through the owner's run stream.
  const { runs, forget: forgetRun } = useOwnerRuns({
    onCourseChanged: () => void loadClassrooms(),
  });

  const loadFolders = async () => {
    try {
      setFolders(await listFolders());
    } catch (err) {
      log.error('Failed to load folders:', err);
    }
  };

  // Capture the active folder when an import starts so the imported course
  // lands in that folder, not whichever folder is active when the async import
  // resolves (the user may have navigated away in the meantime).
  const importFolderRef = useRef<string | undefined>(undefined);
  const handleImportSuccess = async (importedStageId: string) => {
    const folderId = importFolderRef.current;
    importFolderRef.current = undefined;
    // File the imported course into the folder that was active when the
    // import began, before refreshing the list so the card appears in place.
    if (folderId) {
      try {
        await setStageFolder(importedStageId, folderId);
      } catch (err) {
        log.error('Failed to assign imported course to folder:', err);
        toast.error(t('classroom.moveFailed'));
      }
    }
    await loadClassrooms();
  };
  const { importing, fileInputRef, triggerFileSelect, handleFileChange } =
    useImportClassroom(handleImportSuccess);
  const triggerImport = () => {
    importFolderRef.current = currentFolderId;
    triggerFileSelect();
  };

  const {
    importing: pptxImporting,
    fileInputRef: pptxFileInputRef,
    triggerFileSelect: triggerPptxFileSelect,
    handleFileChange: handlePptxFileChange,
  } = useImportPptx();

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Read sessionStorage on the client only (avoids SSR hydration mismatch).
    // Both reads resolve before flipping `hydrated`, so the hero layout does
    // not thrash as each lands independently.
    void Promise.all([loadClassrooms(), loadFolders()]).finally(() => setHydrated(true));

    // Courses can arrive in the background (the one-way import of what this
    // browser stored before persistence moved to the server).
    const onLibraryChanged = () => {
      void Promise.all([loadClassrooms(), loadFolders()]);
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);

    return () => {
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
    };
  }, []);

  const handleDelete = (id: string) => {
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      // A card whose course does not exist yet is its run: discarding the run
      // deletes it. Deleting a course ends its run.
      const pendingRun = runs.find((run) => run.id === id);
      if (pendingRun) {
        await discardGenerationRun(id);
        forgetRun(id);
        return;
      }
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  // ─── Folder handlers ────────────────────────────────────────────────
  const handleCreateFolder = async (name: string) => {
    const folder = await createFolder(name);
    setFolders((prev) => [...prev, folder]);
    // If this create came from the move-menu's "new folder" entry, move the
    // requesting course into the freshly created folder.
    if (createAndMoveTarget) {
      await handleMoveCourse(createAndMoveTarget, folder.id);
      setCreateAndMoveTarget(null);
    }
  };

  const handleRenameFolder =
    (folder: FolderRecord) =>
    async (newName: string): Promise<string | null> => {
      // Empty or unchanged input just exits editing without an error.
      const trimmed = newName.trim();
      if (!trimmed || trimmed === folder.name) return null;
      try {
        await renameFolder(folder.id, newName);
        setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, name: trimmed } : f)));
        return null;
      } catch (err) {
        if (err instanceof FolderNameError) {
          if (err.kind === 'duplicate') return t('classroom.folderNameExists');
          if (err.kind === 'tooLong')
            return t('classroom.folderWidth', {
              width: displayNameWidth(trimmed),
              max: FOLDER_NAME_MAX_WIDTH,
            });
          return t('classroom.folderNameHint');
        }
        log.error('Failed to rename folder:', err);
        return t('classroom.folderRenameFailed');
      }
    };

  const confirmDeleteFolder = async (folder: FolderRecord, mode: DeleteFolderMode) => {
    try {
      await deleteFolder(folder.id, mode);
      if (currentFolderId === folder.id) setCurrentFolderId(undefined);
    } catch (err) {
      log.error('Failed to delete folder:', err);
      toast.error(t('classroom.folderDeleteFailed'));
    } finally {
      // Always refresh authoritative state: in 'remove' mode a partial failure
      // may have durably deleted some courses before throwing, and the UI must
      // reflect that rather than leaving stale cards/counts behind.
      await Promise.all([loadFolders(), loadClassrooms()]);
    }
  };

  const handleMoveCourse = async (stageId: string, folderId: string | undefined) => {
    // Optimistic update for snappy UI; the persistence call follows.
    setClassrooms((prev) => prev.map((c) => (c.id === stageId ? { ...c, folderId } : c)));
    try {
      await setStageFolder(stageId, folderId);
    } catch (err) {
      log.error('Failed to move course:', err);
      toast.error(t('classroom.moveFailed'));
      // Revert on failure.
      await loadClassrooms();
    }
  };

  // From the move-menu's "new folder" entry: remember the course, then open the
  // folder dialog. The actual create+move happens in handleCreateFolder once the
  // name is confirmed. (A Radix DropdownMenu is modal, so the name input cannot
  // live inside it; the dialog is the focus surface.)
  const handleCreateAndMove = (stageId: string) => () => {
    setCreateAndMoveTarget(stageId);
    setNewFolderOpen(true);
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return classrooms;
    return classrooms.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [classrooms, deferredSearchQuery]);

  // Folder-aware view model. Searching collapses the hierarchy: every matching
  // course is shown flat, annotated with its folder name. Otherwise the root
  // view shows folder tiles + unfiled courses, and a folder view shows only
  // that folder's members.
  const folderNameById = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const isSearching = deferredSearchQuery.trim().length > 0;
  // The course tiles rendered in the active view: search flattens everything;
  // a folder shows only its members; the root shows unfiled courses (folder
  // tiles are rendered separately above them).
  const visibleClassrooms = useMemo(() => {
    if (isSearching) return filteredClassrooms;
    if (currentFolderId) return filteredClassrooms.filter((c) => c.folderId === currentFolderId);
    return filteredClassrooms.filter(
      (c) => c.folderId === undefined || !folderNameById.has(c.folderId),
    );
  }, [filteredClassrooms, isSearching, currentFolderId, folderNameById]);
  const currentFolderClassrooms = useMemo(
    () => (currentFolderId ? classrooms.filter((c) => c.folderId === currentFolderId) : []),
    [classrooms, currentFolderId],
  );
  const courseCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of classrooms) {
      if (c.folderId) counts.set(c.folderId, (counts.get(c.folderId) ?? 0) + 1);
    }
    return counts;
  }, [classrooms]);
  // Up to 3 member course covers (first-slide thumbnails) per folder, for the
  // folder tile's cover stack. Members are ordered by updatedAt desc so the
  // frontmost cover is the most recently touched course. The members that
  // fill (or, not loaded yet, may fill) those 3 slots are the tile's cover
  // candidates: it loads their thumbnails while it is near the viewport, and a
  // member without a slide gives its slot to the next one.
  const folderCovers = useMemo(() => {
    const byFolder = new Map<string, { slides: Slide[]; candidates: StageListItem[] }>();
    for (const c of [...classrooms].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (!c.folderId) continue;
      const covers = byFolder.get(c.folderId) ?? { slides: [], candidates: [] };
      byFolder.set(c.folderId, covers);
      if (covers.candidates.length >= 3) continue;
      const slide = thumbnails[c.id];
      if (slide === null) continue;
      covers.candidates.push(c);
      if (slide) covers.slides.push(slide);
    }
    return byFolder;
  }, [classrooms, thumbnails]);
  const currentFolder = folders.find((f) => f.id === currentFolderId);

  const listedStageIds = useMemo(() => new Set(classrooms.map((c) => c.id)), [classrooms]);
  const runByStageId = useMemo(() => runsByCourse(runs), [runs]);
  // Runs whose course is not in the library yet are cards of their own.
  const pendingRuns = useMemo(
    () => pendingCourseRuns(runs, listedStageIds),
    [runs, listedStageIds],
  );
  const showPendingRuns = !isSearching && currentFolderId === undefined;

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'interactiveMode')
        localStorage.setItem(INTERACTIVE_MODE_STORAGE_KEY, String(value));
    } catch {
      /* ignore */
    }
  };

  // Attached materials upload and extract at once; Generate waits for them.
  const courseMaterials = useCourseMaterials();
  const materialMessage = (message: CourseMaterialMessage) =>
    message.text ?? (message.key ? t(message.key, message.values) : '');

  const addCourseMaterials = async (files: File[]) => {
    // The set is frozen while a run is being started.
    if (preparingGenerate) return;
    const refusal = await courseMaterials.add(files);
    setError(refusal ? materialMessage(refusal) : null);
  };

  const removeCourseMaterial = (id: string) => {
    if (preparingGenerate) return;
    courseMaterials.remove(id);
  };

  const handleGenerate = async () => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (preparingGenerate) return;
    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }

    setError(null);

    // The set is frozen while the run starts (`preparingGenerate` makes add,
    // remove and Retry inert), from the ready materials in their order.
    setPreparingGenerate(true);
    // The run releases the materials it is started from once it is over.
    // Handed off before anything is awaited: a navigation in between must not
    // delete them under the run.
    const materialIds = courseMaterials.handOff();
    try {
      // Nothing is started from settings that could not be read.
      const capabilities = await requireModelCapabilities();
      if (!capabilities) throw new Error(t('generation.modelSettingsUnavailable'));
      // Nor from a material that went meanwhile: its chip shows it removed.
      if (materialIds.length > 0 && !(await courseMaterials.verify())) {
        throw new Error(t('toolbar.materialUnavailable'));
      }
      const run = await startClassicRun({
        requirement: form.requirement,
        materialIds,
        interactive: form.vocationalTestMode ? true : form.interactiveMode,
        taskEngine: form.vocationalTestMode,
        capabilities,
      });
      router.push(`/generation-preview?run=${encodeURIComponent(run.id)}`);
    } catch (err) {
      log.error('Error starting generation:', err);
      // Only a definitive refusal says no run holds them: they stay attached.
      // A lost answer may hide a run that releases them when it is over.
      if (!(err instanceof RunApiError) || startDefinitelyRefused(err)) {
        courseMaterials.takeBack(materialIds);
      }
      if (err instanceof RunStartRefusedError) {
        setError(t(err.reason, err.values));
      } else if (err instanceof RunApiError) {
        setError(runApiErrorText(err, t));
      } else {
        setError(err instanceof Error ? err.message : t('upload.generateFailed'));
      }
    } finally {
      // Unfreeze the set once prep settles (navigation unmounts this page, so
      // this is normally a no-op on the way out).
      setPreparingGenerate(false);
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  // Generate waits for every attached material to be uploaded and extracted.
  const canGenerate = !!form.requirement.trim() && hasUsableProvider && courseMaterials.allReady;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate && !preparingGenerate) handleGenerate();
    }
  };

  return (
    <div
      data-ui="v2"
      className="min-h-app w-full bg-gradient-to-b from-page to-page-end flex flex-col items-center p-4 pt-16 md:p-8 md:pt-16 overflow-x-hidden"
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        onChange={handleFileChange}
        className="hidden"
      />
      {PPTX_IMPORT_ENABLED && (
        <input
          ref={pptxFileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          onChange={handlePptxFileChange}
          className="hidden"
        />
      )}
      {/* ═══ Top-right pill: language · theme · settings, 32px buttons ═══ */}
      <div
        ref={toolbarRef}
        className="fixed top-[calc(1rem+var(--desktop-titlebar-height))] right-4 z-50 flex items-center gap-1 bg-white/75 dark:bg-card/60 backdrop-blur-md px-1.5 py-1 rounded-full border border-line shadow-xs"
      >
        {/* Language Selector */}
        <LanguageSwitcher
          size="md"
          ariaLabel={t('common.switchLanguage')}
          onOpen={() => setThemeOpen(false)}
        />

        <div className="w-[1px] h-4 bg-line" />

        {/* Theme Selector */}
        <div className="relative">
          <button
            type="button"
            aria-label={t('settings.themeWithCurrent', {
              theme: t(`settings.themeOptions.${theme}`),
            })}
            aria-expanded={themeOpen}
            onClick={() => {
              setThemeOpen(!themeOpen);
            }}
            className="size-8 flex items-center justify-center rounded-full text-icon hover:bg-card dark:hover:bg-subtle hover:text-fg hover:shadow-sm transition-all"
          >
            {theme === 'light' && <Sun className="w-4 h-4" />}
            {theme === 'dark' && <Moon className="w-4 h-4" />}
            {theme === 'system' && <Monitor className="w-4 h-4" />}
          </button>
          {themeOpen && (
            <div className="absolute top-full mt-2 right-0 bg-popover border border-line rounded-lg shadow-lg overflow-hidden z-50 min-w-[140px]">
              <button
                onClick={() => {
                  setTheme('light');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-subtle transition-colors flex items-center gap-2',
                  theme === 'light' &&
                    'bg-primary-1 text-primary-6 dark:bg-accent-soft dark:text-accent-text',
                )}
              >
                <Sun className="w-4 h-4" />
                {t('settings.themeOptions.light')}
              </button>
              <button
                onClick={() => {
                  setTheme('dark');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-subtle transition-colors flex items-center gap-2',
                  theme === 'dark' &&
                    'bg-primary-1 text-primary-6 dark:bg-accent-soft dark:text-accent-text',
                )}
              >
                <Moon className="w-4 h-4" />
                {t('settings.themeOptions.dark')}
              </button>
              <button
                onClick={() => {
                  setTheme('system');
                  setThemeOpen(false);
                }}
                className={cn(
                  'w-full px-4 py-2 text-left text-sm hover:bg-subtle transition-colors flex items-center gap-2',
                  theme === 'system' &&
                    'bg-primary-1 text-primary-6 dark:bg-accent-soft dark:text-accent-text',
                )}
              >
                <Monitor className="w-4 h-4" />
                {t('settings.themeOptions.system')}
              </button>
            </div>
          )}
        </div>

        <div className="w-[1px] h-4 bg-line" />

        {/* Settings Button */}
        <div className="relative">
          <button
            type="button"
            aria-label={t('settings.title')}
            onClick={() => setSettingsOpen(true)}
            className="size-8 flex items-center justify-center rounded-full text-icon hover:bg-card dark:hover:bg-subtle hover:text-fg hover:shadow-sm transition-all group"
          >
            <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
          </button>
        </div>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsSection(undefined);
        }}
        initialSection={settingsSection}
      />

      {/* ═══ Background Decor ═══ */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div
          className="absolute top-0 left-1/4 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '4s' }}
        />
        <div
          className="absolute bottom-0 right-1/4 w-96 h-96 bg-primary-5/10 rounded-full blur-3xl animate-pulse"
          style={{ animationDuration: '6s' }}
        />
      </div>

      {/* ═══ Hero section: title + input (centered, wider) ═══ */}
      <div
        className={cn(
          'relative z-20 w-full max-w-[800px] flex flex-col items-center mt-[10vh]',
          heroEnter('fade-in slide-in-from-bottom-5 duration-600'),
        )}
      >
        {/* ── Logo ── */}
        <div className="relative" data-pro-morph="lockup">
          <img
            src="/logo-horizontal.png"
            alt="OpenMAIC"
            className={cn(
              'h-12 md:h-16 mb-2 -ml-2 md:-ml-3',
              heroEnter('fade-in zoom-in-90 duration-500 delay-100'),
            )}
          />
          {workbenchEntryEnabled ? (
            <div
              className="absolute left-full top-0 ml-1.5 mt-[10px] md:ml-2 md:mt-[14px]"
              data-pro-morph="badge"
            >
              <ProBadge active={false} onToggle={enterWorkbench} />
            </div>
          ) : null}
        </div>

        {/* ── Slogan ── */}
        <p
          className={cn(
            'text-sm text-fg-tertiary mb-8',
            heroEnter('fade-in duration-300 delay-250'),
          )}
        >
          {t('home.slogan')}
        </p>

        {/* ── Unified input area ── */}
        <div className={cn('w-full', heroEnter('fade-in zoom-in-97 duration-300 delay-350'))}>
          <div
            data-pro-morph="composer"
            className="w-full rounded-2xl border border-line bg-white/92 dark:bg-card/80 backdrop-blur-xl shadow-[0_20px_25px_-5px_rgba(0,0,0,0.04),0_8px_10px_-6px_rgba(0,0,0,0.04)] dark:shadow-black/20 transition-shadow focus-within:shadow-2xl focus-within:shadow-primary-6/[0.06]"
          >
            {/* ── Greeting + Profile + Agents ── wraps on narrow widths; the
                agent bar starts at 384px and may shrink */}
            <div className="relative z-20 flex flex-wrap items-start justify-between gap-1">
              <GreetingBar />
              <div className="box-content basis-96 shrink min-w-0 pl-4 pr-3 pt-3.5">
                <AgentBar />
              </div>
            </div>

            {/* Requirement textarea (e2e HomePage.textarea finds it by its testid) */}
            <textarea
              ref={textareaRef}
              data-testid="home-requirement"
              aria-label={t('upload.requirementLabel')}
              placeholder={t('upload.requirementPlaceholder')}
              className="w-full resize-none border-0 bg-transparent px-4 pt-1 pb-2 text-sm leading-[1.6] text-fg placeholder:text-icon-muted focus:outline-none min-h-[140px] max-h-[300px]"
              value={form.requirement}
              onChange={(e) => updateForm('requirement', e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
            />

            {/* Toolbar row: [model][📎][深度交互] wrap cluster, then [mic][进入课堂] */}
            <div className="px-3 pb-3 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <GenerationToolbar
                  courseMaterials={courseMaterials.materials}
                  onCourseMaterialsAdd={(files) => void addCourseMaterials(files)}
                  onCourseMaterialRemove={removeCourseMaterial}
                  onCourseMaterialRetry={(id) => {
                    if (!preparingGenerate) courseMaterials.retry(id);
                  }}
                  onPdfError={setError}
                  materialsLocked={preparingGenerate}
                  onSettingsOpen={(section) => {
                    setSettingsSection(section);
                    setSettingsOpen(true);
                  }}
                  trailing={
                    // Interactive mode toggle (TooltipTrigger asChild relies on its forwardRef)
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InteractiveModeButton
                          pressed={form.interactiveMode}
                          label={t('toolbar.interactiveModeLabel')}
                          onPressedChange={(pressed) => updateForm('interactiveMode', pressed)}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {t('toolbar.interactiveModeHint')}
                      </TooltipContent>
                    </Tooltip>
                  }
                />
              </div>

              {/* Voice input */}
              <SpeechButton
                size="md"
                shape="circle"
                onTranscription={(text) => {
                  setForm((prev) => {
                    const next = prev.requirement + (prev.requirement ? ' ' : '') + text;
                    return { ...prev, requirement: next };
                  });
                }}
              />

              {/* Send button */}
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate || preparingGenerate}
                className={cn(
                  'shrink-0 h-8 rounded-full flex items-center justify-center gap-1.5 transition-all px-4 text-[13px] font-semibold',
                  canGenerate && !preparingGenerate
                    ? 'bg-primary text-primary-foreground hover:opacity-90 shadow-[0_4px_12px_-2px_rgba(114,46,209,0.35)] cursor-pointer'
                    : 'bg-primary-1 text-primary-4 dark:bg-accent-soft dark:text-primary-4/70 cursor-not-allowed',
                )}
              >
                <span>
                  {preparingGenerate ? t('stage.generating') : t('toolbar.enterClassroom')}
                </span>
                {preparingGenerate ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowUp className="size-3.5" strokeWidth={2.25} />
                )}
              </button>
            </div>
          </div>
        </div>

        {showVocationalTestUi && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="mt-2 flex w-full justify-start px-1"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="switch"
                  aria-checked={form.vocationalTestMode}
                  onClick={() => updateForm('vocationalTestMode', !form.vocationalTestMode)}
                  className={cn(
                    'inline-flex h-7 items-center gap-2 rounded-full border px-2.5 text-[11px] font-medium transition-colors',
                    form.vocationalTestMode
                      ? 'border-cyan-400/70 bg-cyan-50 text-cyan-700 shadow-[0_0_10px_rgba(6,182,212,0.16)] dark:bg-cyan-950/40 dark:text-cyan-300'
                      : 'border-border/70 bg-background/70 text-muted-foreground hover:border-cyan-300/60 hover:text-cyan-700 dark:hover:text-cyan-300',
                  )}
                >
                  <span className="rounded-full bg-cyan-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-cyan-700 dark:bg-cyan-900/45 dark:text-cyan-300">
                    测试功能
                  </span>
                  <Sparkles className="size-3.5" />
                  <span>职教任务</span>
                  <span
                    className={cn(
                      'relative h-3.5 w-6 rounded-full transition-colors',
                      form.vocationalTestMode ? 'bg-cyan-500' : 'bg-muted-foreground/25',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 size-2.5 rounded-full bg-white transition-transform',
                        form.vocationalTestMode ? 'translate-x-2.5' : 'translate-x-0',
                      )}
                    />
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                从当前输入框提交职教实操训练测试
              </TooltipContent>
            </Tooltip>
          </motion.div>
        )}

        {/* ── Error ── */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mt-3 w-full p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
            >
              <p className="text-sm text-destructive">{error}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ═══ Recent classrooms — collapsible ═══ */}
      {/* The library action bar is always present: it carries the New-folder /
          import / search actions, so a brand-new user with zero courses and
          zero folders can still create the first folder or import. One stable
          action surface across root, folder, and empty. Until the library and
          folder reads resolve, the section shows a skeleton of its own layout
          (server-rendered, so it is on screen before the page's scripts run). */}
      <div className="relative z-10 mt-10 w-full max-w-6xl flex flex-col items-center">
        {/* Trigger — divider-line with centered text. Fixed height keeps the
              bar geometrically stable when the New-folder action or the folder
              path appears/disappears (entering vs leaving a folder). */}
        <div className="w-full flex items-center gap-4 h-9">
          <div className="flex-1 h-px bg-line" />
          <div className="shrink-0 flex items-center gap-3 text-[13px] text-fg-tertiary select-none">
            <button
              type="button"
              aria-expanded={recentOpen}
              onClick={() => {
                if (currentFolderId) setCurrentFolderId(undefined);
                else persistRecentOpen(!recentOpen);
              }}
              className="flex items-center gap-2 hover:text-fg transition-colors cursor-pointer"
            >
              <Clock className="size-3.5" />
              {t('classroom.recentClassrooms')}
              {currentFolder && (
                <>
                  <ChevronRight className="size-3 text-icon-muted" />
                  <span className="text-fg-secondary truncate max-w-[160px]">
                    {currentFolder.name}
                  </span>
                </>
              )}
              {hydrated ? (
                <span className="text-[11px] tabular-nums">
                  {currentFolder ? currentFolderClassrooms.length : classrooms.length}
                </span>
              ) : (
                <span aria-hidden className="h-3 w-4 rounded-sm bg-line animate-pulse" />
              )}
              <motion.div
                animate={{ rotate: recentOpen ? 180 : 0 }}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
              >
                <ChevronDown className="size-3.5" />
              </motion.div>
            </button>

            {/* Search toggle — icon that expands into an input in place */}
            <AnimatePresence initial={false}>
              {!searchOpen ? (
                <motion.button
                  key="search-icon"
                  ref={searchButtonRef}
                  type="button"
                  aria-label={t('classroom.searchAriaLabel')}
                  onClick={() => {
                    setSearchOpen(true);
                    if (!recentOpen) persistRecentOpen(true);
                    requestAnimationFrame(() => searchInputRef.current?.focus());
                  }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12, ease: 'easeOut' }}
                  className="flex items-center justify-center size-7 rounded-full text-icon hover:text-fg hover:bg-subtle transition-colors cursor-pointer"
                >
                  <Search className="size-3.5" />
                </motion.button>
              ) : (
                <motion.div
                  key="search-input"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 200 }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                  className="overflow-hidden"
                >
                  <InputGroup
                    className={cn(
                      'h-7 text-[12px] rounded-full bg-subtle border-transparent shadow-none',
                      'transition-colors',
                      'hover:border-line',
                      'has-[[data-slot=input-group-control]:focus-visible]:bg-subtle',
                      'has-[[data-slot=input-group-control]:focus-visible]:border-line',
                      'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                    )}
                  >
                    <InputGroupInput
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          if (searchQuery) {
                            setSearchQuery('');
                          } else {
                            setSearchOpen(false);
                            requestAnimationFrame(() => searchButtonRef.current?.focus());
                          }
                        }
                      }}
                      onBlur={() => {
                        if (!searchQuery) {
                          setSearchOpen(false);
                        }
                      }}
                      placeholder={t('classroom.searchPlaceholder')}
                      aria-label={t('classroom.searchAriaLabel')}
                      className="h-7 pl-3 text-fg placeholder:text-icon-muted"
                    />
                    {searchQuery && (
                      <InputGroupButton
                        size="icon-xs"
                        aria-label={t('classroom.clearSearch')}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setSearchQuery('');
                          searchInputRef.current?.focus();
                        }}
                      >
                        <X />
                      </InputGroupButton>
                    )}
                  </InputGroup>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Import — always labeled (导入课堂), a quiet text button. */}
            <button
              type="button"
              onClick={triggerImport}
              disabled={importing}
              className={LIBRARY_TEXT_ACTION}
            >
              <Upload className="size-3" />
              {t('import.classroom')}
            </button>
            {PPTX_IMPORT_ENABLED && (
              <button
                type="button"
                onClick={triggerPptxFileSelect}
                disabled={pptxImporting}
                className={LIBRARY_TEXT_ACTION}
              >
                <Presentation className="size-3" />
                {t('import.pptx')}
              </button>
            )}
            {/* New folder — round icon button on the subtle fill. */}
            {!currentFolderId && !isSearching && (
              <button
                type="button"
                onClick={() => {
                  if (!recentOpen) persistRecentOpen(true);
                  setNewFolderOpen(true);
                }}
                aria-label={t('classroom.newFolderTitle')}
                title={t('classroom.newFolderTitle')}
                className="inline-flex items-center justify-center size-7 rounded-full bg-subtle text-icon ring-1 ring-line hover:text-fg hover:ring-line-strong transition-[color,box-shadow] cursor-pointer"
              >
                <FolderPlus className="size-3.5" />
              </button>
            )}
          </div>
          <div className="flex-1 h-px bg-line" />
        </div>

        {/* Expandable content. Present from the first render, so it does not
              play its expand animation then: the server-rendered skeleton must
              be visible without the page's scripts. */}
        <AnimatePresence initial={false}>
          {recentOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
              className="w-full overflow-hidden"
            >
              {!hydrated ? (
                <LibrarySkeleton />
              ) : folders.length === 0 && classrooms.length === 0 && pendingRuns.length === 0 ? (
                <div className="pt-8 pb-2 text-center text-[13px] text-fg-tertiary">
                  {t('classroom.emptyLibraryHint')}
                </div>
              ) : !isSearching && currentFolderId && currentFolderClassrooms.length === 0 ? (
                // Empty folder: hint directly below the centered path bar.
                <div className="pt-8 text-center">
                  <p className="text-[14px] text-fg-tertiary">{t('classroom.emptyFolderHint')}</p>
                </div>
              ) : isSearching && filteredClassrooms.length === 0 ? (
                <div className="pt-8 pb-2 text-center text-[13px] text-fg-tertiary">
                  {t('classroom.searchEmpty')}
                </div>
              ) : (
                <div className="pt-8">
                  {/* Breadcrumb — shown only while searching (the folder path
                        already lives in the centered header above). */}
                  {isSearching && (
                    <div className="mb-4 flex items-center gap-1.5 text-[13px] text-muted-foreground">
                      <button
                        type="button"
                        onClick={() => {
                          setCurrentFolderId(undefined);
                          setSearchQuery('');
                          setSearchOpen(false);
                        }}
                        className="hover:text-foreground transition-colors"
                      >
                        {t('classroom.recentClassrooms')}
                      </button>
                      <ChevronRight className="size-3.5" />
                      <span className="text-foreground font-medium">
                        {t('classroom.searchResults')}
                      </span>
                      <span className="ml-1.5 text-[12px] text-muted-foreground tabular-nums">
                        ({filteredClassrooms.length})
                      </span>
                    </div>
                  )}

                  {/* No entrance when the grid first appears: it takes the
                      skeleton's place, and fading or staggering it in would
                      flash an empty section in between. Switching views (and
                      cards added later) still animate. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={
                        isSearching
                          ? 'search'
                          : currentFolderId
                            ? `folder-${currentFolderId}`
                            : 'root'
                      }
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.2 }}
                      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-8"
                    >
                      {/* Root + non-search: render folder tiles first. */}
                      {!isSearching &&
                        currentFolderId === undefined &&
                        folders.map((folder, i) => (
                          <motion.div
                            key={folder.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                          >
                            <FolderCard
                              folder={folder}
                              courseCount={courseCountByFolder.get(folder.id) ?? 0}
                              coverSlides={folderCovers.get(folder.id)?.slides ?? []}
                              coverCandidates={folderCovers.get(folder.id)?.candidates ?? []}
                              requestThumbnail={requestThumbnail}
                              onOpen={() => setCurrentFolderId(folder.id)}
                              onRename={handleRenameFolder(folder)}
                              onDelete={(mode) => confirmDeleteFolder(folder, mode)}
                              onDropCourse={(stageId) => handleMoveCourse(stageId, folder.id)}
                            />
                          </motion.div>
                        ))}

                      {/* Courses still being generated, before their course exists. */}
                      {showPendingRuns &&
                        pendingRuns.map((run) => (
                          <motion.div
                            key={run.id}
                            initial={{ opacity: 0, y: 16 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.35, ease: 'easeOut' }}
                          >
                            <ClassroomCard
                              classroom={pendingRunListItem(run)}
                              formatDate={formatDate}
                              runStatus={courseRunStatus(run)}
                              pendingCourse
                              onDelete={handleDelete}
                              onRename={handleRename}
                              confirmingDelete={pendingDeleteId === run.id}
                              onConfirmDelete={() => confirmDelete(run.id)}
                              onCancelDelete={() => setPendingDeleteId(null)}
                              onClick={() => router.push(courseRunHref(run))}
                            />
                          </motion.div>
                        ))}

                      {/* Course tiles for the active view. */}
                      {visibleClassrooms.map((classroom, i) => (
                        <motion.div
                          key={classroom.id}
                          initial={{ opacity: 0, y: 16 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.04, duration: 0.35, ease: 'easeOut' }}
                        >
                          <ClassroomCard
                            classroom={classroom}
                            slide={thumbnails[classroom.id]}
                            requestThumbnail={requestThumbnail}
                            formatDate={formatDate}
                            runStatus={(() => {
                              const run = runByStageId.get(classroom.id);
                              return run ? courseRunStatus(run) : null;
                            })()}
                            onDelete={handleDelete}
                            onRename={handleRename}
                            confirmingDelete={pendingDeleteId === classroom.id}
                            onConfirmDelete={() => confirmDelete(classroom.id)}
                            onCancelDelete={() => setPendingDeleteId(null)}
                            onClick={() => {
                              const run = runByStageId.get(classroom.id);
                              router.push(run ? courseRunHref(run) : `/classroom/${classroom.id}`);
                            }}
                            moveTarget={{
                              folders,
                              currentFolderId: classroom.folderId,
                              onMove: (folderId) => handleMoveCourse(classroom.id, folderId),
                              onCreateAndMove: handleCreateAndMove(classroom.id),
                            }}
                            overlay={
                              // Search view: show the owning folder as a badge
                              // (top-left; the mode badge holds the bottom-left).
                              isSearching && classroom.folderId ? (
                                <span className="absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-primary/80 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm pointer-events-none">
                                  <Folder className="size-2.5" />
                                  {folderNameById.get(classroom.folderId) ?? ''}
                                </span>
                              ) : undefined
                            }
                          />
                        </motion.div>
                      ))}
                    </motion.div>
                  </AnimatePresence>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Folder dialogs — mounted at the top level so they are reachable even
          while the Recent section is collapsed or the course list is empty. */}
      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={(open) => {
          setNewFolderOpen(open);
          if (!open) setCreateAndMoveTarget(null);
        }}
        folders={folders}
        onCreate={handleCreateFolder}
      />

      {/* Footer — flows with content, at the very end */}
      <div className="mt-auto pt-12 pb-4 text-center text-xs text-fg-tertiary">
        OpenMAIC Open Source Project
      </div>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  // Set by the close paths that take focus with them (the row, the collapse
  // arrow, Escape); a click outside leaves focus where the user put it
  const returnFocusRef = useRef(false);

  const displayName = nickname || t('profile.defaultNickname');

  const close = (returnFocus: boolean) => {
    returnFocusRef.current = returnFocus;
    setOpen(false);
    setEditingName(false);
    setAvatarPickerOpen(false);
  };

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        returnFocusRef.current = false;
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus moves into the panel when it opens (the pill turns inert under it)
  // and back to the pill when it closes, instead of dropping to <body>
  useEffect(() => {
    if (open) {
      avatarButtonRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      pillRef.current?.focus();
    }
  }, [open]);

  // Leaving the name field (Enter, Escape, ✓) unmounts it: keep focus on the
  // name button rather than <body>; a blur to elsewhere keeps its target
  useEffect(() => {
    if (editingName || !open) return;
    const active = document.activeElement;
    if (!active || active === document.body) nameButtonRef.current?.focus();
  }, [editingName, open]);

  // Escape backs out one step: the name edit first, then the panel
  useEscapeLayer(open, () => {
    if (editingName) setEditingName(false);
    else close(true);
  });

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ── kept, hidden and inert, while the
          panel is open so the header row's wrap (and the composer's height)
          does not change under the floating panel */}
      <div className={cn(open && 'invisible')} inert={open}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              ref={pillRef}
              type="button"
              aria-label={t('profile.edit')}
              className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full py-[5px] pl-[5px] pr-3 border border-line bg-background hover:bg-subtle active:scale-[0.97]"
              onClick={() => setOpen(true)}
            >
              <span className="shrink-0 relative">
                <span className="block size-8 rounded-full overflow-hidden ring-[1.5px] ring-line group-hover:ring-accent-line transition-all duration-300">
                  <img src={avatar} alt="" className="size-full object-cover" />
                </span>
                <span className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-background border border-line flex items-center justify-center">
                  <Pencil className="size-[7px] text-icon" strokeWidth={2.5} />
                </span>
              </span>
              <span className="leading-none select-none flex items-center gap-1">
                <span className="text-[13px] font-semibold text-fg">
                  {t('home.greetingWithName', { name: displayName })}
                </span>
                <ChevronDown className="size-3 text-icon-muted group-hover:text-icon transition-colors shrink-0" />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {t('profile.editTooltip')}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl bg-popover/95 backdrop-blur-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06] shadow-[0_1px_8px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_8px_-2px_rgba(0,0,0,0.3)] px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => close(true)}
              >
                {/* Avatar */}
                <button
                  ref={avatarButtonRef}
                  type="button"
                  aria-label={t('profile.chooseAvatar')}
                  aria-expanded={avatarPickerOpen}
                  className="shrink-0 relative cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-accent-line transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-popover border border-line flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-icon-muted transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </button>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-line-strong text-[13px] font-semibold text-fg outline-none placeholder:text-icon-muted"
                      />
                      <button
                        type="button"
                        onClick={commitName}
                        aria-label={t('common.confirm')}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-accent-text hover:bg-accent-soft"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      ref={nameButtonRef}
                      type="button"
                      aria-label={`${t('classroom.rename')}: ${displayName}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex max-w-full items-center gap-1 cursor-pointer"
                    >
                      <span className="truncate text-[13px] font-semibold text-fg-secondary group-hover/name:text-fg transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 shrink-0 text-icon-muted opacity-0 group-hover/name:opacity-100 group-focus-visible/name:opacity-100 transition-opacity" />
                    </button>
                  )}
                </div>

                {/* Collapse arrow (the row's click closes the panel) */}
                <motion.button
                  type="button"
                  aria-label={t('common.close')}
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-icon-muted" />
                </motion.button>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url, i) => (
                          <button
                            key={url}
                            type="button"
                            aria-label={t('profile.avatarOption', { n: i + 1 })}
                            aria-pressed={avatar === url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-subtle cursor-pointer transition-all duration-150',
                              'hover:scale-110 active:scale-95',
                              avatar === url
                                ? 'ring-2 ring-primary ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            'hover:scale-110 active:scale-95',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-primary ring-offset-0 border-accent-line bg-accent-soft'
                              : 'border-line-strong text-icon-muted hover:border-icon-muted',
                          )}
                          role="button"
                          tabIndex={0}
                          aria-label={t('profile.uploadAvatar')}
                          aria-pressed={isCustomAvatar(avatar)}
                          onClick={() => avatarInputRef.current?.click()}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return;
                            e.preventDefault();
                            avatarInputRef.current?.click();
                          }}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-[13px] !leading-relaxed placeholder:!text-[11px] placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Classroom cards ─────────────────────────────────────────────
/** A card for a run whose course does not exist yet. */
function pendingRunListItem(run: RunSnapshot): StageListItem {
  return {
    id: run.id,
    name: pendingCourseName(run),
    sceneCount: run.progress.scenesCompleted,
    createdAt: Date.parse(run.createdAt),
    updatedAt: Date.parse(run.updatedAt),
    interactiveMode: run.input.interactive,
    taskEngineMode: run.input.taskEngine,
  };
}

export default function Page() {
  return <HomePage />;
}
