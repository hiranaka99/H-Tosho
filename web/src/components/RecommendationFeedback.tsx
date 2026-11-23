import { useState } from 'react';
import { Trigger as DialogTrigger } from '@radix-ui/react-dialog';
import { MessageSquare, RotateCcw, ThumbsDown, ThumbsUp, VolumeX } from 'lucide-react';
import type { DoujinSearchResult, FeedbackRequest, RecommendationFeedback } from '../lib/api';
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle } from './ui';

const artistKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
const tagKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/^(?:female|male|tag):/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ');
const BOILERPLATE_UI_TAGS = new Set([
  'sole female', 'sole male', 'mosaic censorship', 'full censorship',
  'uncensored', 'decensored', 'censored', 'translated', 'rewrite',
  'digital', 'multi-work series', 'story arc', 'anthology', 'tankoubon',
  'incomplete', 'english', 'japanese', 'chinese', 'korean', 'raw',
  'text cleaned', 'oneshot', 'one-shot', 'original',
]);
export function GalleryFeedbackDialog({ item, feedback, pending, onClose, onAction, onDismiss }: {
  item: DoujinSearchResult; feedback?: RecommendationFeedback; pending: boolean;
  onClose: () => void; onAction: (request: FeedbackRequest) => void;
  onDismiss?: () => void;
}) {
  const liked = feedback?.liked.some(g => g.source === item.source && g.galleryId === item.galleryId);
  const target = { source: item.source, galleryId: item.galleryId };
  const mutedTags = feedback?.mutedTags ?? [];
  const visibleTags = [...new Set(item.tags)].filter(t => !BOILERPLATE_UI_TAGS.has(tagKey(t))).slice(0, 12);
  const fallbackTags = visibleTags.length ? visibleTags : [...new Set(item.tags)].slice(0, 8);
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-w-md" onEscapeKeyDown={e => { if (pending) e.preventDefault(); }} onPointerDownOutside={e => { if (pending) e.preventDefault(); }}>
      <div className="max-h-[calc(100dvh-2rem)] space-y-4 overflow-y-auto p-4 pr-12 sm:p-5 sm:pr-12">
        <div><DialogTitle>Tune recommendations</DialogTitle><DialogDescription className="mt-1 break-words">{item.title}</DialogDescription></div>
        <Button variant={liked ? 'secondary' : 'outline'} className="w-full justify-start" disabled={pending || !feedback} onClick={() => onAction({ ...target, action: liked ? 'unlike' : 'like' })}><ThumbsUp className="h-4 w-4" />{liked ? 'Undo more like this' : 'More like this'}</Button>
        {onDismiss && <Button variant="outline" className="w-full justify-start" disabled={pending} onClick={onDismiss}><ThumbsDown className="h-4 w-4 shrink-0" /><span className="whitespace-normal text-left">Don’t recommend this gallery</span></Button>}
        {item.artists.length > 0 && <div className="space-y-2"><p className="text-xs font-medium text-muted">Hide all recommendations by an artist</p>{[...new Set(item.artists)].map(artist => {
          const muted = feedback?.mutedArtists.some(a => artistKey(a) === artistKey(artist));
          return <Button variant="outline" key={artist} className="w-full justify-start" disabled={pending || !feedback} onClick={() => onAction({ ...target, artist, action: muted ? 'unmute-artist' : 'mute-artist' })}><VolumeX className="h-4 w-4 shrink-0" /><span className="truncate">{muted ? 'Unmute' : 'Mute'} {artist}</span></Button>;
        })}</div>}
        {fallbackTags.length > 0 && <div className="space-y-2"><p className="text-xs font-medium text-muted">Hide recommendations with a tag</p><div className="flex flex-wrap gap-1.5">{fallbackTags.map(tag => {
          const muted = mutedTags.some(t => tagKey(t) === tagKey(tag));
          return <Button variant={muted ? 'secondary' : 'outline'} size="sm" key={tag} className="max-w-full" disabled={pending || !feedback} onClick={() => onAction({ ...target, tag, action: muted ? 'unmute-tag' : 'mute-tag' })}><VolumeX className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{muted ? `Unmute ${tag}` : tag}</span></Button>;
        })}</div></div>}
      </div>
    </DialogContent>
  </Dialog>;
}

export function RecommendationFeedbackManager({ feedback, pending, onAction }: { feedback?: RecommendationFeedback; pending: boolean; onAction: (request: FeedbackRequest) => void }) {
  const [open, setOpen] = useState(false);
  if (!feedback) return null;
  const mutedTags = feedback.mutedTags ?? [];
  const count = feedback.liked.length + feedback.mutedArtists.length + mutedTags.length;
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <Button size="sm" variant="outline" className="min-h-9 max-lg:min-h-11 pointer-coarse:min-h-11" aria-label={`Recommendation feedback${count ? `, ${count} saved preferences` : ''}`} title="Manage recommendation feedback">
        <MessageSquare className="h-3.5 w-3.5 shrink-0" /> Feedback {count > 0 && <Badge tone="muted">{count}</Badge>}
      </Button>
    </DialogTrigger>
    <DialogContent className="max-w-lg">
      <div className="max-h-[calc(100dvh-2rem)] space-y-4 overflow-y-auto p-4 sm:p-5">
        <div className="pr-10"><DialogTitle>Recommendation feedback</DialogTitle><DialogDescription className="mt-1">Manage your saved preferences for future picks.</DialogDescription></div>
        {count === 0 && <p className="text-sm text-muted">No saved feedback yet. Use a gallery’s feedback controls to choose more like it, or mute an artist or tag.</p>}
      {feedback.liked.length > 0 && <section><h3 className="mb-1 text-xs font-medium text-muted">More like this</h3>{feedback.liked.map(item => <div className="flex min-w-0 items-center gap-2 py-1" key={`${item.source}:${item.galleryId}`}><p className="min-w-0 flex-1 truncate text-sm" title={item.title}>{item.title}</p><Button size="sm" variant="ghost" disabled={pending} aria-label={`Undo more like ${item.title}`} onClick={() => onAction({ action: 'unlike', source: item.source, galleryId: item.galleryId })}><RotateCcw className="h-3.5 w-3.5" /> Undo</Button></div>)}</section>}
      {feedback.mutedArtists.length > 0 && <section><h3 className="mb-1 text-xs font-medium text-muted">Muted artists</h3>{feedback.mutedArtists.map(artist => <div className="flex min-w-0 items-center gap-2 py-1" key={artist}><p className="min-w-0 flex-1 truncate text-sm" title={artist}>{artist}</p><Button size="sm" variant="ghost" disabled={pending} aria-label={`Unmute ${artist}`} onClick={() => onAction({ action: 'unmute-artist', source: 'hitomi', galleryId: 'artist', artist })}>Unmute</Button></div>)}</section>}
      {mutedTags.length > 0 && <section><h3 className="mb-1 text-xs font-medium text-muted">Muted tags</h3>{mutedTags.map(tag => <div className="flex min-w-0 items-center gap-2 py-1" key={tag}><p className="min-w-0 flex-1 truncate text-sm" title={tag}>{tag}</p><Button size="sm" variant="ghost" disabled={pending} aria-label={`Unmute tag ${tag}`} onClick={() => onAction({ action: 'unmute-tag', source: 'hitomi', galleryId: 'tag', tag })}>Unmute</Button></div>)}</section>}
      </div>
    </DialogContent>
  </Dialog>;
}
