import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Search,
  Users,
} from "lucide-react";
import { parseProviderArtistUrl } from "../../../server/src/contracts/artists";
import { titleScore } from "../../../server/src/match/normalize";
import {
  api,
  type ArtistProviderId,
  type ProviderArtist,
  type MatchCandidate,
} from "../lib/api";
import { PROVIDER_NAMES } from "../lib/utils";
import { Button, Input, Label, SegmentedTabs, Skeleton, Spinner } from "./ui";
import { Cover } from "../pages/downloader/GalleryCard";

function PageControls({
  page,
  hasNextPage,
  busy,
  onChange,
}: {
  page: number;
  hasNextPage: boolean;
  busy: boolean;
  onChange: (page: number) => void;
}) {
  if (page === 1 && !hasNextPage) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={page === 1 || busy}
        onClick={() => onChange(page - 1)}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Previous
      </Button>
      <span className="text-xs tabular-nums text-muted">Page {page}</span>
      <Button
        size="sm"
        variant="outline"
        disabled={!hasNextPage || busy}
        onClick={() => onChange(page + 1)}
      >
        Next
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

const worksGrid =
  "grid grid-cols-2 items-start gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6";

function LoadingWorks({ covers = false }: { covers?: boolean }) {
  if (covers)
    return (
      <div
        role="status"
        aria-label="Loading artist results"
        className={worksGrid}
      >
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="min-w-0 space-y-2">
            <Skeleton className="aspect-[2/3] w-full rounded-lg" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    );
  return (
    <div
      role="status"
      aria-label="Loading artist results"
      className="space-y-3"
    >
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex gap-3">
          <Skeleton className="h-16 w-11 shrink-0 rounded" />
          <div className="flex-1 space-y-2 py-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderResults({
  provider,
  query,
  active,
  seriesTitle,
  onSelect,
}: {
  provider: ArtistProviderId;
  query: string;
  active: boolean;
  seriesTitle: string;
  onSelect: (candidate: MatchCandidate) => void;
}) {
  const [artistPage, setArtistPage] = React.useState(1);
  const [artist, setArtist] = React.useState<ProviderArtist | null>(null);
  const [worksPage, setWorksPage] = React.useState(1);
  const search = useQuery({
    queryKey: ["provider-artists", provider, query, artistPage],
    queryFn: () => api.providerArtists(provider, query, artistPage),
    enabled: active && !!query,
    staleTime: 5 * 60_000,
  });
  const works = useQuery({
    queryKey: ["artist-works", provider, artist?.artistId, worksPage],
    queryFn: () => api.artistWorks(provider, artist!.artistId, worksPage),
    enabled: active && !!artist,
    staleTime: 5 * 60_000,
  });
  const autoSelected = React.useRef(false);
  React.useEffect(() => {
    if (
      !autoSelected.current &&
      search.data?.items.length === 1 &&
      artistPage === 1
    ) {
      autoSelected.current = true;
      setArtist(search.data.items[0]);
    }
  }, [search.data, artistPage]);
  const chooseArtist = (item: ProviderArtist) => {
    setArtist(item);
    setWorksPage(1);
  };
  const problem = artist ? works : search;
  if (!query)
    return (
      <p className="py-5 text-sm text-muted">
        Enter an artist name, or paste an AniList staff, MangaDex author, or
        MyAnimeList people URL.
      </p>
    );
  if (problem.isError)
    return (
      <div role="alert" className="space-y-3 py-3">
        <p className="text-sm font-medium">
          Could not load{" "}
          {artist
            ? "this artist’s works"
            : `${PROVIDER_NAMES[provider]} artists`}
        </p>
        <p className="break-words text-sm text-muted">
          {problem.error.message}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void problem.refetch()}
            disabled={problem.isFetching}
          >
            {problem.isFetching && <Spinner />}Retry
          </Button>
          {artist && (
            <Button size="sm" variant="ghost" onClick={() => setArtist(null)}>
              Choose another artist
            </Button>
          )}
        </div>
      </div>
    );
  if (artist)
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border pb-3">
          <div className="min-w-0">
            <h3 className="break-words text-sm font-semibold">
              Works by {artist.name}
            </h3>
            <a
              href={artist.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-9 items-center gap-1.5 text-xs text-primary underline-offset-4 hover:underline"
            >
              View artist on {PROVIDER_NAMES[provider]}
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setArtist(null)}>
            Change artist
          </Button>
        </div>
        {works.isPending ? (
          <LoadingWorks covers />
        ) : !works.data?.items.length ? (
          <p className="py-5 text-sm text-muted">
            No manga or light novels were returned for this artist. You can also
            check their provider page.
          </p>
        ) : (
          <ul aria-label="Artist works" className={`${worksGrid} p-1`}>
            {works.data.items.map((item) => (
              <li key={item.providerSeriesId} className="min-w-0">
                <button
                  type="button"
                  aria-label={`Review metadata for ${item.title}`}
                  title={item.title}
                  data-candidate-key={`${provider}:${item.providerSeriesId}`}
                  onClick={() =>
                    onSelect({
                      ...item,
                      score: Math.max(
                        ...[item.title, ...(item.altTitles ?? [])].map(
                          (title) => titleScore(seriesTitle, title)
                        )
                      ),
                    })
                  }
                  className="group flex w-full min-w-0 flex-col gap-2 rounded-lg text-left"
                >
                  <Cover
                    url={item.coverUrl}
                    title={item.title}
                    className="aspect-[2/3] w-full rounded-lg bg-surface-2 object-contain"
                  />
                  <span className="block w-full min-w-0">
                    <span className="line-clamp-2 min-h-10 break-words text-sm font-medium leading-5 group-hover:text-primary group-focus-visible:text-primary">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      {[
                        item.type === "NOVEL" ? "Light novel" : "Manga",
                        item.year,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <PageControls
          page={worksPage}
          hasNextPage={works.data?.hasNextPage ?? false}
          busy={works.isFetching}
          onChange={setWorksPage}
        />
      </div>
    );
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Choose the artist whose works you want to browse on{" "}
        {PROVIDER_NAMES[provider]}.
      </p>
      {search.isPending ? (
        <LoadingWorks />
      ) : !search.data?.items.length ? (
        <p className="py-5 text-sm text-muted">
          No artists found. Try a different spelling, reverse the name order, or
          paste the artist’s provider URL.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {search.data.items.map((item) => (
            <li key={item.artistId}>
              <button
                type="button"
                onClick={() => chooseArtist(item)}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-3 text-left hover:bg-surface-2"
              >
                <Users
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-muted"
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium">
                    {item.name}
                  </span>
                  {item.aliases.length > 0 && (
                    <span className="mt-1 block break-words text-xs text-muted">
                      {item.aliases.join(" · ")}
                    </span>
                  )}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <PageControls
        page={artistPage}
        hasNextPage={search.data?.hasNextPage ?? false}
        busy={search.isFetching}
        onChange={setArtistPage}
      />
    </div>
  );
}

export function ArtistWorksBrowser({
  artists,
  seriesTitle,
  active,
  onSelect,
}: {
  artists: string[];
  seriesTitle: string;
  active: boolean;
  onSelect: (candidate: MatchCandidate) => void;
}) {
  const [draft, setDraft] = React.useState(artists[0] ?? "");
  const [query, setQuery] = React.useState(artists[0] ?? "");
  const [provider, setProvider] = React.useState<ArtistProviderId>("anilist");
  const panelId = React.useId(),
    inputId = React.useId();
  React.useEffect(() => {
    if (!draft && !query && artists[0]) {
      setDraft(artists[0]);
      setQuery(artists[0]);
    }
  }, [artists, draft, query]);
  return (
    <section aria-label="Browse artist works" className="space-y-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = draft.trim();
          if (!value) return;
          const reference = parseProviderArtistUrl(value);
          if (reference) setProvider(reference.providerId);
          setQuery(value);
        }}
        className="space-y-2"
      >
        <Label htmlFor={inputId}>Artist name or provider artist URL</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Artist name or provider artist URL"
            autoComplete="off"
            maxLength={500}
          />
          <Button
            type="submit"
            variant="outline"
            className="shrink-0"
            disabled={!draft.trim()}
          >
            <Search className="h-4 w-4" />
            Find artist
          </Button>
        </div>
        {artists.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Saved artists</span>
            {artists.map((name) => (
              <Button
                key={name}
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(name);
                  setQuery(name);
                }}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
      </form>
      <SegmentedTabs
        items={[
          { id: "anilist", label: "AniList" },
          { id: "mangadex", label: "MangaDex" },
          { id: "myanimelist", label: "MyAnimeList" },
        ]}
        value={provider}
        onChange={setProvider}
        label="Artist providers"
        panelId={panelId}
      />
      {provider === "myanimelist" && (
        <p className="text-xs text-muted">
          Browse MyAnimeList artist pages. Metadata review requires a
          MyAnimeList Client ID in Settings.
        </p>
      )}
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-tab-${provider}`}
      >
        {(["anilist", "mangadex", "myanimelist"] as const).map((id) => (
          <div key={id} hidden={id !== provider}>
            <ProviderResults
              key={`${id}:${query}`}
              provider={id}
              query={query}
              active={active && provider === id}
              seriesTitle={seriesTitle}
              onSelect={onSelect}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
