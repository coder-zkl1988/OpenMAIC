'use client';

import { useState, type ReactNode } from 'react';
import {
  Archive,
  Download,
  FileCode,
  FileDown,
  Film,
  Loader2,
  Monitor,
  Moon,
  NotebookText,
  Package,
  Settings,
  Sun,
} from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useTheme } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useExportPPTX } from '@/lib/export/use-export-pptx';
import { useExportClassroom } from '@/lib/export/use-export-classroom';
import { classroomHasPlaybackMedia, useExportHtml } from '@/lib/export/use-export-html';
import { isScriptExportReady, useExportScript } from '@/lib/export/use-export-script';
import { isVideoExportEnabled } from '@/lib/config/feature-flags';
import { useVideoRenderStore } from '@/lib/store/video-render';
import { CircularProgress } from '@/components/ui/circular-progress';
import { VideoExportDialog } from './video-export-dialog';
import { LanguageSwitcher } from '../language-switcher';
import { SettingsDialog } from '../settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { StageMode } from '@/lib/types/stage';

interface ExportMenuItemProps {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly className?: string;
}

function ExportMenuItem({
  icon,
  label,
  description,
  onSelect,
  disabled,
  title,
  className,
}: ExportMenuItemProps) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      className={cn('cursor-pointer gap-2.5', className)}
      title={title}
    >
      {icon}
      {description ? (
        <div>
          <div>{label}</div>
          <div className="text-[11px] text-gray-400 dark:text-gray-500">{description}</div>
        </div>
      ) : (
        <span>{label}</span>
      )}
    </DropdownMenuItem>
  );
}

interface HeaderControlsProps {
  readonly mode?: StageMode;
  readonly proModeActive?: boolean;
  readonly canEdit?: boolean;
  readonly onToggleEditMode?: () => void;
  readonly showGlobalControls?: boolean;
  readonly showCourseActions?: boolean;
}

/** 26px icon button inside the 32px settings pill (Classroom.dc.html). */
const PILL_ICON_BUTTON =
  'size-[26px] flex items-center justify-center rounded-full text-icon hover:bg-white dark:hover:bg-gray-700 hover:text-fg hover:shadow-sm transition-all group';

/**
 * The 32×18 Pro switch: a 1px transparent border plus 1px padding around the
 * 16px thumb, so the thumb travels 12px (shadcn's default thumb travel is
 * 16px for its 36px track). The unchecked track is the line-strong stroke.
 */
const PRO_SWITCH_CLASS =
  'h-[18px] w-8 border px-px shadow-none data-[state=unchecked]:bg-line-strong [&[data-state=checked]>span]:translate-x-3 [&>span]:shadow-sm';

/**
 * Stage-level global controls: language picker, theme picker, settings
 * modal trigger, and the Pro Switch. Extracted out of `Header` so the
 * Pro mode CommandBar can absorb the same affordances and the playback
 * Header doesn't need to stay mounted just to host them — Pro mode
 * therefore lands on a single top-chrome bar instead of stacking the
 * Stage Header above the EditShell CommandBar.
 *
 * Only one instance is ever mounted at a time (Stage renders Header
 * for playback and EditShell.CommandBar's trailing slot for edit, but
 * never both), so dropdown / dialog state and refs stay co-located
 * here without cross-instance leakage.
 */
export function HeaderControls({
  mode,
  proModeActive,
  canEdit,
  onToggleEditMode,
  showGlobalControls = true,
  showCourseActions = true,
}: HeaderControlsProps) {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);

  // Export plumbing — uses the stage / media task stores to check
  // readiness, then hands off to the export hooks. Available in both
  // playback and edit chrome so the icon's screen position is stable
  // across mode swaps (was previously in `Header` only, missing from
  // CommandBar's right cluster).
  const scenes = useStageStore((s) => s.scenes);
  const generatingOutlines = useStageStore((s) => s.generatingOutlines);
  const failedOutlines = useStageStore((s) => s.failedOutlines);
  const mediaTasks = useMediaGenerationStore((s) => s.tasks);
  const { exporting: isExporting, exportPPTX, exportResourcePack } = useExportPPTX();
  const { exporting: isExportingZip, exportClassroomZip } = useExportClassroom();
  const { exporting: isExportingHtml, exportStandaloneHtml } = useExportHtml();
  const { exporting: isExportingScript, exportScriptDocx, exportScriptMd } = useExportScript();
  const videoExportEnabled = isVideoExportEnabled();
  // Video render lives in a global store so its progress ring stays on the
  // export button even after the menu closes / scenes switch mid-render.
  const videoRendering = useVideoRenderStore(
    (s) => s.status === 'compiling' || s.status === 'rendering',
  );
  const videoRenderPercent = useVideoRenderStore((s) => s.percent);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // Keep the original full-generation gate for the export menu. Script files
  // are text-only, but the latest review confirmed that this menu intentionally
  // stays unavailable until all media tasks have completed or failed.
  const canExport = isScriptExportReady({ scenes, generatingOutlines, failedOutlines }, mediaTasks);
  const anyExporting = isExporting || isExportingZip || isExportingHtml || isExportingScript;
  const exportLabel = canExport ? t('export.pptx') : t('share.notReady');
  // Only read while the menu is open: the scan walks every scene's actions.
  const htmlHasPlaybackMedia = exportMenuOpen && classroomHasPlaybackMedia(scenes);

  const proChecked = proModeActive ?? mode === 'edit';

  if (!showGlobalControls && !showCourseActions) {
    return onToggleEditMode ? (
      <div className="flex items-center gap-2.5">
        <span className="text-xs font-semibold text-fg-secondary select-none">
          {t('edit.proMode')}
        </span>
        <Switch
          checked={proChecked}
          onCheckedChange={onToggleEditMode}
          disabled={!canEdit}
          aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
          className={PRO_SWITCH_CLASS}
        />
      </div>
    ) : null;
  }

  // Self-contained spacing so the control cluster is identical regardless of
  // host. The playback Header (`gap-4`) and the edit CommandBar's trailing
  // slot (`gap-2`) would otherwise impose different inter-control spacing on
  // these fragment children, making the pill/switch/export cluster visibly
  // shift width and position across the mode swap. A fixed internal gap keeps
  // the cluster pixel-stable; both hosts are 56px tall (`h-14`) with a 20px
  // right padding (Header `pr-5`, CommandBar `px-5`), so the right edge and
  // the vertical centre anchor identically too.
  return (
    <div className="flex items-center gap-2.5">
      <div className="shrink-0 flex items-center gap-0.5 h-8 px-1 rounded-full border border-line bg-white/70 dark:bg-gray-800/60">
        {/* Language — Radix DropdownMenu so its menu portals to body
            and never gets clipped by an ancestor's overflow-hidden. */}
        <LanguageSwitcher size="sm" />

        {/* Theme — same Portal-backed DropdownMenu pattern. Non-modal keeps
            Radix from body scroll-locking a fixed-height classroom layout. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button type="button" className={PILL_ICON_BUTTON} aria-label={t('settings.theme')}>
              {theme === 'light' && <Sun className="w-4 h-4" />}
              {theme === 'dark' && <Moon className="w-4 h-4" />}
              {theme === 'system' && <Monitor className="w-4 h-4" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="min-w-[140px]">
            <DropdownMenuItem
              onSelect={() => setTheme('light')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'light' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Sun className="w-4 h-4" />
              {t('settings.themeOptions.light')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('dark')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'dark' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Moon className="w-4 h-4" />
              {t('settings.themeOptions.dark')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setTheme('system')}
              className={cn(
                'cursor-pointer gap-2',
                theme === 'system' &&
                  'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400',
              )}
            >
              <Monitor className="w-4 h-4" />
              {t('settings.themeOptions.system')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Settings */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={PILL_ICON_BUTTON}
          aria-label={t('settings.title')}
        >
          <Settings className="w-4 h-4 group-hover:rotate-90 transition-transform duration-500" />
        </button>
      </div>

      {/* Pro Switch — toggle property: on/off both clickable, not a
          one-way "Done" button. Disabled only when the current scene
          can't be entered (pending/generating/etc.). Fades in with its
          host bar on the mode swap (no cross-bar layoutId morph: the
          playback Header and edit CommandBar have different left-side
          widths, so morphing made the pill visibly drift). */}
      {onToggleEditMode && (
        <label
          className={cn(
            'shrink-0 inline-flex items-center gap-2.5 h-8 pl-3 pr-2.5 rounded-full border transition-colors duration-200',
            'bg-white/70 dark:bg-gray-800/60',
            proChecked ? 'border-accent-line' : 'border-line',
            !canEdit && mode !== 'edit'
              ? 'opacity-60 cursor-not-allowed'
              : 'cursor-pointer hover:border-accent-line',
          )}
          // When disabled (e.g. the course-complete placeholder), explain why
          // on hover and point the user to a real scene instead of a bare
          // "Edit course" label they can't act on.
          title={
            !canEdit && mode !== 'edit'
              ? t('stage.proModeDisabledHint')
              : proChecked
                ? t('stage.doneEditing')
                : t('stage.editCourse')
          }
        >
          <span
            className={cn(
              'text-xs font-semibold select-none transition-colors duration-200',
              proChecked ? 'text-accent-text' : 'text-fg-secondary',
            )}
          >
            {t('edit.proMode')}
          </span>
          <Switch
            checked={proChecked}
            onCheckedChange={onToggleEditMode}
            disabled={!canEdit && mode !== 'edit'}
            aria-label={proChecked ? t('stage.doneEditing') : t('stage.editCourse')}
            className={PRO_SWITCH_CLASS}
          />
        </label>
      )}

      {/* Export / Download — lives to the right of the Pro Switch.
          Not a settings function so it does not belong inside the
          settings pill; kept as a separate sibling sitting between the
          Pro Switch and the right edge of the chrome. */}
      <DropdownMenu modal={false} open={exportMenuOpen} onOpenChange={setExportMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            disabled={!canExport || anyExporting}
            title={anyExporting ? t('export.exporting') : exportLabel}
            className={cn(
              'shrink-0 size-8 flex items-center justify-center rounded-full transition-all',
              canExport && !anyExporting
                ? 'text-icon hover:bg-white dark:hover:bg-gray-700 hover:text-fg hover:shadow-sm'
                : 'text-icon-muted cursor-not-allowed opacity-50',
            )}
            aria-label={exportLabel}
          >
            {anyExporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : videoRendering ? (
              // Persistent ring: video render runs in the background; keep it
              // visible on the button whether or not the menu is open.
              <CircularProgress value={videoRenderPercent} size={20} className="text-primary" />
            ) : (
              <Download className="w-4 h-4" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="min-w-[240px]">
          {/* PPTX and Resource Pack: choose per export whether quiz,
              interactive and PBL scenes get placeholder slides. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <FileDown className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <span>{t('export.pptx')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              <ExportMenuItem
                disabled={!canExport}
                onSelect={() => exportPPTX({ includePlaceholders: true })}
                icon={<FileDown className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
                label={t('export.withPlaceholders')}
                description={t('export.withPlaceholdersDesc')}
              />
              <ExportMenuItem
                disabled={!canExport}
                onSelect={() => exportPPTX({ includePlaceholders: false })}
                icon={<FileDown className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
                label={t('export.slidesOnly')}
                description={t('export.slidesOnlyDesc')}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <Package className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <div>
                <div>{t('export.resourcePack')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('export.resourcePackDesc')}
                </div>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              <ExportMenuItem
                disabled={!canExport}
                onSelect={() => exportResourcePack({ includePlaceholders: true })}
                icon={<Package className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
                label={t('export.packWithPlaceholders')}
                description={t('export.withPlaceholdersDesc')}
              />
              <ExportMenuItem
                disabled={!canExport}
                onSelect={() => exportResourcePack({ includePlaceholders: false })}
                icon={<Package className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
                label={t('export.packSlidesOnly')}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <ExportMenuItem
            disabled={!canExport || isExportingZip}
            onSelect={exportClassroomZip}
            title={canExport ? undefined : t('export.mediaPending')}
            icon={<Archive className="w-4 h-4 text-gray-400 shrink-0" />}
            label={t('export.classroomZip')}
            description={t('export.classroomZipDesc')}
          />
          {/* Standalone HTML: choose per export whether narration audio and
              video clips are embedded. The option that fits the classroom
              comes first: with narration and video when the classroom has narration
              audio or slide video. */}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <FileCode className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <div>
                <div>{t('export.html')}</div>
                <div className="text-[11px] text-gray-400 dark:text-gray-500">
                  {t('export.htmlDesc')}
                </div>
              </div>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              {(htmlHasPlaybackMedia
                ? (['narration', 'silent'] as const)
                : (['silent', 'narration'] as const)
              ).map((variant) => (
                <ExportMenuItem
                  key={variant}
                  disabled={!canExport || isExportingHtml}
                  onSelect={() =>
                    exportStandaloneHtml({ includeNarration: variant === 'narration' })
                  }
                  icon={<FileCode className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />}
                  label={t(
                    variant === 'narration' ? 'export.htmlWithNarration' : 'export.htmlSilent',
                  )}
                  description={t(
                    variant === 'narration'
                      ? 'export.htmlWithNarrationDesc'
                      : 'export.htmlSilentDesc',
                  )}
                />
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!canExport}
              title={canExport ? undefined : t('export.mediaPending')}
              className="cursor-pointer gap-2.5"
            >
              <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
              <span>{t('export.script')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[240px]">
              <ExportMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptMd}
                icon={
                  <NotebookText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
                }
                label={t('export.scriptMd')}
                description={t('export.scriptMdDesc')}
              />
              <ExportMenuItem
                disabled={!canExport || isExportingScript}
                onSelect={exportScriptDocx}
                icon={
                  <NotebookText
                    className="w-4 h-4 text-gray-400 dark:text-gray-500"
                    aria-hidden="true"
                  />
                }
                label={t('export.scriptDocx')}
                description={t('export.scriptDocxDesc')}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {videoExportEnabled && (
            <ExportMenuItem
              disabled={!canExport}
              onSelect={() => setVideoDialogOpen(true)}
              className="border-t border-gray-200 dark:border-gray-700"
              title={canExport ? undefined : t('export.mediaPending')}
              icon={<Film className="w-4 h-4 text-gray-400 shrink-0" />}
              label={t('export.video')}
              description={t('export.videoDesc')}
            />
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      {videoExportEnabled && (
        <VideoExportDialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen} />
      )}
    </div>
  );
}
