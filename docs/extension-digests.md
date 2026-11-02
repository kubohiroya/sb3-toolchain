# Extension digests and retention forms

```bash
sb3-toolchain extensions digests project.sb3 [another.sb3 ...] [--json]
```

Reads what each SB3 says about itself and reports, for every extension its manifest names:

- the extension ID,
- the pinned `sha256`,
- which of the four retention forms the author chose — `remote-non-cacheable`, `remote-cacheable`,
  `embedded-file`, or `embedded-data`,
- the number of bytes the archive actually holds for it,
- the digest of those held bytes, when it differs from the pinned one,
- the recorded URL and, for `embedded-file`, the archive entry path,
- the requested execution mode.

It also reports the project's own `uri`, which is the name a browser's caches and the opener's
recorded decisions are filed under, and, given more than one SB3, which digests several of those
projects name and which belong to a single project.

## What this command cannot do

**It does not read browser storage.** An extension cache lives in IndexedDB, which belongs to an
origin _and_ to a browser profile, so no command line can reach the cache the person running it
actually has — driving a fresh automated browser would only show a profile nobody uses. Only the
browser knows which projects it has cached, so listing and deleting belong to the screen in
[`kubohiroya/turbowarp-title-menu#23`](https://github.com/kubohiroya/turbowarp-title-menu/issues/23).
This command produces the list to compare that state against.

**It never decides anything by reachability.** A project URI returns nothing until its author
publishes there, so a work saved but never published and a published work whose address rotted look
exactly alike. No URL in an SB3 is contacted, and nothing is ever treated as absent because a
request failed. An input that was not given is unknown, not absent.

## What the report is for

1. Deciding what belongs in the shared bucket: a digest several projects name is a copy worth
   keeping once rather than per project.
2. Feeding the title-menu screen's "remove caches no project still names" mode with the set of
   digests the projects on hand actually name.
3. Finding entries left behind after a project was converted from `remote-cacheable` to
   `remote-non-cacheable`. Only `remote-cacheable` can ever leave a copy in a browser, so a digest
   whose `cacheable` is false across every input is one no project still asks to be retained. An
   author who decided those bytes should not be kept has had that decision undone if a browser
   keeps them anyway.

## Reading the output

The text report prints one `key=value; ...` line per extension, then one line per distinct digest
labelled `Shared` (named by more than one input) or `Single`. `size=not-held` means the SB3 carries
only a reference, so the bytes are not there to measure — not that they are missing. `--json` emits
the same inventory as JSON, with `projects` in input order and `digests` sorted by digest.

## JavaScript API

```js
import {inventoryExtensionDigests} from '@kubohiroya/sb3-toolchain';

const inventory = await inventoryExtensionDigests(['one.sb3', 'two.sb3']);

for (const usage of inventory.digests) {
  if (!usage.cacheable) {
    // No input keeps these bytes in the one form a browser may retain.
    console.log(
      usage.sha256,
      usage.ids,
      usage.projects.map((project) => project.uri),
    );
  }
}
```

`inspectSb3ExtensionDigests(inputPath, contents)` reports one already-read archive, and
`readProjectManifest(project)` validates just the `turboWarpPlus` member of a parsed `project.json`,
returning `null` when a project carries no manifest. A manifest written before the four names
existed is refused by naming what replaces each retired spelling, rather than translated into a
choice its author never made.

## Limits

Inputs are accepted up to 64 MiB compressed, 256 MiB expanded, and 4096 ZIP entries, with at most
64 extensions per manifest. Duplicate inputs, symbolic links, and non-`.sb3` paths are refused.
