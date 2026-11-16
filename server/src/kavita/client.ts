import { fetchBuffer, fetchJson, fetchJsonRetry } from '../lib/http.js';
import {
  KAVITA_MIN_SERVER_VERSION,
  KavitaLibraryType,
  type KavitaChapterDto,
  type KavitaLibrary,
  type KavitaLibraryDto,
  type KavitaPersonDto,
  type KavitaSeries,
  type KavitaSeriesDto,
  type KavitaVolume,
  type KavitaVolumeDto,
  type KavitaSeriesMetadataDto,
  type KavitaServerInfo,
  type KavitaServerInfoDto,
  type KavitaTagDto,
  type KavitaUpdateSeriesDto,
  type KavitaUpdateSeriesMetadataDto,
  type KavitaUploadCoverFileDto,
  type KavitaUserDto,
  type MediaFormat,
  type SeriesMetadataPayload,
} from './types.js';
import type { MetadataSnapshot, RecordedValue } from '../contracts/metadataHistory.js';
import {
  getMetadataRestoreFieldAvailability,
  isRestorableMetadataField,
  metadataValueKey,
  titleRestoreCapability,
  RESTORE_FIELD_MAPPINGS,
  type ExactMetadataRestoreOptions,
  type ExactMetadataRestoreValues,
  type RestorableMetadataField,
} from '../contracts/metadataRestore.js';

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = (actual.match(/\d+/g) ?? []).map(Number);
  const minimumParts = (minimum.match(/\d+/g) ?? []).map(Number);
  const length = Math.max(actualParts.length, minimumParts.length);
  for (let index = 0; index < length; index++) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

const LIBRARY_MEDIA_FORMATS: Record<KavitaLibraryType, MediaFormat> = {
  [KavitaLibraryType.Manga]: 'manga',
  [KavitaLibraryType.Comic]: 'comic',
  [KavitaLibraryType.Book]: 'book',
  [KavitaLibraryType.Image]: 'image',
  [KavitaLibraryType.LightNovel]: 'book',
  [KavitaLibraryType.ComicVine]: 'comic',
};

/**
 * Positive person lookups shared across clients (clients are constructed per
 * job, so module-level state is what survives between syncs). Keyed by
 * `${baseUrl}|${lowercased name}`; a person's id never changes once created.
 */
const personCache = new Map<string, { id: number; name: string; at: number }>();
const PERSON_CACHE_TTL_MS = 60 * 60_000;
const PERSON_CACHE_MAX_ENTRIES = 5000;
/** Scan task methods reported by /Server/is-task-running?methodName= (ScannerService, as enqueued by TaskScheduler). */
const SCAN_TASK_METHODS = ['ScanLibrary', 'ScanLibraries', 'ScanSeries'] as const;
/** Hangfire queues that can hold scan jobs — 0.9.1 runs scans on a dedicated "scan" queue. */
const SCAN_TASK_QUEUES = ['default', 'scan'] as const;

/**
 * Mirror of Kavita's series-name normalization (0.9.x, StringExtensions.ToNormalized):
 * strip everything except letters, digits and +! (ASCII plus fullwidth), then case-fold.
 * The scanner matches scanned files to existing records by this value
 * (WhereSeriesNameMatches over NormalizedName / Localized / Original) and updates the
 * match in place — it never renames a record. Two titles that normalize identically
 * therefore can never split into separate series entries on a scan.
 */
export function kavitaNormalizeName(name: string): string {
  return name.replace(/[^\p{L}0-9+＊！＋]/gu, '').trim().toLowerCase();
}

export interface UpdateMetadataOptions {
  /** When false, pushed fields are written without setting Kavita's field-lock flags. */
  lockMetadata?: boolean;
  /**
   * Series metadata the caller already read (e.g. for tag merging) — skips
   * this method's own GET /Series/metadata re-read. Still normalized here.
   */
  metadata?: KavitaSeriesMetadataDto;
}

/** Thin typed wrapper over the Kavita v0.9.0.22 REST API. */
export class KavitaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    this.apiKey = apiKey.trim();
  }

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, Accept: 'application/json' };
  }

  private url(path: string): string {
    return `${this.baseUrl}/api${path}`;
  }

  private requestError(action: string, path: string, status: number, data?: unknown): Error {
    const detail =
      typeof data === 'string'
        ? data.trim()
        : data && typeof data === 'object'
          ? JSON.stringify(data)
          : '';
    const hint =
      status === 401 || status === 403
        ? ' Check that the Kavita Auth Key is valid and belongs to an admin user.'
        : status === 404
          ? ' Check that the Base URL points to the Kavita server root (do not include /api).'
          : '';
    // Strip any query string before displaying: image endpoints carry the API
    // key as ?apiKey= and must never leak it into error messages.
    const displayUrl = `${this.baseUrl}/api${path.split('?')[0]}`;
    return new Error(
      `${action} failed at ${displayUrl}: HTTP ${status}${detail ? ` - ${detail}` : ''}.${hint}`,
    );
  }

  private async getJson<T>(path: string, action: string): Promise<T> {
    const res = await fetchJsonRetry<T>(this.url(path), { headers: this.headers }, 15_000, { raw: true });
    if (res.status !== 200) throw this.requestError(action, path, res.status, res.data);
    return res.data;
  }

  private async postJson<T = unknown>(path: string, body: unknown, action: string): Promise<T> {
    const res = await fetchJsonRetry<T>(this.url(path), {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15_000, { raw: true });
    if (res.status < 200 || res.status >= 300) {
      throw this.requestError(action, path, res.status, res.data);
    }
    return res.data;
  }

  private async deleteJson(path: string, action: string): Promise<void> {
    const res = await fetchJsonRetry<unknown>(this.url(path), { method: 'DELETE', headers: this.headers }, 15_000, { raw: true });
    if (res.status < 200 || res.status >= 300) {
      throw this.requestError(action, path, res.status, res.data);
    }
  }

  /** GET /api/Server/server-info-slim */
  async getServerInfo(): Promise<KavitaServerInfo> {
    const path = '/Server/server-info-slim';
    const data = await this.getJson<KavitaServerInfoDto>(path, 'Kavita server info');
    if (!data?.kavitaVersion) {
      throw new Error(`Kavita server info at ${this.url(path)} did not include kavitaVersion.`);
    }
    return {
      version: data.kavitaVersion,
      installId: data.installId ?? undefined,
      isDocker: data.isDocker,
      firstInstallDate: data.firstInstallDate ?? undefined,
      firstInstallVersion: data.firstInstallVersion ?? undefined,
    };
  }

  /** GET /api/Account */
  async getCurrentUser(): Promise<KavitaUserDto> {
    return this.getJson<KavitaUserDto>('/Account', 'Kavita account');
  }

  /** Validate reachability, the Auth Key, and the admin access needed for writes. */
  async testConnection(): Promise<KavitaServerInfo> {
    // Reachability/version and auth/admin checks read independent endpoints —
    // fetch both up front so a slow server pays only one round-trip latency.
    const [info, user] = await Promise.all([this.getServerInfo(), this.getCurrentUser()]);
    if (!isVersionAtLeast(info.version, KAVITA_MIN_SERVER_VERSION)) {
      throw new Error(
        `Kavita ${info.version} is not supported. H-Tosho requires Kavita ${KAVITA_MIN_SERVER_VERSION} or newer.`,
      );
    }
    if (!user.roles?.some((role) => role.toLowerCase() === 'admin')) {
      throw new Error('The Kavita Auth Key is valid, but H-Tosho requires an admin user to update metadata and covers.');
    }
    return info;
  }


  /**
   * GET /api/Server/is-task-running — true while any of Kavita's scan tasks is
   * running or queued. Since 0.9.1 the endpoint requires a `methodName` query
   * parameter and reports one task method at a time (a bare call answers 400),
   * so the answer ORs all three scan methods on both Hangfire queues: processing
   * jobs are visible regardless of queue, enqueued jobs only within their own.
   * The endpoint answers a bare JSON boolean on current builds but has also been
   * observed as a quoted string, so both shapes map to a real boolean. When no
   * scoped call is answered (pre-0.9.1 builds expose the endpoint without the
   * parameter) the legacy bare call is used instead.
   */
  async isTaskRunning(): Promise<boolean> {
    const parse = (data: unknown): boolean => data === true || data === 'true';
    const scoped = await Promise.allSettled(
      SCAN_TASK_METHODS.flatMap((method) =>
        SCAN_TASK_QUEUES.map((queue) =>
          this.getJson<boolean | string>(
            `/Server/is-task-running?methodName=${encodeURIComponent(method)}&queue=${queue}`,
            'Kavita task status',
          ),
        ),
      ),
    );
    const answered = scoped.filter((result): result is PromiseFulfilledResult<boolean | string> => result.status === 'fulfilled');
    if (answered.length > 0) return answered.some((result) => parse(result.value));
    const data = await this.getJson<boolean | string>('/Server/is-task-running', 'Kavita task status');
    return parse(data);
  }

  /** GET /api/Library/libraries */
  async getLibraries(): Promise<KavitaLibrary[]> {
    const libraries = await this.getJson<KavitaLibraryDto[]>('/Library/libraries', 'Get libraries');
    return libraries.map((library) => ({
      id: library.id,
      name: library.name?.trim() || `Library ${library.id}`,
      path: library.folders?.[0] ?? undefined,
      paths: library.folders ?? [],
      monitor: library.folderWatching ?? false,
      mediaFormat: LIBRARY_MEDIA_FORMATS[library.type] ?? 'other',
      lastModified: library.lastScanned,
    }));
  }

  /** POST /api/Series/all-v2, filtered to one library. */
  async getSeries(libraryId: number): Promise<KavitaSeries[]> {
    const path = '/Series/all-v2?PageNumber=1&PageSize=0';
    const series = await this.postJson<KavitaSeriesDto[]>(
      path,
      {
        statements: [{ comparison: 5, field: 19, value: String(libraryId) }],
        combination: 0,
        entityType: 0,
        limitTo: 0,
      },
      'Get series',
    );
    return series.map((item) => this.mapSeries(item));
  }

  private mapSeries(series: KavitaSeriesDto): KavitaSeries {
    return {
      id: series.id,
      libraryId: series.libraryId,
      name: series.name?.trim() || `Series ${series.id}`,
      slug: String(series.id),
      bookCount: 0,
      pages: series.pages ?? undefined,
      totalChapterCount: 0,
      lastAdded: series.lastChapterAddedUtc ?? series.lastChapterAdded,
      created: series.created ?? undefined,
      // The filename is not a public URL; its presence enables our proxy.
      cover: series.coverImage ?? undefined,
      folderPath: series.folderPath ?? undefined,
    };
  }

  /** GET /api/Series/{seriesId} */
  async getSeriesById(seriesId: number): Promise<KavitaSeries> {
    return this.mapSeries(await this.getSeriesDto(seriesId));
  }

  async getSeriesDto(seriesId: number): Promise<KavitaSeriesDto> {
    return this.getJson<KavitaSeriesDto>(`/Series/${seriesId}`, `Get series ${seriesId}`);
  }

  /** GET /api/Series/metadata?seriesId={seriesId} */
  async getSeriesMetadata(seriesId: number): Promise<KavitaSeriesMetadataDto> {
    return this.getJson<KavitaSeriesMetadataDto>(
      `/Series/metadata?seriesId=${encodeURIComponent(seriesId)}`,
      `Get series ${seriesId} metadata`,
    );
  }

  /** GET /api/Search/chapters-by-series?seriesId={seriesId} — every book Kavita has indexed for a series. */
  async getChaptersBySeries(seriesId: number): Promise<KavitaChapterDto[]> {
    return this.getJson<KavitaChapterDto[]>(
      `/Search/chapters-by-series?seriesId=${encodeURIComponent(seriesId)}`,
      `Get chapters for series ${seriesId}`,
    );
  }

  /** GET /api/Person?name={name} — exact-name lookup; null when Kavita has no such person. */
  private async findPerson(name: string): Promise<KavitaPersonDto | null> {
    try {
      const found = await this.getJson<KavitaPersonDto | null>(`/Person?name=${encodeURIComponent(name)}`, `Find person ${name}`);
      if (found?.id && (found.name ?? '').trim().toLowerCase() === name.trim().toLowerCase()) return found;
    } catch {
      /* not found — the caller creates it */
    }
    return null;
  }

  /**
   * Resolve names to Kavita persons. The series metadata endpoint matches people by
   * person id, so existing persons must be referenced by their real id; unknown
   * names are sent with id 0, which makes the metadata write itself create the
   * person (Kavita 0.9.0.x has no standalone creation endpoint — POST
   * /api/Person/update with id 0 answers "Person does not exist"). Kavita does not
   * deduplicate id-0 entries by name, so existing persons must be resolved first
   * or every sync would create a duplicate. Lookups run in parallel and reuse
   * the module-level cache; negative results are never cached, because a
   * not-yet-created person may exist by the next sync.
   */
  private async resolvePeople(names: string[]): Promise<KavitaPersonDto[]> {
    const now = Date.now();
    const resolved = await Promise.all(
      names.map(async (raw) => {
        const name = raw.trim();
        if (!name) return null;
        const key = `${this.baseUrl}|${name.toLowerCase()}`;
        const cached = personCache.get(key);
        if (cached) {
          if (now - cached.at < PERSON_CACHE_TTL_MS) return { id: cached.id, name: cached.name };
          personCache.delete(key);
        }
        const found = await this.findPerson(name);
        if (!found || found.id <= 0) return { id: 0, name };
        if (personCache.size >= PERSON_CACHE_MAX_ENTRIES) {
          // Map iterates in insertion order, so the first key is the oldest entry.
          const oldest = personCache.keys().next().value;
          if (oldest !== undefined) personCache.delete(oldest);
        }
        personCache.set(key, { id: found.id, name: found.name ?? name, at: now });
        return found;
      }),
    );
    return resolved.filter((person): person is KavitaPersonDto => person !== null);
  }

  /** Read, merge, and write using Kavita's split v0.9 update endpoints. */
  async updateSeriesMetadata(seriesId: number, patch: SeriesMetadataPayload, opts: UpdateMetadataOptions = {}): Promise<void> {
    const lock = opts.lockMetadata !== false;
    if (patch.name !== undefined) {
      const current = await this.getSeriesDto(seriesId);
      const update: KavitaUpdateSeriesDto = {
        id: seriesId,
        name: patch.name ?? current.name ?? null,
        localizedName: current.localizedName ?? null,
        sortName: current.sortName ?? null,
        coverImageLocked: current.coverImageLocked ?? false,
        nameLocked: patch.name !== undefined && lock ? true : (current.nameLocked ?? false),
        sortNameLocked: current.sortNameLocked ?? false,
        localizedNameLocked: current.localizedNameLocked ?? false,
        metadataProviderOverride: current.metadataProviderOverride ?? null,
        aniListId: current.aniListId ?? null,
        malId: current.malId ?? null,
        hardcoverId: current.hardcoverId ?? null,
        metronId: current.metronId ?? null,
        comicVineId: current.comicVineId ?? null,
        mangaBakaId: current.mangaBakaId ?? null,
        cbrId: current.cbrId ?? null,
      };
      await this.postJson('/Series/update', update, `Update series ${seriesId}`);
    }

    if (this.hasMetadataPatch(patch)) {
      // Kavita resolves people by person id and silently drops unknown ids, so names
      // must be resolved through the Person endpoints before the write. Person
      // resolution is independent of the metadata read — run both concurrently;
      // a caller-supplied pre-read skips the GET entirely.
      const [read, people] = await Promise.all([
        opts.metadata !== undefined ? Promise.resolve(opts.metadata) : this.getSeriesMetadata(seriesId),
        Promise.all([
          patch.writers !== undefined ? this.resolvePeople(patch.writers) : undefined,
          patch.artists !== undefined ? this.resolvePeople(patch.artists) : undefined,
        ]).then(([writers, artists]) => ({ writers, artists })),
      ]);
      const metadata = this.normalizeMetadata(read, seriesId);
      // Kavita skips a field's value whenever its lock flag is set in the payload, so
      // a previously locked field would never update. Write with the locks cleared…
      this.mergeMetadataPatch(metadata, patch, false, people);
      await this.postJson('/Series/metadata', { seriesMetadata: metadata }, `Update series ${seriesId} metadata`);
      if (lock) {
        // …then re-lock the fields we just wrote so Kavita's own provider fetches
        // don't overwrite them.
        if (patch.summary !== undefined) metadata.summaryLocked = true;
        if (patch.genres !== undefined) metadata.genresLocked = true;
        if (patch.tags !== undefined) metadata.tagsLocked = true;
        if ((people?.writers ?? []).length > 0) metadata.writerLocked = true;
        if ((people?.artists ?? []).length > 0) metadata.pencillerLocked = true;
        if (patch.releaseYear !== undefined) metadata.releaseYearLocked = true;
        if (patch.language !== undefined) metadata.languageLocked = true;
        if (patch.publicationStatus !== undefined) metadata.publicationStatusLocked = true;
        await this.postJson('/Series/metadata', { seriesMetadata: metadata }, `Lock series ${seriesId} metadata`);
      }
    }
  }

  /**
   * Restore only approved scalar/list values, preserving the full current DTO.
   * Kavita has no compare-and-swap: these fresh read/merge/post checks are best
   * effort against other clients, and every write is followed by exact readback.
   */
  async restoreSeriesMetadataExact(seriesId: number, values: ExactMetadataRestoreValues, options: ExactMetadataRestoreOptions): Promise<void> {
    for (const field of Object.keys(values)) {
      const availability = getMetadataRestoreFieldAvailability(field,values[field as RestorableMetadataField]);
      if (!availability.available) throw new Error(`Cannot restore ${field}: ${availability.reason}`);
    }
    if (!Array.isArray(options.nativeLockFields) || options.nativeLockFields.some(field => !Object.hasOwn(values,field)
      || !getMetadataRestoreFieldAvailability(field,values[field]).nativeLockAvailable)) {
      throw new Error('Native locks can only be restored for selected fields with supported, captured lock flags.');
    }
    const {title, ...scalars} = values;
    let expected = options.expected;
    if (title !== undefined) {
      const availability = getMetadataRestoreFieldAvailability('title',title);
      if (!availability.available) throw new Error(`Cannot restore title: ${availability.reason}`);
      options.checkCancelled?.();
      const current = await this.getSeriesDto(seriesId);
      const cell = {present:Object.hasOwn(current,'name'),value:current.name,nativeLocked:current.nameLocked};
      if (current.id !== seriesId || current.id !== expected.series.id || current.libraryId !== expected.series.libraryId || current.name !== expected.series.name
        || (Object.hasOwn(expected.series,'folderPath') && current.folderPath !== expected.series.folderPath)
        || metadataValueKey(cell) !== metadataValueKey(expected.fields.title)
        || (expected.installationId !== undefined && (await this.getServerInfo()).installId !== expected.installationId)) {
        throw new Error('Title restore review required: series identity, title or native lock changed after preview');
      }
      const lock = options.nativeLockFields.includes('title') ? title.nativeLocked : current.nameLocked;
      if (typeof lock !== 'boolean') throw new Error('Cannot restore title without a verifiable native name lock');
      const capability=titleRestoreCapability(current);
      if(capability)throw new Error(capability);
      // Kavita derives an unlocked sort name on rename even when the DTO repeats
      // its old value. Temporarily lock it, then restore its original flag using
      // the fresh post-rename DTO (the second request no longer renames anything).
      const stageSortLock = current.name!==title.value && !current.sortNameLocked;
      const post = async (body:KavitaSeriesDto) => {
        const response=await fetchJson(this.url('/Series/update'),{method:'POST',headers:{...this.headers,'Content-Type':'application/json'},body:JSON.stringify(body)},15_000,{raw:true});
        if(response.status<200 || response.status>=300)throw this.requestError(`Restore series ${seriesId} title`,'/Series/update',response.status,response.data);
      };
      let writeFailure:unknown,writeFailed=false;
      try {await post({...current,name:title.value as string,nameLocked:lock,...(stageSortLock?{sortNameLocked:true}:{})});}
      catch(error){writeFailed=true;writeFailure=error;}
      let observed=await this.getSeriesDto(seriesId);
      const untouched = ['localizedName','sortName','coverImageLocked','sortNameLocked','localizedNameLocked','metadataProviderOverride',
        'aniListId','malId','hardcoverId','metronId','comicVineId','mangaBakaId','cbrId'];
      const identityMatches=() => observed.id===current.id && observed.libraryId===current.libraryId && observed.folderPath===current.folderPath
        && observed.name===title.value && observed.nameLocked===lock;
      const differs=(key:string,before:KavitaSeriesDto) => JSON.stringify((observed as unknown as Record<string,unknown>)[key])!==JSON.stringify((before as unknown as Record<string,unknown>)[key]);
      if(!identityMatches() || observed.sortName!==current.sortName || observed.sortNameLocked!==(stageSortLock?true:current.sortNameLocked)) {
        throw new Error('Title restore outcome is unverified; exact title, native lock or unrelated series values were not confirmed');
      }
      const collateralChanged=untouched.filter(key=>key!=='sortNameLocked' && differs(key,current));
      if(stageSortLock) {
        const final={...observed,sortNameLocked:current.sortNameLocked};
        let flagFailure:unknown,flagFailed=false;
        try{await post(final);}catch(error){flagFailure=error;flagFailed=true;}
        observed=await this.getSeriesDto(seriesId);
        if(!identityMatches() || observed.sortNameLocked!==current.sortNameLocked || untouched.some(key=>differs(key,final))) {
          throw new Error('Title restore native-lock outcome is unverified; review current series settings');
        }
        if(flagFailed)throw new Error(`Title restore native-lock request failed despite readback: ${String(flagFailure)}`,{cause:flagFailure});
      }
      if(collateralChanged.length || (expected.installationId!==undefined && (await this.getServerInfo()).installId!==expected.installationId)) {
        throw new Error('Title restore outcome is unverified; unrelated series settings or installation identity changed');
      }
      if(writeFailed)throw new Error(`Title restore request failed despite readback: ${String(writeFailure)}`,{cause:writeFailure});
      expected = {...expected,series:{...expected.series,name:title.value as string},fields:{...expected.fields,title:{...title,nativeLocked:lock}}};
    }
    if (Object.keys(scalars).length) await this.restoreScalarMetadataExact(seriesId,scalars,{
      ...options,expected,nativeLockFields:options.nativeLockFields.filter(field => field !== 'title'),
    });
    else if (!title) throw new Error('No metadata fields were selected for restoration.');
  }

  private async restoreScalarMetadataExact(seriesId: number, values: ExactMetadataRestoreValues, options: ExactMetadataRestoreOptions): Promise<void> {
    const fields = Object.keys(values);
    if (!fields.length) throw new Error('No metadata fields were selected for restoration.');
    for (const field of fields) {
      const availability = getMetadataRestoreFieldAvailability(field, values[field as RestorableMetadataField]);
      if (!availability.available) throw new Error(`Cannot restore ${field}: ${availability.reason}`);
    }
    // Runtime validation is intentional: historical JSON is not a trusted DTO.
    const selected = fields as RestorableMetadataField[];
    if (!Array.isArray(options.nativeLockFields) || options.nativeLockFields.some(field =>
      !isRestorableMetadataField(field) || !selected.includes(field) ||
      !getMetadataRestoreFieldAvailability(field, values[field]).nativeLockAvailable)) {
      throw new Error('Native locks can only be restored for selected fields with supported, captured lock flags.');
    }
    const historicalLocks = new Set(options.nativeLockFields);
    const prepared = new Map<RestorableMetadataField, unknown>();

    options.checkCancelled?.();
    await Promise.all(selected.map(async field => {
      const value = values[field]!.value;
      const names: string[] | undefined = Array.isArray(value) ? value.map(item => {
        if (typeof item === 'string') return item;
        // Availability validation above has already proved this historical entry.
        const entry = item as Record<string, string>;
        return entry[field === 'genres' || field === 'tags' ? 'title' : 'name'];
      }) : undefined;
      if (field === 'writers' || field === 'artists') {
        // Do not reuse provider caches or historical ids: resolve against this
        // connection now, and never turn a lookup failure into person creation.
        const people = await Promise.all(names!.map(async name => {
          const found = await this.getJson<KavitaPersonDto | null>(`/Person?name=${encodeURIComponent(name)}`, `Resolve restore person ${name}`);
          if (found === null) return { id: 0, name };
          if (!found || !Number.isSafeInteger(found.id) || found.id <= 0 || found.name !== name) {
            throw new Error(`Cannot resolve the captured person name exactly: ${name}`);
          }
          return { id: found.id, name: found.name };
        }));
        prepared.set(field, people);
      } else if (field === 'genres' || field === 'tags') {
        prepared.set(field, names!.map(title => ({ id: 0, title })));
      } else {
        prepared.set(field, value);
      }
    }));

    const readCurrent = async (): Promise<KavitaSeriesMetadataDto> => {
      const [series, metadata, serverInfo] = await Promise.all([
        this.getSeriesDto(seriesId), this.getSeriesMetadata(seriesId),
        options.expected.installationId === undefined ? undefined : this.getServerInfo(),
      ]);
      const identity = options.expected.series;
      if (!series || series.id !== seriesId || series.id !== identity.id || series.libraryId !== identity.libraryId ||
        (series.name ?? null) !== identity.name ||
        (Object.hasOwn(identity, 'folderPath') && (series.folderPath ?? null) !== identity.folderPath) ||
        (options.expected.installationId !== undefined && options.expected.installationId !== serverInfo?.installId)) {
        throw new Error('Metadata restore review required: series identity changed after preview.');
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.seriesId !== seriesId ||
        !Number.isSafeInteger(metadata.id) || metadata.id < 0) {
        throw new Error('Metadata restore readback did not return a verifiable full series metadata DTO.');
      }
      return metadata;
    };
    const cellFrom = (metadata: KavitaSeriesMetadataDto, field: RestorableMetadataField): RecordedValue => {
      const mapping = RESTORE_FIELD_MAPPINGS[field], record = metadata as unknown as Record<string, unknown>;
      return { present: Object.hasOwn(record, mapping.key),
        ...(Object.hasOwn(record, mapping.key) ? { value: record[mapping.key] } : {}),
        ...('lock' in mapping && typeof record[mapping.lock] === 'boolean' ? { nativeLocked: record[mapping.lock] as boolean } : {}) };
    };
    const assertSelected = (metadata: KavitaSeriesMetadataDto, expected: MetadataSnapshot['fields'], message: string): void => {
      const changed = selected.filter(field => metadataValueKey(cellFrom(metadata, field)) !== metadataValueKey(expected[field]));
      if (changed.length) throw new Error(`${message}: ${changed.join(', ')}.`);
    };
    const selectedDtoKeys = new Set<string>();
    for (const field of selected) {
      const mapping = RESTORE_FIELD_MAPPINGS[field];
      selectedDtoKeys.add(mapping.key);
      if ('lock' in mapping) selectedDtoKeys.add(mapping.lock);
    }
    const assertCollateral = (metadata: KavitaSeriesMetadataDto, before: Record<string, unknown>, ageRatingOnly: boolean): void => {
      const keys = ageRatingOnly ? ['ageRating', 'ageRatingLocked'] : [
        ...Object.values(RESTORE_FIELD_MAPPINGS).map(mapping => mapping.key),
        'coverArtists', 'publishers', 'characters', 'inkers', 'imprints', 'colorists',
        'letterers', 'editors', 'translators', 'teams', 'locations', 'ageRating', 'maxCount', 'totalCount',
        ...Object.keys(before).filter(key => key.endsWith('Locked')),
      ];
      const record = metadata as unknown as Record<string, unknown>;
      const changed = keys.filter(key => !selectedDtoKeys.has(key) && metadataValueKey({
        present: Object.hasOwn(record, key), ...(Object.hasOwn(record, key) ? { value: record[key] } : {}),
      }, false) !== metadataValueKey({
        present: Object.hasOwn(before, key), ...(Object.hasOwn(before, key) ? { value: before[key] } : {}),
      }, false));
      if (changed.length) throw new Error(`Metadata restore review required: unselected metadata changed during restoration: ${changed.join(', ')}.`);
    };
    const postMetadata = async (metadata: Record<string, unknown>, action: string): Promise<void> => {
      // An ambiguous mutation must not be blindly replayed by the retry helper.
      const response = await fetchJson(this.url('/Series/metadata'), {
        method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesMetadata: metadata }),
      }, 15_000, { raw: true });
      if (response.status < 200 || response.status >= 300) {
        throw this.requestError(action, '/Series/metadata', response.status, response.data);
      }
    };

    // Resolve all names first, then re-read identity and the full DTO immediately
    // before writing; a cached/provider-normalized DTO would lose unrelated nulls.
    const current = await readCurrent();
    assertSelected(current, options.expected.fields, 'Metadata restore review required: selected values or native locks changed after preview');
    const unlocked: Record<string, unknown> = { ...current };
    const interim: MetadataSnapshot['fields'] = {}, final: MetadataSnapshot['fields'] = {};
    let needsRelock = false;
    for (const field of selected) {
      const mapping = RESTORE_FIELD_MAPPINGS[field], target = values[field]!;
      unlocked[mapping.key] = prepared.get(field);
      interim[field] = { present: true, value: target.value };
      final[field] = { present: true, value: target.value };
      if ('lock' in mapping) {
        const currentLock = cellFrom(current, field).nativeLocked;
        if (typeof currentLock !== 'boolean') throw new Error(`Cannot preserve the current native lock for ${field}; its flag was not returned by Kavita.`);
        const finalLock = historicalLocks.has(field) ? target.nativeLocked! : currentLock;
        unlocked[mapping.lock] = false;
        interim[field].nativeLocked = false;
        final[field].nativeLocked = finalLock;
        needsRelock ||= finalLock;
      }
    }
    options.checkCancelled?.();
    let writeFailure: unknown;
    let writeFailed = false;
    try {
      await postMetadata(unlocked, `Restore series ${seriesId} metadata`);
    } catch (error) {
      writeFailure = error;
      writeFailed = true;
    }

    // Even a failed request may have applied remotely. Observe it once, and only
    // restore locks when the selected interim values and flags are proven exact.
    // Cancellation after this point is deferred until native flags are restored.
    let observed: KavitaSeriesMetadataDto;
    try {
      observed = await readCurrent();
      assertSelected(observed, interim, 'Metadata restore review required: exact values and unlocked state were not confirmed after the write');
    } catch (error) {
      if (writeFailed) throw new Error(`Metadata restore outcome is unverified: ${String(writeFailure)}; ${String(error)}`, { cause: writeFailure });
      throw error;
    }
    let collateralFailure: Error | undefined;
    try {
      // Kavita may derive ageRating from changed tags/genres even when the full
      // DTO repeats the current rating. Do not pretend that collateral is safe.
      assertCollateral(observed, unlocked, true);
    } catch (error) {
      collateralFailure = error instanceof Error ? error : new Error(String(error));
    }
    if (needsRelock) {
      // This is a fresh full DTO, not the first POST body: preserve inter-post
      // changes to unrelated fields, including fields unknown to this client.
      const relocked: Record<string, unknown> = { ...observed };
      for (const field of selected) {
        const mapping = RESTORE_FIELD_MAPPINGS[field];
        if ('lock' in mapping) relocked[mapping.lock] = final[field].nativeLocked;
      }
      let lockFailure: unknown;
      let lockFailed = false;
      try {
        await postMetadata(relocked, `Restore series ${seriesId} native metadata locks`);
      } catch (error) {
        lockFailure = error;
        lockFailed = true;
      }
      try {
        observed = await readCurrent();
        assertSelected(observed, final, 'Metadata restore review required: exact values or final native locks were not confirmed');
        assertCollateral(observed, relocked, false);
      } catch (error) {
        if (lockFailed) throw new Error(`Metadata restore native-lock outcome is unverified: ${String(lockFailure)}; ${String(error)}`, { cause: lockFailure });
        throw error;
      }
      if (lockFailed) throw new Error(`Metadata restore native-lock request failed despite observed readback: ${String(lockFailure)}`, { cause: lockFailure });
    } else {
      assertSelected(observed, final, 'Metadata restore review required: exact values or final native locks were not confirmed');
    }
    // Proven selected values still permit native-flag cleanup above. Never try
    // a compensating write to the unexpectedly changed unselected metadata.
    if (collateralFailure) throw collateralFailure;
    if (writeFailed) throw new Error(`Metadata restore request failed despite observed readback: ${String(writeFailure)}`, { cause: writeFailure });
    options.checkCancelled?.();
  }

  private hasMetadataPatch(patch: SeriesMetadataPayload): boolean {
    return [
      patch.summary,
      patch.genres,
      patch.tags,
      patch.writers,
      patch.artists,
      patch.releaseYear,
      patch.language,
      patch.publicationStatus,
      patch.webLinks,
    ].some((value) => value !== undefined);
  }

  private normalizeMetadata(metadata: KavitaSeriesMetadataDto, seriesId: number): KavitaSeriesMetadataDto {
    return {
      ...metadata,
      id: metadata.id ?? 0,
      seriesId,
      summary: metadata.summary ?? '',
      language: metadata.language ?? '',
      webLinks: metadata.webLinks ?? '',
      genres: metadata.genres ?? [],
      tags: metadata.tags ?? [],
      writers: metadata.writers ?? [],
      coverArtists: metadata.coverArtists ?? [],
      publishers: metadata.publishers ?? [],
      characters: metadata.characters ?? [],
      pencillers: metadata.pencillers ?? [],
      inkers: metadata.inkers ?? [],
      imprints: metadata.imprints ?? [],
      colorists: metadata.colorists ?? [],
      letterers: metadata.letterers ?? [],
      editors: metadata.editors ?? [],
      translators: metadata.translators ?? [],
      teams: metadata.teams ?? [],
      locations: metadata.locations ?? [],
    };
  }

  private mergeMetadataPatch(
    metadata: KavitaSeriesMetadataDto,
    patch: SeriesMetadataPayload,
    lock = true,
    people?: { writers?: KavitaPersonDto[]; artists?: KavitaPersonDto[] },
  ): void {
    const tags = (values: string[]): KavitaTagDto[] => values.map((title) => ({ id: 0, title }));

    if (patch.summary !== undefined) {
      metadata.summary = patch.summary;
      metadata.summaryLocked = lock;
    }
    if (patch.genres !== undefined) {
      metadata.genres = tags(patch.genres);
      metadata.genresLocked = lock;
    }
    if (patch.tags !== undefined) {
      metadata.tags = tags(patch.tags);
      metadata.tagsLocked = lock;
    }
    if (patch.writers !== undefined) {
      // An empty resolved list means the names were all blank — keep the current
      // writers rather than clearing them.
      const resolved = people?.writers;
      if (resolved && resolved.length > 0) {
        metadata.writers = resolved;
        metadata.writerLocked = lock;
      }
    }
    if (patch.artists !== undefined) {
      // The unified provider model has one generic artist role. Penciller is
      // Kavita's closest series-level equivalent and remains independently
      // editable from cover artist, inker, and colorist roles.
      const resolved = people?.artists;
      if (resolved && resolved.length > 0) {
        metadata.pencillers = resolved;
        metadata.pencillerLocked = lock;
      }
    }
    if (patch.releaseYear !== undefined) {
      metadata.releaseYear = patch.releaseYear;
      metadata.releaseYearLocked = lock;
    }
    if (patch.language !== undefined) {
      metadata.language = patch.language;
      metadata.languageLocked = lock;
    }
    if (patch.publicationStatus !== undefined) {
      metadata.publicationStatus = patch.publicationStatus;
      metadata.publicationStatusLocked = lock;
    }
    if (patch.webLinks !== undefined) metadata.webLinks = patch.webLinks;
  }

  /** Remove fields previously applied by H-Tosho while preserving unrelated user metadata. */
  async removeSeriesMetadata(seriesId: number, applied: SeriesMetadataPayload, fields: readonly string[]): Promise<void> {
    const remove = new Set(fields);
    // When both removal kinds are requested the series and metadata reads are
    // independent — start both up front instead of serializing them (branch
    // order and error behavior below stay unchanged).
    const removeName = remove.has('name') && applied.name !== undefined;
    const currentDto = removeName ? this.getSeriesDto(seriesId) : undefined;
    const metadataDto = [...remove].some((field) => field !== 'name')
      ? this.getSeriesMetadata(seriesId)
      : undefined;
    if (removeName && currentDto) {
      const current = await currentDto;
      const update: KavitaUpdateSeriesDto = {
        id: seriesId,
        name: current.name ?? null,
        localizedName: current.localizedName ?? null,
        sortName: current.sortName ?? null,
        coverImageLocked: current.coverImageLocked ?? false,
        nameLocked: false,
        sortNameLocked: current.sortNameLocked ?? false,
        localizedNameLocked: current.localizedNameLocked ?? false,
        metadataProviderOverride: current.metadataProviderOverride ?? null,
        aniListId: current.aniListId ?? null,
        malId: current.malId ?? null,
        hardcoverId: current.hardcoverId ?? null,
        metronId: current.metronId ?? null,
        comicVineId: current.comicVineId ?? null,
        mangaBakaId: current.mangaBakaId ?? null,
        cbrId: current.cbrId ?? null,
      };
      await this.postJson('/Series/update', update, `Clear series ${seriesId} identity metadata`);
    }

    if (metadataDto) {
      const metadata = this.normalizeMetadata(await metadataDto, seriesId);
      const removeTags = (current: KavitaTagDto[], values?: string[]): KavitaTagDto[] => {
        const removed = new Set((values ?? []).map((value) => value.trim().toLowerCase()));
        return current.filter((item) => !removed.has((item.title ?? '').trim().toLowerCase()));
      };
      const removePeople = (current: KavitaPersonDto[], values?: string[]): KavitaPersonDto[] => {
        const removed = new Set((values ?? []).map((value) => value.trim().toLowerCase()));
        return current.filter((item) => !removed.has((item.name ?? '').trim().toLowerCase()));
      };
      const same = (left: string | null | undefined, right: string | undefined): boolean =>
        right !== undefined && (left ?? '').trim().toLowerCase() === right.trim().toLowerCase();
      if (remove.has('summary') && same(metadata.summary, applied.summary)) metadata.summary = '';
      if (remove.has('genres')) metadata.genres = removeTags(metadata.genres ?? [], applied.genres);
      if (remove.has('tags')) metadata.tags = removeTags(metadata.tags ?? [], applied.tags);
      if (remove.has('writers')) metadata.writers = removePeople(metadata.writers ?? [], applied.writers);
      if (remove.has('artists')) metadata.pencillers = removePeople(metadata.pencillers ?? [], applied.artists);
      if (remove.has('releaseYear') && metadata.releaseYear === applied.releaseYear) metadata.releaseYear = 0;
      if (remove.has('language') && same(metadata.language, applied.language)) metadata.language = '';
      if (remove.has('publicationStatus') && metadata.publicationStatus === applied.publicationStatus) metadata.publicationStatus = 0;
      if (remove.has('webLinks') && same(metadata.webLinks, applied.webLinks)) metadata.webLinks = '';
      if (remove.has('summary')) metadata.summaryLocked = false;
      if (remove.has('genres')) metadata.genresLocked = false;
      if (remove.has('tags')) metadata.tagsLocked = false;
      if (remove.has('writers')) metadata.writerLocked = false;
      if (remove.has('artists')) metadata.pencillerLocked = false;
      if (remove.has('releaseYear')) metadata.releaseYearLocked = false;
      if (remove.has('language')) metadata.languageLocked = false;
      if (remove.has('publicationStatus')) metadata.publicationStatusLocked = false;
      await this.postJson('/Series/metadata', { seriesMetadata: metadata } satisfies KavitaUpdateSeriesMetadataDto, `Clear series ${seriesId} metadata`);
    }
  }

  /** Clear H-Tosho's custom series cover and unlock Kavita's cover selection. */
  async resetSeriesCover(seriesId: number): Promise<void> {
    await this.postJson('/Upload/series', { id: seriesId, url: '', lockCover: false } satisfies KavitaUploadCoverFileDto, `Reset series ${seriesId} cover`);
  }

  /**
   * POST /api/Upload/series with a base64 image payload. This is the cover
   * replacement shape accepted across Kavita v0.9 builds; newer versions also
   * support staging via /Upload/upload-by-file, but that endpoint does not
   * exist on 0.9.0.x servers (it 404s), so we always send the payload inline.
   */
  async updateSeriesCover(seriesId: number, image: Buffer, lockCover: boolean): Promise<void> {
    const body: KavitaUploadCoverFileDto = { id: seriesId, url: image.toString('base64'), lockCover };
    await this.postJson('/Upload/series', body, `Update series ${seriesId} cover`);
  }

  /** GET /api/Series/volumes?seriesId={seriesId} */
  async getVolumes(seriesId: number): Promise<KavitaVolume[]> {
    const path = `/Series/volumes?seriesId=${encodeURIComponent(seriesId)}`;
    const volumes = await this.getJson<KavitaVolumeDto[]>(path, `Get series ${seriesId} volumes`);
    return (volumes ?? []).map((volume) => ({
      id: volume.id,
      name: volume.name ?? undefined,
      minNumber: volume.minNumber,
      maxNumber: volume.maxNumber,
      number: Number.isFinite(volume.minNumber) ? volume.minNumber : volume.number,
    }));
  }

  /** POST /api/Upload/volume — same base64 payload shape as the series cover endpoint. */
  async updateVolumeCover(volumeId: number, image: Buffer, lockCover: boolean): Promise<void> {
    const body: KavitaUploadCoverFileDto = { id: volumeId, url: image.toString('base64'), lockCover };
    await this.postJson('/Upload/volume', body, `Update volume ${volumeId} cover`);
  }

  /**
   * Fetch a cover image via Kavita instead of locally: POST
   * /api/Upload/upload-by-url (body { url }) makes Kavita download the image
   * into its temp dir and returns the staged filename; GET
   * /api/Image/cover-upload then reads the staged bytes back. The round-trip
   * is required because Kavita's cover apply endpoints (/Upload/series,
   * /Upload/volume) only accept inline base64 payloads on v0.9 — they cannot
   * reference the staged temp file. Throws when Kavita cannot download or
   * validate the image; callers fall back to the local-download + base64 path
   * (some provider CDNs require a Referer header Kavita cannot send).
   */
  async fetchCoverViaServer(url: string): Promise<Buffer> {
    const staged = await this.postJson<unknown>('/Upload/upload-by-url', { url }, 'Stage cover upload from URL');
    const filename = typeof staged === 'string' ? staged.replace(/^"|"$/g, '').trim() : '';
    if (!filename) {
      throw new Error('Kavita staged cover upload did not return a filename.');
    }
    const path = `/Image/cover-upload?filename=${encodeURIComponent(filename)}&apiKey=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(this.url(path), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw this.requestError('Fetch staged cover image', path, response.status);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) throw new Error(`Kavita staged cover image ${filename} was empty.`);
    return data;
  }

  /**
   * Apply a series cover from a provider URL, letting Kavita do the download.
   * Throws when either leg fails so the caller can fall back to the base64
   * path with a locally downloaded image.
   */
  async updateSeriesCoverFromUrl(seriesId: number, url: string, lockCover: boolean): Promise<void> {
    await this.updateSeriesCover(seriesId, await this.fetchCoverViaServer(url), lockCover);
  }

  /** Server-side cover fetch for a volume; see updateSeriesCoverFromUrl. */
  async updateVolumeCoverFromUrl(volumeId: number, url: string, lockCover: boolean): Promise<void> {
    await this.updateVolumeCover(volumeId, await this.fetchCoverViaServer(url), lockCover);
  }

  /**
   * GET /api/Image/series-cover?seriesId={seriesId}&apiKey={key}
   *
   * Kavita's image endpoints (unlike JSON endpoints) require the API key to be
   * passed as a `?apiKey=` query parameter; sending it only via the `x-api-key`
   * header is rejected with HTTP 400 ("The apiKey field is required.").
   */
  async getSeriesCover(seriesId: number): Promise<{ data: Buffer; contentType: string }> {
    const path = `/Image/series-cover?seriesId=${encodeURIComponent(seriesId)}&apiKey=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(this.url(path), {
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw this.requestError(`Get series ${seriesId} cover`, path, response.status);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async downloadImage(url: string): Promise<Buffer> {
    return fetchBuffer(url, { headers: { 'User-Agent': 'H-Tosho/1.0' } });
  }

  /** POST /api/Library/scan?libraryId={id} - rescan a single library for new media. */
  async scanLibrary(libraryId: number): Promise<void> {
    await this.postJson(`/Library/scan?libraryId=${encodeURIComponent(libraryId)}`, {}, `Scan library ${libraryId}`);
  }

  /**
   * POST /api/Library/scan-folder — scan the Kavita library that owns a folder
   * path. ScanFolderDto carries the folder path plus the admin API key (the
   * server re-resolves the user from it) and has no library field, so
   * libraryId only names the target in logs/errors. abortOnNoSeriesMatch must
   * be false: with it set Kavita drops the scan when the folder doesn't
   * already map to a series, which is exactly the newly-downloaded-folder
   * case this call exists for.
   */
  async scanFolder(libraryId: number, folderPath: string): Promise<void> {
    const body = { apiKey: this.apiKey, folderPath, abortOnNoSeriesMatch: false };
    await this.postJson('/Library/scan-folder', body, `Scan folder ${folderPath} (library ${libraryId})`);
  }

  /** POST /api/Series/scan — force Kavita to re-read this series' files. */
  async scanSeries(libraryId: number, seriesId: number): Promise<void> {
    await this.postJson('/Series/scan', { libraryId, seriesId, forceUpdate: true, forceColorscape: false }, `Scan series ${seriesId}`);
  }

  /** Clear a custom volume cover and unlock Kavita's generated cover. */
  async resetVolumeCover(volumeId: number): Promise<void> {
    await this.postJson('/Upload/volume', { id: volumeId, url: '', lockCover: false } satisfies KavitaUploadCoverFileDto, `Reset volume ${volumeId} cover`);
  }

  /** DELETE /api/Series/{seriesId} — removes the series record; files on disk are untouched. */
  async deleteSeries(seriesId: number): Promise<void> {
    await this.deleteJson(`/Series/${seriesId}`, `Delete series ${seriesId}`);
  }

  /** POST /api/Library/scan-all - rescan all libraries for new media. */
  async scanAllLibraries(): Promise<void> {
    await this.postJson('/Library/scan-all', {}, 'Scan all libraries');
  }
}
