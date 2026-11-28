// SPDX-License-Identifier: MPL-2.0
/**
 * Changing the version and the stored form of the extensions a project uses.
 *
 * This is the shared core behind `sb3-toolchain extensions list-sb3 / update-sb3` and the Editor's
 * project properties. It runs in a browser and in Node alike: it takes an unpacked archive and a
 * parsed project, reaches the network only through the ports it is given, and never touches a
 * file, a VM or an approval.
 *
 * It works in two steps that a host keeps apart. `planProjectExtensionUpdate` resolves and
 * verifies every candidate and reports what would change and why it may not; it changes nothing.
 * `applyProjectExtensionUpdate` takes that plan and the same input, checks the input has not
 * changed and the candidates are still the bytes the plan showed, and returns a new archive and
 * project. Neither changes its input, and a failure in any extension applies none.
 *
 * Nothing here is guessed. A source is known only from the project's own extension lock whose
 * digest matches the code it holds, or from a reference the caller names: an ID, a name or a URL
 * never identifies a package. No extension JavaScript is evaluated, and no result grants
 * execution: a host asks its own trust provider about the code it is going to run.
 */

import {lt, valid} from 'semver';
import {
  sb3SaveCapabilities,
  type Sb3SaveCapabilities,
  type Sb3SaveFormat,
} from '@kubohiroya/turbowarp-sb3-save-format';
import {
  convertSb3ExtensionFormats,
  extensionDataUrl,
  readSb3Extensions,
  type Sb3ExtensionFormatChange,
  type Sb3ExtensionPayload,
} from '@kubohiroya/turbowarp-sb3-save-format/extension-format';
import {
  artifactSHA256,
  extensionLocksEntry,
  lockPublishedExtension,
  validateExtensionArtifactLock,
  type ExtensionArtifactLock,
} from './extension-artifact-lock';
import {
  compareExtensionApiManifests,
  parseExtensionApiManifest,
  type ExtensionApiCompatibilityChange,
} from './extension-api-manifest';
import {
  resolvePublishedExtension,
  type PublishedExtension,
  type PublishedExtensionSource,
} from './web-distribution';

export type ProjectArchive = Readonly<Record<string, Uint8Array>>;
export type ProjectDocument = Readonly<Record<string, unknown>>;

/** Raised when a plan cannot be applied, or a request cannot be read. */
export class ProjectExtensionError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = 'ProjectExtensionError';
    this.code = code;
  }
}

export type ProjectExtensionDiagnosticCode =
  | 'SOURCE_UNKNOWN'
  | 'LEGACY_DATA_URL'
  | 'LOCK_STALE'
  | 'LOCK_INVALID'
  | 'RESOLVE_FAILED'
  | 'ID_MISMATCH'
  | 'PRERELEASE'
  | 'PRERELEASE_NOT_REQUESTED'
  | 'DOWNGRADE'
  | 'API_UNVERIFIED'
  | 'API_CHANGED'
  | 'API_BREAKING'
  | 'BLOCK_IN_USE_REMOVED'
  | 'EXECUTION_WIDENED'
  | 'EXECUTION_NARROWED'
  | 'DEPENDENCY_MISSING'
  | 'URL_REQUIRED'
  | 'REMOTE_UNVERIFIED'
  | 'REMOTE_MISMATCH'
  | 'REMOTE_ADDRESS_GUESSED';

export interface ProjectExtensionDiagnostic {
  readonly code: ProjectExtensionDiagnosticCode;
  /** `error` blocks the step; `warning` needs the person's attention; `info` explains. */
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** Where the code came from, as far as the project's own record shows. */
export type ProjectExtensionSource =
  | Readonly<{kind: 'npm'; package: string; version: string}>
  | Readonly<{kind: 'github'; repository: string; tag: string}>
  | Readonly<{kind: 'build'}>
  | Readonly<{kind: 'unknown'}>;

export interface ProjectExtension {
  readonly id: string;
  readonly format: Sb3SaveFormat;
  readonly sha256: string;
  /** Size of the code the SB3 holds; absent for a reference. */
  readonly byteLength?: number;
  readonly url?: string;
  readonly version?: string;
  readonly execution: 'sandboxed' | 'unsandboxed';
  readonly dependencies: readonly string[];
  readonly source: ProjectExtensionSource;
  readonly diagnostics: readonly ProjectExtensionDiagnostic[];
}

interface ReadState {
  readonly payloads: readonly Sb3ExtensionPayload[];
  readonly locks: ReadonlyMap<string, ExtensionArtifactLock>;
  readonly extensions: readonly ProjectExtension[];
}

const diagnostic = (
  code: ProjectExtensionDiagnosticCode,
  severity: ProjectExtensionDiagnostic['severity'],
  message: string,
): ProjectExtensionDiagnostic => Object.freeze({code, severity, message});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLocks(archive: ProjectArchive): {
  locks: Map<string, ExtensionArtifactLock>;
  invalid: string | undefined;
} {
  const locks = new Map<string, ExtensionArtifactLock>();
  const bytes = archive[extensionLocksEntry];
  if (!bytes) return {locks, invalid: undefined};
  try {
    const document: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!isRecord(document) || document.formatVersion !== 1 || !Array.isArray(document.extensions))
      throw new Error('Unsupported extension locks attachment');
    for (const record of document.extensions) {
      if (!isRecord(record) || typeof record.id !== 'string')
        throw new Error('Invalid extension lock');
      validateExtensionArtifactLock(record.artifactLock, record.id);
      locks.set(record.id, record.artifactLock);
    }
    return {locks, invalid: undefined};
  } catch (error) {
    return {locks: new Map(), invalid: error instanceof Error ? error.message : String(error)};
  }
}

function sourceOf(lock: ExtensionArtifactLock | undefined): ProjectExtensionSource {
  if (!lock) return {kind: 'unknown'};
  if (lock.provenance.kind === 'build') return {kind: 'build'};
  const source = lock.provenance.source;
  return source.provider === 'npm'
    ? {kind: 'npm', package: source.package, version: source.version}
    : {kind: 'github', repository: source.repository, tag: source.tag};
}

async function read(archive: ProjectArchive, project: ProjectDocument): Promise<ReadState> {
  const payloads = await readSb3Extensions(archive, project);
  const {locks: recorded, invalid} = readLocks(archive);
  const locks = new Map<string, ExtensionArtifactLock>();
  const extensions = payloads.map((payload): ProjectExtension => {
    const diagnostics: ProjectExtensionDiagnostic[] = [];
    if (invalid !== undefined)
      diagnostics.push(
        diagnostic(
          'LOCK_INVALID',
          'warning',
          `The extension locks attachment was not read: ${invalid}`,
        ),
      );
    if (!payload.spec)
      diagnostics.push(
        diagnostic(
          'LEGACY_DATA_URL',
          'info',
          'A data: URL without a Plus Manifest; it records no source, version or execution mode.',
        ),
      );
    let lock = recorded.get(payload.id);
    // A lock describes one set of bytes. If the project now holds other bytes, the lock says
    // nothing about where they came from.
    if (lock && lock.bundleSHA256 !== payload.sha256) {
      diagnostics.push(
        diagnostic(
          'LOCK_STALE',
          'warning',
          'The recorded source is for other bytes than the project holds.',
        ),
      );
      lock = undefined;
    }
    if (lock) locks.set(payload.id, lock);
    const source = sourceOf(lock);
    if (source.kind === 'unknown')
      diagnostics.push(
        diagnostic(
          'SOURCE_UNKNOWN',
          'info',
          'The source and version of this code are unknown. Name a published reference to update it.',
        ),
      );
    return Object.freeze({
      id: payload.id,
      format: payload.format,
      sha256: payload.sha256!,
      ...(payload.bytes ? {byteLength: payload.bytes.byteLength} : {}),
      ...(payload.url ? {url: payload.url} : {}),
      ...(payload.spec?.version ? {version: payload.spec.version} : {}),
      execution: payload.spec?.execution ?? 'sandboxed',
      dependencies: Object.freeze([...(payload.spec?.dependencies ?? [])]),
      source: Object.freeze(source),
      diagnostics: Object.freeze(diagnostics),
    });
  });
  return {payloads, locks, extensions: Object.freeze(extensions)};
}

/** Every extension the project uses, with what its own records say about it. */
export async function listProjectExtensions(
  archive: ProjectArchive,
  project: ProjectDocument,
): Promise<readonly ProjectExtension[]> {
  return (await read(archive, project)).extensions;
}

/** What to do with one extension. Leaving `version` out keeps the current code. */
export interface ProjectExtensionRequest {
  /** `latest` (the current stable release) or an exact version. */
  readonly version?: string | undefined;
  /**
   * A published reference: `npm-package@version|tag`, a GitHub Release tag URL or a GitHub
   * repository URL. Required when the project records no source for this extension.
   */
  readonly reference?: string | undefined;
  /** The form to store it in; defaults to the form it is in now. */
  readonly format?: Sb3SaveFormat | undefined;
  /** The address a reference form records; defaults to the published artifact's address. */
  readonly url?: string | undefined;
  /** Accept a prerelease that `latest` or a tag resolved to. An exact prerelease is explicit. */
  readonly allowPrerelease?: boolean | undefined;
  readonly allowBreakingApi?: boolean | undefined;
  /** Request the wider execution mode the new version declares. It is a request, not a grant. */
  readonly allowExecutionChange?: boolean | undefined;
}

export interface ProjectExtensionPlanOptions {
  readonly capabilities?: Sb3SaveCapabilities | undefined;
  /** Resolves a published reference. Defaults to `resolvePublishedExtension`. */
  readonly resolve?:
    | ((reference: string, options: {signal?: AbortSignal}) => Promise<PublishedExtension>)
    | undefined;
  /** Used to verify a reference address and to embed a reference. Defaults to `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /**
   * Fetch the address a reference form will record and require the same bytes. On by default:
   * a project must not lose its embedded copy to an address that does not serve it.
   */
  readonly verifyRemote?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * `source` records where unchanged code came from: a named reference resolved to the very bytes
 * the project holds, which is how an embedded copy of unknown origin gets one.
 */
export type ProjectExtensionChange =
  'none' | 'source' | 'format' | 'version' | 'version-and-format';

export interface ProjectExtensionPlanStep {
  readonly id: string;
  readonly change: ProjectExtensionChange;
  readonly from: Readonly<{
    format: Sb3SaveFormat;
    sha256: string;
    version?: string;
    source: ProjectExtensionSource;
  }>;
  readonly to: Readonly<{
    format: Sb3SaveFormat;
    sha256: string;
    version?: string;
    url?: string;
    source: ProjectExtensionSource;
    execution: 'sandboxed' | 'unsandboxed';
    /** The exact published reference the candidate was resolved from. */
    reference?: string;
  }>;
  readonly apiChanges: readonly ExtensionApiCompatibilityChange[];
  readonly diagnostics: readonly ProjectExtensionDiagnostic[];
  readonly blocked: boolean;
}

export interface ProjectExtensionPlan {
  /** A digest of the input the plan was made for; applying to anything else is refused. */
  readonly input: string;
  readonly steps: readonly ProjectExtensionPlanStep[];
  readonly blocked: boolean;
}

/** The resolved candidates, kept out of the plan so a plan can be shown and serialized. */
const candidatesOf = new WeakMap<ProjectExtensionPlan, ReadonlyMap<string, PublishedExtension>>();

const isReference = (format: Sb3SaveFormat) =>
  format === 'remote-cacheable' || format === 'remote-non-cacheable';
const isPrerelease = (version: string) => version.split('+')[0]!.includes('-');
const exactVersion = (value: string) => valid(value) === value.replace(/^v/u, '');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A digest of everything a plan depends on: the project document and the extension entries. */
async function fingerprint(
  archive: ProjectArchive,
  project: ProjectDocument,
  payloads: readonly Sb3ExtensionPayload[],
) {
  const parts: Uint8Array[] = [new TextEncoder().encode(JSON.stringify(project))];
  for (const path of [
    extensionLocksEntry,
    ...payloads.flatMap((payload) => (payload.path ? [payload.path] : [])),
  ].sort()) {
    parts.push(new TextEncoder().encode(`\0${path}\0`), archive[path] ?? new Uint8Array());
  }
  const all = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return sha256Hex(all);
}

/** The reference to resolve for one request, from the caller or from the project's lock. */
function referenceFor(
  request: ProjectExtensionRequest,
  lock: ExtensionArtifactLock | undefined,
): string | undefined {
  const version = request.version;
  if (request.reference !== undefined) {
    const reference = request.reference.trim();
    if (version === undefined) return reference;
    const repository = /^https:\/\/github\.com\/([\w-]+\/[\w.-]+)\/?$/u.exec(reference);
    if (repository)
      return version === 'latest'
        ? reference
        : `https://github.com/${repository[1]}/releases/tag/${version.startsWith('v') ? version : `v${version}`}`;
    if (/^https:\/\//u.test(reference)) return reference;
    const name = reference.replace(/^npm:/u, '');
    const split = name.lastIndexOf('@');
    return `${split > 0 ? name.slice(0, split) : name}@${version}`;
  }
  if (version === undefined || !lock || lock.provenance.kind !== 'published') return undefined;
  const source = lock.provenance.source;
  if (source.provider === 'npm') return `${source.package}@${version}`;
  if (version === 'latest') return `https://github.com/${source.repository}`;
  const tag = source.tag.startsWith('v') && !version.startsWith('v') ? `v${version}` : version;
  return `https://github.com/${source.repository}/releases/tag/${tag}`;
}

/**
 * The address a reference form records for a published artifact: the immutable commit file a
 * GitHub Release was verified against, or the exact npm version on jsDelivr. The npm address is
 * a convention, so the plan says so and verifies it before anything relies on it.
 */
export function publishedExtensionURL(candidate: PublishedExtension): string {
  if (candidate.sourceURL) return candidate.sourceURL;
  const source = candidate.source as Extract<PublishedExtensionSource, {provider: 'npm'}>;
  return `https://cdn.jsdelivr.net/npm/${source.package}@${source.version}/dist/${candidate.distribution.bundle.file}`;
}

function usedOpcodes(project: ProjectDocument, id: string): Set<string> {
  const used = new Set<string>();
  const prefix = `${id}_`;
  for (const target of Array.isArray(project.targets) ? project.targets : []) {
    if (!isRecord(target) || !isRecord(target.blocks)) continue;
    for (const block of Object.values(target.blocks)) {
      if (!isRecord(block) || typeof block.opcode !== 'string' || !block.opcode.startsWith(prefix))
        continue;
      const opcode = block.opcode.slice(prefix.length);
      // A menu is a shadow block the extension generates from its own menus, not one the author placed.
      if (!opcode.startsWith('menu_')) used.add(opcode);
    }
  }
  return used;
}

async function verifyAddress(
  url: string,
  expected: string,
  fetchBytes: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchBytes(url, {
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return `HTTP ${response.status}`;
    const actual = await sha256Hex(new Uint8Array(await response.arrayBuffer()));
    return actual === expected ? undefined : `serves sha256 ${actual}`;
  } catch (error) {
    signal?.throwIfAborted();
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Resolve, verify and check every requested change, without changing anything.
 *
 * Every extension named in `requests` gets a step, including ones that cannot change: the step
 * says why. Extensions not named are not touched. A step is `blocked` when an error diagnostic
 * applies; `allow*` options turn the matching errors into warnings, never into silence.
 */
export async function planProjectExtensionUpdate(
  archive: ProjectArchive,
  project: ProjectDocument,
  requests: Readonly<Record<string, ProjectExtensionRequest>>,
  {
    resolve = (reference, options) => resolvePublishedExtension(reference, options),
    fetch: fetchBytes = globalThis.fetch,
    verifyRemote = true,
    signal,
    timeoutMs = 30_000,
  }: ProjectExtensionPlanOptions = {},
): Promise<ProjectExtensionPlan> {
  const state = await read(archive, project);
  const byId = new Map(state.extensions.map((extension) => [extension.id, extension]));
  const steps: ProjectExtensionPlanStep[] = [];
  const candidates = new Map<string, PublishedExtension>();
  for (const [id, request] of Object.entries(requests)) {
    const current = byId.get(id);
    if (!current)
      throw new ProjectExtensionError(`Extension ${id} is not used by this project.`, 'NOT_USED');
    if (
      request.version !== undefined &&
      request.version !== 'latest' &&
      !exactVersion(request.version)
    )
      throw new ProjectExtensionError(
        `Version for ${id} must be "latest" or an exact version.`,
        'INVALID_VERSION',
      );
    const diagnostics: ProjectExtensionDiagnostic[] = [];
    const lock = state.locks.get(id);
    const targetFormat = request.format ?? current.format;
    let apiChanges: ExtensionApiCompatibilityChange[] = [];
    let candidate: PublishedExtension | undefined;
    let reference: string | undefined;
    const wantsVersion = request.version !== undefined || request.reference !== undefined;
    if (wantsVersion) {
      reference = referenceFor(request, lock);
      if (reference === undefined) {
        diagnostics.push(
          diagnostic(
            'SOURCE_UNKNOWN',
            'error',
            'The project records no source for this code; name a published reference.',
          ),
        );
      } else {
        try {
          candidate = await resolve(reference, signal ? {signal} : {});
        } catch (error) {
          signal?.throwIfAborted();
          diagnostics.push(
            diagnostic(
              'RESOLVE_FAILED',
              'error',
              `${reference}: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
    }
    let toSha = current.sha256;
    let toVersion = current.version;
    let toSource = current.source;
    let execution = current.execution;
    if (candidate) {
      const {distribution} = candidate;
      if (distribution.id !== id)
        diagnostics.push(
          diagnostic(
            'ID_MISMATCH',
            'error',
            `${reference} publishes extension ${distribution.id}, not ${id}.`,
          ),
        );
      const exactRequest = request.version !== undefined && request.version !== 'latest';
      if (isPrerelease(distribution.version)) {
        if (exactRequest)
          diagnostics.push(
            diagnostic(
              'PRERELEASE',
              'warning',
              `${distribution.version} is a prerelease, requested explicitly.`,
            ),
          );
        else
          diagnostics.push(
            diagnostic(
              'PRERELEASE_NOT_REQUESTED',
              request.allowPrerelease ? 'warning' : 'error',
              `${reference} resolved to the prerelease ${distribution.version}, which is not a stable release.`,
            ),
          );
      }
      if (current.version && valid(current.version) && lt(distribution.version, current.version))
        diagnostics.push(
          diagnostic(
            'DOWNGRADE',
            'info',
            `Goes back from ${current.version} to ${distribution.version}.`,
          ),
        );
      toSha = artifactSHA256(candidate.bytes);
      toVersion = distribution.version;
      toSource = sourceOf(lockPublishedExtension(candidate));
      candidates.set(id, candidate);
      if (toSha !== current.sha256) {
        const next = parseExtensionApiManifest(candidate.apiBytes, {expectedId: id});
        const used = usedOpcodes(project, id);
        const removed = [...used].filter(
          (opcode) => !next.blocks.some((block) => block.opcode === opcode),
        );
        if (removed.length)
          diagnostics.push(
            diagnostic(
              'BLOCK_IN_USE_REMOVED',
              request.allowBreakingApi ? 'warning' : 'error',
              `Blocks used by this project are not in ${distribution.version}: ${removed.join(', ')}.`,
            ),
          );
        if (lock) {
          apiChanges = compareExtensionApiManifests(
            parseExtensionApiManifest(lock.apiJSON, {expectedId: id}),
            next,
          );
          const breaking = apiChanges.filter((change) => change.breaking);
          if (breaking.length)
            diagnostics.push(
              diagnostic(
                'API_BREAKING',
                request.allowBreakingApi ? 'warning' : 'error',
                `${breaking.length} breaking API change(s): ${breaking.map((change) => `${change.kind} ${change.path}`).join(', ')}.`,
              ),
            );
          else if (apiChanges.length)
            diagnostics.push(
              diagnostic('API_CHANGED', 'info', `${apiChanges.length} compatible API change(s).`),
            );
        } else {
          diagnostics.push(
            diagnostic(
              'API_UNVERIFIED',
              'warning',
              'The project records no API for the current code, so only the blocks it uses could be checked.',
            ),
          );
        }
        if (distribution.execution === 'unsandboxed' && current.execution === 'sandboxed') {
          diagnostics.push(
            diagnostic(
              'EXECUTION_WIDENED',
              request.allowExecutionChange ? 'warning' : 'error',
              `${distribution.version} declares unsandboxed execution. Requesting it is not permission: the host still asks.`,
            ),
          );
          if (request.allowExecutionChange) execution = 'unsandboxed';
        } else if (distribution.execution === 'sandboxed' && current.execution === 'unsandboxed') {
          diagnostics.push(
            diagnostic('EXECUTION_NARROWED', 'info', `${distribution.version} runs sandboxed.`),
          );
          execution = 'sandboxed';
        }
      }
    }
    for (const dependency of current.dependencies)
      if (!byId.has(dependency))
        diagnostics.push(
          diagnostic(
            'DEPENDENCY_MISSING',
            'warning',
            `Declared dependency ${dependency} is not in this project.`,
          ),
        );

    const versionChanges = toSha !== current.sha256;
    let url: string | undefined =
      request.url ?? (versionChanges && candidate ? publishedExtensionURL(candidate) : current.url);
    if (!request.url && !versionChanges && candidate && !current.url)
      url = publishedExtensionURL(candidate);
    if (isReference(targetFormat) || versionChanges) {
      if (!url && isReference(targetFormat))
        diagnostics.push(
          diagnostic(
            'URL_REQUIRED',
            'error',
            `Saving as ${targetFormat} needs the address of these exact bytes.`,
          ),
        );
      else if (
        url &&
        !request.url &&
        candidate &&
        !candidate.sourceURL &&
        isReference(targetFormat)
      )
        diagnostics.push(
          diagnostic(
            'REMOTE_ADDRESS_GUESSED',
            'info',
            `Using the jsDelivr address of the npm version: ${url}`,
          ),
        );
    }
    const formatChanges = targetFormat !== current.format;
    if (
      url &&
      isReference(targetFormat) &&
      (formatChanges || versionChanges || url !== current.url)
    ) {
      if (verifyRemote) {
        const problem = await verifyAddress(url, toSha, fetchBytes, timeoutMs, signal);
        if (problem !== undefined)
          diagnostics.push(
            diagnostic(
              'REMOTE_MISMATCH',
              'error',
              `${url} does not serve these bytes: ${problem}.`,
            ),
          );
      } else {
        diagnostics.push(
          diagnostic('REMOTE_UNVERIFIED', 'warning', `${url} was not checked against the bytes.`),
        );
      }
    }
    const change: ProjectExtensionChange = versionChanges
      ? formatChanges
        ? 'version-and-format'
        : 'version'
      : formatChanges
        ? 'format'
        : candidate && !lock
          ? 'source'
          : url !== undefined && url !== current.url
            ? 'format'
            : 'none';
    steps.push(
      Object.freeze({
        id,
        change,
        from: Object.freeze({
          format: current.format,
          sha256: current.sha256,
          ...(current.version ? {version: current.version} : {}),
          source: current.source,
        }),
        to: Object.freeze({
          format: targetFormat,
          sha256: toSha,
          ...(toVersion ? {version: toVersion} : {}),
          ...(url ? {url} : {}),
          source: toSource,
          execution,
          ...(candidate && reference ? {reference} : {}),
        }),
        apiChanges: Object.freeze(apiChanges),
        diagnostics: Object.freeze(diagnostics),
        blocked: diagnostics.some((item) => item.severity === 'error'),
      }),
    );
  }
  signal?.throwIfAborted();
  const plan: ProjectExtensionPlan = Object.freeze({
    input: await fingerprint(archive, project, state.payloads),
    steps: Object.freeze(steps),
    blocked: steps.some((step) => step.blocked),
  });
  candidatesOf.set(plan, candidates);
  return plan;
}

export interface ProjectExtensionApplyOptions {
  readonly capabilities?: Sb3SaveCapabilities | undefined;
  /** Used only to embed a reference whose bytes the plan did not already hold. */
  readonly fetch?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface ProjectExtensionUpdate {
  readonly archive: ProjectArchive;
  readonly project: Record<string, unknown>;
  readonly applied: readonly ProjectExtensionPlanStep[];
}

/**
 * Apply a plan to the input it was made for and return the new archive and project.
 *
 * Refused if the plan is blocked, was made for other input, or was not made by
 * `planProjectExtensionUpdate` in this process (its candidates are not serialized). A new version
 * replaces the code and its lock; a form change keeps both. The approval a host recorded for the
 * old digest does not cover the new one, because the digest is what it was recorded for.
 */
export async function applyProjectExtensionUpdate(
  archive: ProjectArchive,
  project: ProjectDocument,
  plan: ProjectExtensionPlan,
  {
    capabilities = sb3SaveCapabilities(),
    fetch: fetchBytes = globalThis.fetch,
    signal,
    timeoutMs = 30_000,
  }: ProjectExtensionApplyOptions = {},
): Promise<ProjectExtensionUpdate> {
  const candidates = candidatesOf.get(plan);
  if (!candidates)
    throw new ProjectExtensionError('This plan was not made here; plan again.', 'PLAN_UNKNOWN');
  if (plan.blocked) throw new ProjectExtensionError('The plan has blocked steps.', 'PLAN_BLOCKED');
  const state = await read(archive, project);
  if ((await fingerprint(archive, project, state.payloads)) !== plan.input)
    throw new ProjectExtensionError(
      'The project changed after the plan was made; plan again.',
      'PLAN_STALE',
    );
  const steps = plan.steps.filter((step) => step.change !== 'none');
  if (!steps.length)
    return Object.freeze({archive, project: {...project}, applied: Object.freeze([])});

  const nextArchive: Record<string, Uint8Array> = {...archive};
  const nextProject: Record<string, unknown> = {...project};
  const urls: Record<string, unknown> = isRecord(project.extensionURLs)
    ? {...project.extensionURLs}
    : {};
  const manifest = isRecord(project.turboWarpPlus) ? project.turboWarpPlus : undefined;
  let specs: Record<string, unknown>[] = Array.isArray(manifest?.extensions)
    ? (manifest.extensions as Record<string, unknown>[]).map((spec) => ({...spec}))
    : [];
  const locks = new Map(readLocks(archive).locks);
  const payloadById = new Map(state.payloads.map((payload) => [payload.id, payload]));
  const changes: Record<string, Sb3ExtensionFormatChange> = {};

  for (const step of steps) {
    const payload = payloadById.get(step.id)!;
    const candidate = candidates.get(step.id);
    // What is applied is what was shown: the same bytes, digest and source.
    if (candidate && artifactSHA256(candidate.bytes) !== step.to.sha256)
      throw new ProjectExtensionError(
        `The candidate for ${step.id} is not the one the plan showed.`,
        'PLAN_MISMATCH',
      );
    if (step.change === 'format' || step.change === 'source') {
      changes[step.id] = {
        format: step.to.format,
        ...(step.to.url ? {url: step.to.url} : {}),
        ...(step.to.version ? {version: step.to.version} : {}),
      };
      // A reference that resolved to these very bytes is now their recorded source.
      if (candidate) locks.set(step.id, lockPublishedExtension(candidate));
      continue;
    }
    if (!candidate)
      throw new ProjectExtensionError(
        `The candidate for ${step.id} is not the one the plan showed.`,
        'PLAN_MISMATCH',
      );
    // Write the new code as a data: carrier first; the form change below takes it where it goes.
    urls[step.id] = extensionDataUrl(candidate.bytes);
    if (payload.path) delete nextArchive[payload.path];
    const spec = {
      id: step.id,
      source: {type: 'embedded-data', ...(step.to.url ? {url: step.to.url} : {})},
      execution: step.to.execution,
      sha256: step.to.sha256,
      version: candidate.distribution.version,
      ...(payload.spec?.publisher === undefined ? {} : {publisher: payload.spec.publisher}),
      capabilities: [...(payload.spec?.capabilities ?? [])],
      dependencies: [...(payload.spec?.dependencies ?? [])],
    };
    const index = specs.findIndex((item) => item.id === step.id);
    if (index >= 0) specs[index] = spec;
    else specs = [...specs, spec];
    locks.set(step.id, lockPublishedExtension(candidate));
    if (step.to.format !== 'embedded-data')
      changes[step.id] = {format: step.to.format, ...(step.to.url ? {url: step.to.url} : {})};
  }
  nextProject.extensionURLs = urls;
  if (specs.length)
    nextProject.turboWarpPlus = {...(manifest ?? {}), schemaVersion: 1, extensions: specs};
  if (locks.size) {
    const order = state.payloads.map((payload) => payload.id).filter((id) => locks.has(id));
    for (const id of locks.keys()) if (!order.includes(id)) order.push(id);
    nextArchive[extensionLocksEntry] = new TextEncoder().encode(
      `${JSON.stringify({formatVersion: 1, extensions: order.map((id) => ({id, artifactLock: locks.get(id)}))})}\n`,
    );
  }
  signal?.throwIfAborted();
  const converted = Object.keys(changes).length
    ? await convertSb3ExtensionFormats(nextArchive, nextProject, changes, {
        capabilities,
        fetch: fetchBytes,
        timeoutMs,
        ...(signal ? {signal} : {}),
      })
    : {archive: nextArchive, project: nextProject};
  // The result must read back as the plan said: every step's form and digest.
  const check = await readSb3Extensions(converted.archive, converted.project);
  for (const step of steps) {
    const result = check.find((payload) => payload.id === step.id);
    if (!result || result.format !== step.to.format || result.sha256 !== step.to.sha256)
      throw new ProjectExtensionError(
        `Extension ${step.id} did not end up as planned.`,
        'APPLY_MISMATCH',
      );
  }
  return Object.freeze({
    archive: Object.freeze({...converted.archive}),
    project: converted.project,
    applied: Object.freeze(steps),
  });
}
