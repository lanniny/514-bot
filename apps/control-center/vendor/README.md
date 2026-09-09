# PptxGenJS Compatibility Package

The `pptxgenjs-4.0.1-514cc.1.tgz` package is derived from the official npm
`pptxgenjs@4.0.1` tarball. Its published JavaScript, declarations, browser builds,
documentation and MIT license are byte-for-byte unchanged. Only package.json is
changed: a local patch version is recorded and the unused image-size dependency
is removed. This is a dependency-closure patch, not a repaired image parser.

The installed Office integration uses the CommonJS entry point, which does not
load image-size. It builds text and notes without exposing arbitrary image
parser options. Tests must keep the dependency unloaded and continue generating
valid presentations. New upstream versions or image-processing paths require a
fresh reachability review; do not blindly reuse this patch.

Provenance records the official SHA-512 integrity, upstream/output SHA-256 and
every unchanged file hash. Regenerate with `npm run vendor:pptx`. Installation
uses the local archive through package-lock.json; do not edit node_modules.

Reviewed advisories: GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq. The upstream
image-size package remains vulnerable; this application no longer depends on it
through PptxGenJS. No general exemption or audit suppression is configured.
