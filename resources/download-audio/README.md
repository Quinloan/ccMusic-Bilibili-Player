# Audio saving component

Unmodified BtbN Windows x64 LGPL FFmpeg, invoked as a separate, replaceable executable. It is not linked into ccMusic.

- Binary version: N-127579-g5cb9fcd211-20261016.
- License: LGPL-3.0-or-later. Both LGPLv3 and the incorporated GPLv3 texts are included.
- Binary/archive SHA256, exact FFmpeg revision and build-recipe revision: download-manifest.json.
- Exact FFmpeg source plus build recipes, pinned dependency source URLs/hashes and build configuration: [source materials](https://github.com/Quinloan/ccMusic-Bilibili-Player/releases/download/v1.6.0-beta.1/ccMusic-FFmpeg-source-provenance-1.6.0-beta.1.zip).
- Build recipes: https://github.com/BtbN/FFmpeg-Builds/tree/63ac3265b0789ea16c7b1f8351cd2ad195a28722
- FFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/5cb9fcd21167cf2f5a2852ea582997bbd0055521

The upstream build recipes specify the third-party dependency source revisions and download hashes. Follow those recipes for rebuilding or obtaining dependency sources; keep this notice and the licenses when redistributing the component. Build configuration is also available with ffmpeg.exe -buildconf. The application does not download executable code at runtime.
