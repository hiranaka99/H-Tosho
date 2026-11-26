export interface IdentifyGatingInput {
  browseArtists: boolean;
  selected: boolean;
  hasInitialCandidate: boolean;
  autoReview: boolean;
  hasMatch: boolean;
  currentError: boolean;
  autoReviewDone: boolean;
}

/**
 * Gate `GET /api/series/:id/identify` so modal entry points that immediately
 * review an existing match or supplied candidate don't fire a wasted candidate
 * search before the user explicitly asks to see all matches.
 */
export function shouldEnableIdentify(input: IdentifyGatingInput): boolean {
  if (input.browseArtists) return false;
  if (input.hasInitialCandidate && input.selected) return false;
  if (input.autoReview) {
    if (input.autoReviewDone && input.selected) return false;
    if (!input.autoReviewDone && input.hasMatch && !input.currentError) return false;
  }
  return true;
}
