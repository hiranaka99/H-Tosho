import * as React from "react";
import { api, type DuplicateCheck, type DoujinSource } from "../lib/api";

const DuplicateReviewDialog = React.lazy(() =>
  import("./DuplicateReviewDialog").then((m) => ({
    default: m.DuplicateReviewDialog,
  }))
);

export function useDuplicateReview() {
  const [review, setReview] = React.useState<DuplicateCheck | null>(null);
  const resolveRef = React.useRef<((keys: Set<string> | null) => void) | null>(
    null
  );
  const finish = React.useCallback(
    (approve: boolean) => {
      const keys = approve
        ? new Set(
            review?.reports
              .filter((report) => report.matches.length)
              .map((report) => `${report.source}:${report.galleryId}`)
          )
        : null;
      resolveRef.current?.(keys);
      resolveRef.current = null;
      setReview(null);
    },
    [review]
  );
  React.useEffect(
    () => () => {
      resolveRef.current?.(null);
    },
    []
  );
  const reviewCheck = React.useCallback(
    (check: DuplicateCheck): Promise<Set<string> | null> => {
      if (!check.reports.some((report) => report.matches.length))
        return Promise.resolve(new Set());
      // A new request never leaves an older confirmation waiting indefinitely.
      resolveRef.current?.(null);
      setReview(check);
      return new Promise((resolve) => {
        resolveRef.current = resolve;
      });
    },
    []
  );
  const checkDuplicates = React.useCallback(
    async (
      items: { source: DoujinSource; galleryId: string; url?: string }[]
    ) => {
      if (!items.length) return new Set<string>();
      return reviewCheck(
        await api.checkDuplicates(
          items.map(({ source, galleryId, url }) => ({
            source,
            galleryId,
            ...(url ? { url } : {}),
          }))
        )
      );
    },
    [reviewCheck]
  );
  // Only earlier editions matched: this is an upgrade, not a duplicate.
  const upgrade =
    !!review &&
    review.reports
      .filter((report) => report.matches.length)
      .every((report) => report.matches.every((match) => match.betterEdition));
  const dialog = review && (
    <React.Suspense fallback={null}>
      <DuplicateReviewDialog
        review={review}
        upgrade={upgrade}
        onDecision={finish}
      />
    </React.Suspense>
  );
  return { checkDuplicates, reviewCheck, dialog };
}
