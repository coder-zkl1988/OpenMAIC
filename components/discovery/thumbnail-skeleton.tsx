import { cn } from '@/lib/utils';

/**
 * Placeholder for a course thumbnail that has not loaded yet: the outline of
 * a slide (a title bar, a few text lines and an image block) pulsing inside
 * the card's 16:9 box. A flat pulse over the box's own background was too
 * faint to read as loading, so a card waiting for its thumbnail looked like
 * an empty grey tile.
 *
 * `static` draws the same outline without the pulse: the tile of a course
 * that is still being generated, which has no thumbnail to wait for yet.
 */
export function ThumbnailSkeleton({ static: isStatic = false }: { static?: boolean }) {
  return (
    <div
      aria-hidden
      data-thumbnail-state={isStatic ? 'pending' : 'loading'}
      className={cn('absolute inset-0 flex flex-col gap-[6%] p-[7%]', !isStatic && 'animate-pulse')}
    >
      <div className="h-[11%] w-1/2 rounded-md bg-line" />
      <div className="flex flex-1 gap-[5%]">
        <div className="flex flex-1 flex-col gap-[10%] pt-[2%]">
          <div className="h-[11%] w-full rounded bg-line" />
          <div className="h-[11%] w-5/6 rounded bg-line" />
          <div className="h-[11%] w-2/3 rounded bg-line" />
        </div>
        <div className="w-[38%] rounded-lg bg-line" />
      </div>
    </div>
  );
}
