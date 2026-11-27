import fs from "node:fs";
import path from "node:path";
import type {
  MergeProtectionPreview,
  MergeProtectionRequest,
  MergeProtectionSeries,
  MergeProtectionState,
} from "../contracts/mergeProtection.js";
import { PROTECTABLE_FIELDS } from "../contracts/metadata.js";
import { kavitaNormalizeName } from "../kavita/client.js";
import { mapKavitaPathToLocalPath } from "../kavita/libraryPaths.js";
import type { KavitaChapterDto } from "../kavita/types.js";
import {
  listCbzFilesAsync,
  readComicInfo,
  resolveExistingFile,
} from "../lib/cbz.js";
import { comicInfoSeries } from "../lib/comicInfoRestore.js";
import { mapLimit } from "../lib/http.js";
import { archiveResource, archiveResourceAsync } from "../lib/mutations.js";
import { lastSegment, pathContains, safeRealpath } from "../lib/paths.js";
import { getFieldPolicies } from "../services/fieldPolicies.js";
import {
  ProtectedMergeError,
  type KavitaMergePort,
  type KavitaMergeSession,
  type MergeSettingsPort,
} from "./types.js";

/** Resolve existing ancestors too: a not-yet-created child can still escape through a symlink. */
export function canonicalMergePath(file: string): string {
  let ancestor = path.resolve(file);
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(safeRealpath(ancestor), ...suffix);
}

const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseMergeProtectionRequest(
  value: unknown
): MergeProtectionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtectedMergeError("Invalid merge protection request", 400);
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "seriesId",
          "sourceSeriesIds",
          "sourceFiles",
          "targetDir",
          "seriesName",
        ].includes(key)
    )
  ) {
    throw new ProtectedMergeError("Unknown merge protection field", 400);
  }
  if (body.seriesId !== undefined && !positiveId(body.seriesId))
    throw new ProtectedMergeError("Invalid target series", 400);
  if (
    body.sourceSeriesIds !== undefined &&
    (!Array.isArray(body.sourceSeriesIds) ||
      body.sourceSeriesIds.length > 500 ||
      !body.sourceSeriesIds.every(positiveId) ||
      new Set(body.sourceSeriesIds).size !== body.sourceSeriesIds.length)
  ) {
    throw new ProtectedMergeError(
      "Choose up to 500 unique positive source series IDs",
      400
    );
  }
  if (
    body.sourceFiles !== undefined &&
    (!Array.isArray(body.sourceFiles) ||
      body.sourceFiles.some(
        (file) =>
          typeof file !== "string" ||
          !path.isAbsolute(file) ||
          file.includes("\0")
      ))
  ) {
    throw new ProtectedMergeError("Invalid source archive paths", 400);
  }
  if (
    body.targetDir !== undefined &&
    (typeof body.targetDir !== "string" ||
      !path.isAbsolute(body.targetDir) ||
      body.targetDir.includes("\0"))
  ) {
    throw new ProtectedMergeError("An absolute target folder is required", 400);
  }
  if (
    body.seriesName !== undefined &&
    (typeof body.seriesName !== "string" ||
      !body.seriesName.trim() ||
      /[\u0000-\u001f\u007f]/.test(body.seriesName))
  ) {
    throw new ProtectedMergeError("Invalid merged series name", 400);
  }
  if (!body.seriesId && !body.targetDir)
    throw new ProtectedMergeError("Choose a merge target", 400);
  return {
    ...body,
    ...(typeof body.seriesName === "string"
      ? { seriesName: body.seriesName.trim() }
      : {}),
  };
}

/**
 * Internal short-lived reuse of Kavita chapter listings across back-to-back
 * rechecks of one merge step. Only Kavita chapter responses are reused;
 * libraries, series identities, local files, ComicInfo, and Field Policies
 * are re-read fresh on every resolution.
 */
export class MergeChapterCache {
  private entries = new Map<
    number,
    { at: number; connection: string; chapters: Promise<KavitaChapterDto[]> }
  >();
  constructor(
    readonly ttlMs = 5_000,
    private readonly now: () => number = Date.now
  ) {}

  clear(): void {
    this.entries.clear();
  }

  load(
    connection: string,
    seriesId: number,
    fetch: () => Promise<KavitaChapterDto[]>
  ): Promise<KavitaChapterDto[]> {
    const hit = this.entries.get(seriesId);
    if (
      hit &&
      hit.connection === connection &&
      this.now() - hit.at <= this.ttlMs
    )
      return hit.chapters;
    const entry = { at: this.now(), connection, chapters: fetch() };
    this.entries.set(seriesId, entry);
    entry.chapters.catch(() => {
      if (this.entries.get(seriesId) === entry) this.entries.delete(seriesId);
    });
    return entry.chapters;
  }
}

export interface ResolvedMergeAuthority {
  preview: MergeProtectionPreview;
  state: MergeProtectionState;
  targetDir: string;
  libraryId?: number;
}

/** Read-only authority resolution. Folder/name hints alone never establish archive ownership. */
export async function resolveMergeAuthority(
  session: KavitaMergeSession,
  kavitaPort: KavitaMergePort,
  settings: MergeSettingsPort,
  request: MergeProtectionRequest,
  previous?: MergeProtectionState,
  chapterCache?: MergeChapterCache
): Promise<ResolvedMergeAuthority> {
  const key = session.connectionKey;
  if (!key || (previous && previous.connectionKey !== key)) {
    throw new ProtectedMergeError(
      "Kavita connection changed; reload the merge review"
    );
  }
  const dl = settings.getDownloaderPaths();
  const mappings = dl.libraryPathMappings ?? [];
  const libraries = await session.getLibraries();
  const nativeRoots = libraries
    .flatMap((library) => library.paths ?? (library.path ? [library.path] : []))
    .filter(
      (root) =>
        path.isAbsolute(root) &&
        (fs.existsSync(root) ||
          (!!dl.downloadDirectory &&
            archiveResource(root) ===
              archiveResource(path.resolve(dl.downloadDirectory))))
    )
    .map(canonicalMergePath);
  const map = (file: string) =>
    mapKavitaPathToLocalPath(file, mappings) ??
    (path.isAbsolute(file) &&
    (fs.existsSync(file) ||
      nativeRoots.some((root) => pathContains(root, canonicalMergePath(file))))
      ? file
      : null);
  const libraryRoots = libraries.flatMap((lib) =>
    (lib.paths ?? (lib.path ? [lib.path] : []))
      .map(map)
      .filter((root): root is string => !!root)
  );
  const roots = [
    ...libraryRoots,
    ...mappings.map((mapping) => mapping.localPath),
    ...(dl.downloadDirectory ? [dl.downloadDirectory] : []),
  ].map(canonicalMergePath);
  const allowed = (file: string) =>
    roots.some((root) => pathContains(root, canonicalMergePath(file)));
  const all = (
    await Promise.all(
      libraries.map(async (library) =>
        (await session.getSeries(library.id)).map((series) => ({
          ...series,
          libraryId: library.id,
        }))
      )
    )
  ).flat();
  if (
    libraries.some((library) => !positiveId(library.id)) ||
    all.some(
      (series) => !positiveId(series.id) || !positiveId(series.libraryId)
    ) ||
    new Set(libraries.map((library) => library.id)).size !== libraries.length ||
    new Set(all.map((series) => series.id)).size !== all.length
  ) {
    throw new ProtectedMergeError(
      "Kavita returned an invalid or ambiguous library/series identity",
      502
    );
  }
  const seriesDirectory = (series: (typeof all)[number]): string | null => {
    if (!series.folderPath) return null;
    const absolute = map(series.folderPath);
    if (absolute) return absolute;
    if (path.isAbsolute(series.folderPath)) return null;
    const library = libraries.find((lib) => lib.id === series.libraryId);
    const candidates = (library?.paths ?? (library?.path ? [library.path] : []))
      .map((root) => {
        const local = map(root);
        return local
          ? path.resolve(local, ...series.folderPath!.split(/[\\/]/))
          : null;
      })
      .filter(
        (candidate): candidate is string => !!candidate && allowed(candidate)
      );
    if (candidates.length > 1)
      throw new ProtectedMergeError(
        "Series folder mapping is ambiguous; configure one authoritative library mapping"
      );
    return candidates[0] ?? null;
  };

  const resourceCache = new Map<string, string>();
  const cachedResource = (file: string): string => {
    let hit = resourceCache.get(file);
    if (hit === undefined) {
      hit = archiveResource(file);
      resourceCache.set(file, hit);
    }
    return hit;
  };
  const xmlCache = new Map<string, string | null>();
  const cachedReadComicInfo = async (file: string): Promise<string | null> => {
    const resourceKey = cachedResource(file);
    if (xmlCache.has(resourceKey)) return xmlCache.get(resourceKey)!;
    const xml = await readComicInfo(file);
    xmlCache.set(resourceKey, xml);
    return xml;
  };

  let target =
    request.seriesId === undefined
      ? undefined
      : all.find((series) => series.id === request.seriesId);
  if (
    request.seriesId !== undefined &&
    !target &&
    previous?.targetSeriesId !== request.seriesId &&
    !previous?.identities.some(
      (identity) => identity.seriesId === request.seriesId
    )
  ) {
    throw new ProtectedMergeError(
      "Target series no longer exists; refresh the merge review"
    );
  }
  let targetDir = request.targetDir;
  if (target) {
    const mapped = seriesDirectory(target);
    if (!mapped || !allowed(mapped) || !fs.existsSync(mapped)) {
      throw new ProtectedMergeError(
        "Could not locate the indexed target folder; check library mappings"
      );
    }
    if (targetDir && archiveResource(targetDir) !== archiveResource(mapped)) {
      throw new ProtectedMergeError(
        "Target folder does not match the selected series"
      );
    }
    targetDir = mapped;
  }
  targetDir ??= previous?.targetDir;
  if (
    !targetDir ||
    !allowed(targetDir) ||
    roots.some((root) => archiveResource(root) === archiveResource(targetDir!))
  ) {
    throw new ProtectedMergeError(
      "Target must be inside an allowed library or output folder, not the root itself"
    );
  }
  targetDir = canonicalMergePath(targetDir);
  if (
    previous &&
    archiveResource(previous.targetDir) !== archiveResource(targetDir)
  ) {
    throw new ProtectedMergeError(
      "Merge destination changed; refresh the review"
    );
  }

  const targetFiles = await listCbzFilesAsync(targetDir);
  const sourceFiles = [...new Set(request.sourceFiles ?? [])];
  const seriesDirs = new Map<(typeof all)[number], string | null>();
  const pathsToResolve = new Set<string>([
    ...roots,
    targetDir,
    ...targetFiles,
    ...sourceFiles,
    ...sourceFiles.map((file) => path.dirname(file)),
    ...(previous?.targetDir ? [previous.targetDir] : []),
    ...(previous?.archives.flatMap((item) => [
      item.path,
      path.dirname(item.path),
    ]) ?? []),
    ...(previous?.moves?.flatMap((move) => [
      move.destination,
      path.dirname(move.destination),
      path.dirname(move.source),
    ]) ?? []),
    ...(previous?.identities.flatMap((identity) =>
      identity.folderPath ? [identity.folderPath] : []
    ) ?? []),
  ]);
  for (const item of all) {
    const dir = seriesDirectory(item);
    seriesDirs.set(item, dir);
    if (dir) pathsToResolve.add(dir);
  }
  await mapLimit(
    [...pathsToResolve].filter((file) => !resourceCache.has(file)),
    16,
    async (file) => {
      resourceCache.set(file, await archiveResourceAsync(file));
    }
  );

  const targetValues = new Set<string>();
  const incoming = new Set(
    [
      ...sourceFiles,
      ...(previous?.archives.map((archive) => archive.path) ?? []),
      ...(previous?.moves?.map((move) => move.destination) ?? []),
    ].map(cachedResource)
  );
  await mapLimit(
    targetFiles.filter((file) => !incoming.has(cachedResource(file))),
    6,
    async (file) => {
      const xml = await cachedReadComicInfo(file);
      const value = comicInfoSeries(xml);
      if (value) targetValues.add(value);
    }
  );

  const explicitIds = new Set<number>([
    ...(request.seriesId !== undefined ? [request.seriesId] : []),
    ...(request.sourceSeriesIds ?? []),
    ...(previous?.targetSeriesId !== undefined
      ? [previous.targetSeriesId]
      : []),
    ...(previous?.completedTargetSeriesId !== undefined
      ? [previous.completedTargetSeriesId]
      : []),
    ...(previous?.sourceSeriesIds ?? []),
    ...(previous?.identities.map((identity) => identity.seriesId) ?? []),
    ...(previous?.archives.flatMap((archive) =>
      archive.seriesId !== undefined ? [archive.seriesId] : []
    ) ?? []),
  ]);
  const relevantDirResources = [
    ...new Set([
      targetDir,
      ...sourceFiles.map((file) => path.dirname(file)),
      ...(previous?.archives.map((archive) => path.dirname(archive.path)) ??
        []),
      ...(previous?.moves?.map((move) => path.dirname(move.destination)) ?? []),
    ]),
  ].map(cachedResource);
  const candidateNames = new Set<string>(
    [
      request.seriesName,
      previous?.seriesName,
      lastSegment(targetDir),
      ...sourceFiles.map((file) => lastSegment(path.dirname(file))),
      ...targetValues,
    ]
      .filter((name): name is string => !!name)
      .map(kavitaNormalizeName)
      .filter(Boolean)
  );
  const candidateSeries = all.filter((item) => {
    if (explicitIds.has(item.id)) return true;
    const dir = seriesDirs.get(item) ?? null;
    if (!dir) return true;
    const dirRes = cachedResource(dir);
    if (
      relevantDirResources.some(
        (rel) => pathContains(rel, dirRes) || pathContains(dirRes, rel)
      )
    )
      return true;
    return candidateNames.has(kavitaNormalizeName(item.name));
  });

  const indexed = new Map<string, number>();
  const chapterBatches = await mapLimit(candidateSeries, 8, async (series) => ({
    seriesId: series.id,
    chapters: await (chapterCache
      ? chapterCache.load(key, series.id, () =>
          session.getChaptersBySeries(series.id)
        )
      : session.getChaptersBySeries(series.id)),
  }));
  const indexedFiles: { seriesId: number; local: string }[] = [];
  for (const { seriesId, chapters } of chapterBatches) {
    for (const chapter of chapters) {
      for (const file of chapter.files ?? []) {
        if (!file.filePath)
          throw new ProtectedMergeError(
            "Kavita returned an archive without a path; review cannot establish protection"
          );
        const local = map(file.filePath);
        if (!local)
          throw new ProtectedMergeError(
            "Map Kavita library paths before reviewing this merge"
          );
        indexedFiles.push({ seriesId, local });
      }
    }
  }
  await mapLimit(
    [...new Set(indexedFiles.map((item) => item.local))].filter(
      (file) => !resourceCache.has(file)
    ),
    16,
    async (file) => {
      resourceCache.set(file, await archiveResourceAsync(file));
    }
  );
  for (const { seriesId, local } of indexedFiles) {
    const identity = cachedResource(local);
    const owner = indexed.get(identity);
    if (owner !== undefined && owner !== seriesId) {
      throw new ProtectedMergeError(
        "An archive is indexed under multiple series; rescan Kavita before merging"
      );
    }
    indexed.set(identity, seriesId);
  }

  const targetOwners = new Set(
    targetFiles
      .map((file) => indexed.get(cachedResource(file)))
      .filter((id): id is number => id !== undefined)
  );
  if (target) targetOwners.add(target.id);
  if (targetOwners.size > 1)
    throw new ProtectedMergeError(
      "Target folder contains multiple indexed series; resolve their grouping before merging"
    );
  if (!target && targetOwners.size)
    target = all.find((series) => series.id === [...targetOwners][0]);
  if (!target) {
    const targetKey = cachedResource(targetDir);
    const candidates = all.filter((series) => {
      const local = seriesDirs.get(series) ?? null;
      return local !== null && cachedResource(local) === targetKey;
    });
    if (candidates.length > 1)
      throw new ProtectedMergeError(
        "Multiple indexed series share this target folder; rescan and resolve grouping first"
      );
    target = candidates[0];
  }

  const savedArchives = new Map(
    previous?.archives.map((item) => [
      cachedResource(item.path),
      item.seriesId,
    ]) ?? []
  );
  const archives: MergeProtectionState["archives"] = [];
  const sourceIds = new Set(previous?.sourceSeriesIds ?? []);
  let unassociatedArchives = 0;
  for (const file of sourceFiles) {
    if (
      !allowed(file) ||
      !resolveExistingFile(file) ||
      !file.toLowerCase().endsWith(".cbz")
    ) {
      throw new ProtectedMergeError(
        `Source archive is missing or outside allowed folders: ${file}`
      );
    }
    const identity = cachedResource(file);
    const current = indexed.get(identity);
    const saved = savedArchives.get(identity);
    if (
      saved !== undefined &&
      current !== undefined &&
      current !== saved &&
      current !== target?.id &&
      current !== previous?.targetSeriesId &&
      current !== previous?.completedTargetSeriesId
    ) {
      throw new ProtectedMergeError(
        "Archive ownership changed since this merge began"
      );
    }
    const owner = saved ?? current;
    archives.push({
      path: canonicalMergePath(file),
      ...(owner === undefined ? {} : { seriesId: owner }),
    });
    if (owner !== undefined && owner !== target?.id) sourceIds.add(owner);
    if (owner === undefined) unassociatedArchives++;
  }
  for (const id of request.sourceSeriesIds ?? []) {
    if (
      !archives.some((file) => file.seriesId === id) &&
      !previous?.sourceSeriesIds.includes(id)
    ) {
      throw new ProtectedMergeError(
        "Selected source series does not own an incoming indexed archive; refresh the file list"
      );
    }
  }
  if (!request.seriesName && targetValues.size > 1) {
    throw new ProtectedMergeError(
      "Target archives disagree on ComicInfo.Series; choose a name after reviewing their protection"
    );
  }
  const seriesName =
    request.seriesName ??
    [...targetValues][0] ??
    previous?.seriesName ??
    target?.name ??
    lastSegment(targetDir);
  const series: MergeProtectionSeries[] = [];
  const policies = new Map(
    previous?.policies.map((policy) => [policy.seriesId, policy]) ?? []
  );
  const relevant = new Set([
    ...sourceIds,
    ...(target ? [target.id] : []),
    ...(previous?.targetSeriesId ? [previous.targetSeriesId] : []),
  ]);
  const policyMap = getFieldPolicies([...relevant]);
  const identities = new Map(
    previous?.identities.map((identity) => [identity.seriesId, identity]) ?? []
  );
  for (const id of relevant) {
    const live = all.find((item) => item.id === id);
    const policy = policyMap.get(id) ?? { lockedFields: [], revision: 0 };
    if (live) {
      const folder = seriesDirs.get(live) ?? null;
      const identity = identities.get(id);
      const regrouped =
        id === target?.id &&
        !!folder &&
        cachedResource(folder) === cachedResource(targetDir) &&
        archives.some(
          (archive) =>
            archive.seriesId === id &&
            pathContains(
              cachedResource(targetDir),
              cachedResource(archive.path)
            ) &&
            indexed.get(cachedResource(archive.path)) === id
        );
      if (
        identity &&
        (identity.libraryId !== live.libraryId ||
          (identity.folderPath &&
            (!folder ||
              cachedResource(identity.folderPath) !==
                cachedResource(folder)))) &&
        !regrouped
      ) {
        throw new ProtectedMergeError(
          "Indexed series identity changed since this merge began; refresh before retrying"
        );
      }
      identities.set(id, {
        seriesId: id,
        libraryId: live.libraryId,
        ...(folder ? { folderPath: canonicalMergePath(folder) } : {}),
      });
    }
    const old = policies.get(id);
    // Retained evidence remains necessary after Kavita deletes/reassigns a source ID.
    const lockedFields =
      policy.revision === 0 && old ? old.lockedFields : policy.lockedFields;
    policies.set(id, { seriesId: id, revision: policy.revision, lockedFields });
    const role =
      id === target?.id || id === previous?.targetSeriesId
        ? "target"
        : "source";
    let titleChange =
      role === "source"
        ? !!live && live.name !== seriesName
        : !!request.seriesName && !!live && live.name !== seriesName;
    const affected = archives
      .filter((file) => file.seriesId === id)
      .map((file) => file.path);
    if (role === "target" && request.seriesName) affected.push(...targetFiles);
    const affectedXml = await mapLimit(
      [...new Set(affected)],
      6,
      cachedReadComicInfo
    );
    if (affectedXml.some((xml) => comicInfoSeries(xml) !== seriesName))
      titleChange = true;
    series.push({
      seriesId: id,
      libraryId: live?.libraryId ?? previous?.libraryId ?? 0,
      name: live?.name ?? `Previous source series #${id}`,
      role,
      titleChange,
      lockedFields,
      revision: policy.revision,
    });
  }

  const inheritedFields = PROTECTABLE_FIELDS.filter((field) =>
    [...policies.values()].some((policy) => policy.lockedFields.includes(field))
  );
  if (kavitaPort.connectionKey() !== key)
    throw new ProtectedMergeError(
      "Kavita connection changed during merge review"
    );
  const warnings = unassociatedArchives
    ? [
        `${unassociatedArchives} incoming archive(s) have no indexed series policy. New downloads are also outside source series protection until indexed.`,
      ]
    : [];
  const blocked = series.filter(
    (item) => item.titleChange && item.lockedFields.includes("title")
  );
  if (blocked.length) {
    warnings.push(
      "A protected title would change in ComicInfo.Series or Kavita. Explicitly unlock each affected title, then refresh this review."
    );
  }
  const containingLibraries = libraries.filter((lib) =>
    (lib.paths ?? (lib.path ? [lib.path] : [])).some((root) => {
      const local = map(root);
      return (
        !!local &&
        pathContains(canonicalMergePath(local), canonicalMergePath(targetDir))
      );
    })
  );
  if (containingLibraries.length > 1) {
    throw new ProtectedMergeError(
      "Multiple Kavita libraries contain this target folder; choose an unambiguous mapped library before merging"
    );
  }
  const libraryId = target?.libraryId ?? containingLibraries[0]?.id;
  const indexable =
    libraryId !== undefined || (!sourceIds.size && !inheritedFields.length);
  if (libraryId === undefined) {
    warnings.push(
      indexable
        ? "This output folder is outside mapped Kavita libraries. These unassociated archives can be merged locally, but no indexed series or inherited policy is claimed."
        : "Choose a mapped Kavita library folder before merging indexed sources or inheriting protection."
    );
  }
  const state: MergeProtectionState = {
    connectionKey: key,
    sourceSeriesIds: [...sourceIds],
    targetSeriesId: target?.id ?? previous?.targetSeriesId,
    policies: [...policies.values()],
    inheritedFields,
    seriesName,
    targetDir,
    libraryId,
    archives,
    identities: [...identities.values()],
    completedTargetSeriesId: previous?.completedTargetSeriesId,
    rootJobId: previous?.rootJobId,
    moves: previous?.moves,
  };
  return {
    preview: {
      series,
      inheritedFields,
      unassociatedArchives,
      canQueue: !blocked.length && indexable,
      warnings,
    },
    state,
    targetDir,
    libraryId,
  };
}

export function requireMergeAuthority(preview: MergeProtectionPreview): void {
  if (!preview.canQueue) {
    throw new ProtectedMergeError(
      preview.warnings.join(" ") ||
        "Merge protection could not be verified; refresh the review before queueing or retrying"
    );
  }
}
