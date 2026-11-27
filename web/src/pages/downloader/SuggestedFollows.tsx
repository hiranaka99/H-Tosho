import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserPlus, X } from "lucide-react";
import { api, type SuggestedFollow } from "../../lib/api";
import { toast } from "../../lib/toast";
import { Button, Spinner } from "../../components/ui";
import { SourceBadge } from "./GalleryCard";

function evidence(item: SuggestedFollow): string {
  const parts = [
    item.downloads
      ? `${item.downloads} ${item.downloads === 1 ? "gallery" : "galleries"} downloaded`
      : "",
    item.liked
      ? `${item.liked} liked ${item.liked === 1 ? "pick" : "picks"}`
      : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Artists the user keeps collecting but does not follow yet. Following creates
 * an ordinary watch (its first check seeds silently); nothing is downloaded.
 */
export function SuggestedFollows() {
  const qc = useQueryClient();
  const suggestions = useQuery({
    queryKey: ["suggested-follows"],
    queryFn: api.suggestedFollows,
    staleTime: 60_000,
  });
  const [pending, setPending] = React.useState(new Set<string>());
  const items = suggestions.data?.items ?? [];
  if (!items.length) return null;

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["suggested-follows"] }),
      qc.invalidateQueries({ queryKey: ["watched-searches"] }),
    ]);
  const run = async (item: SuggestedFollow, action: () => Promise<void>) => {
    setPending((current) => new Set(current).add(item.artist));
    try {
      await action();
    } catch (error) {
      toast({
        tone: "danger",
        title: "Could not update suggestions",
        description: (error as Error).message,
      });
    } finally {
      setPending(
        (current) =>
          new Set([...current].filter((artist) => artist !== item.artist))
      );
    }
  };
  const follow = (item: SuggestedFollow) =>
    run(item, async () => {
      const watch = await api.followSuggestedArtist(item.artist, item.source);
      await refresh();
      toast({
        tone: "success",
        title: `Following ${item.artist}`,
        description:
          "The first check records existing galleries quietly. New uploads land in Inbox.",
        action: {
          label: "Undo",
          onClick: () => {
            void api
              .removeWatchedSearch(watch.id, watch.revision)
              .then(refresh)
              .catch((error: Error) =>
                toast({
                  tone: "danger",
                  title: "Could not undo",
                  description: error.message,
                })
              );
          },
        },
      });
    });
  const dismiss = (item: SuggestedFollow) =>
    run(item, async () => {
      await api.dismissSuggestedFollow(item.artist, true);
      await refresh();
      toast({
        tone: "info",
        title: "Suggestion hidden",
        description: `${item.artist} won’t be suggested again.`,
        action: {
          label: "Undo",
          onClick: () => {
            void api
              .dismissSuggestedFollow(item.artist, false)
              .then(refresh)
              .catch((error: Error) =>
                toast({
                  tone: "danger",
                  title: "Could not undo",
                  description: error.message,
                })
              );
          },
        },
      });
    });

  return (
    <section
      aria-labelledby="suggested-follows"
      className="min-w-0 rounded-xl border border-border bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="suggested-follows"
            className="flex items-center gap-2 text-base font-semibold tracking-tight"
          >
            <UserPlus aria-hidden="true" className="h-4 w-4 text-primary" />
            Suggested follows
          </h2>
          <p className="mt-1 text-pretty text-sm text-muted">
            Artists you keep downloading but don’t follow yet.
          </p>
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border md:grid md:grid-cols-2 md:gap-x-6 md:divide-y-0 xl:grid-cols-3">
        {items.map((item) => {
          const busy = pending.has(item.artist);
          return (
            <li
              key={item.artist}
              className="flex min-w-0 items-start gap-3 py-3 md:border-b md:border-border"
            >
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="break-words text-sm font-medium">
                    {item.artist}
                  </span>
                  <SourceBadge source={item.source} />
                </p>
                <p className="mt-0.5 text-xs text-muted">{evidence(item)}</p>
                {item.titles[0] && (
                  <p
                    className="mt-0.5 truncate text-xs text-muted"
                    title={item.titles.join("\n")}
                  >
                    e.g. {item.titles[0]}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void follow(item)}
                  aria-label={`Follow ${item.artist}`}
                  title={`Watch ${item.query}`}
                >
                  {busy ? (
                    <Spinner />
                  ) : (
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  Follow
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void dismiss(item)}
                  aria-label={`Don’t suggest ${item.artist}`}
                  title="Don’t suggest this artist"
                  className="max-lg:min-h-11 max-lg:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-muted"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
