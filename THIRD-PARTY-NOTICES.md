# Recognition components

## Artwork colour matching

`cover-palette.cjs` uses the unmodified `@material/material-color-utilities` 0.3.0 package (Copyright Google LLC, Apache-2.0) for deterministic Wu quantization and Score seed selection. The dependency includes its full Apache-2.0 LICENSE. Source: https://github.com/material-foundation/material-color-utilities . It runs locally; no account, external colour service or runtime download is used. ccMusic uses the selected RGB colour directly as an opaque background (option A), pairs text/buttons by contrast, and counts populations against the quantized palette. Random-initialized Celebi/WSMeans refinement is not used. The design comparison script shares the production extraction and direct-colour theme functions; its optional B/C alternatives use HCT and Material light schemes but are not applied in the player. No SPlayer application code was copied.

The previous extractor followed [Panic ColorArt](https://github.com/panicinc/ColorArt). Its edge-weighted colour selection has been replaced by Material. The historical attribution and licence are retained below for the earlier adaptation; current theme generation no longer uses its background/foreground selection.

ColorArt license:

Copyright (C) 2012 Panic Inc. Code by Wade Cosgrove. All rights reserved.

Redistribution and use, with or without modification, are permitted provided that the following conditions are met:

- Redistributions must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of Panic Inc nor the names of its contributors may be used to endorse or promote works derived from this software without specific prior written permission from Panic Inc.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL PANIC INC BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## MP3 download encoding

Downloads use the unchanged `wasm-media-encoders` 0.7.0 package in a separate worker. Its JavaScript wrapper is MIT; the compiled LAME encoder is LGPL. The original package license is kept in production dependencies. Source and rebuild recipe: https://github.com/arseneyr/wasm-media-encoders/tree/v0.7.0 . The Node entry point embeds the WASM and works offline; it does not download code from a CDN at runtime. This module is separate from the LGPL-2.1 FFmpeg executable; no FFmpeg binary or build configuration was changed for MP3 support. MP3 is lossy, including when the input source is FLAC. The previous JavaScript lamejs dependency has been removed.

## Analysis decoder

`resources/ffmpeg-mini.exe` is the existing separate, replaceable FFmpeg 7.1 Windows audio decoder, licensed LGPL-2.1-or-later. Its LGPL text, build configuration and source revision/hash are bundled in `ffmpeg-mini-licenses/`; the corresponding FFmpeg 7.1 source and `.github/workflows/build-mini-ffmpeg.yml` recipe are provided in the release attachment `ccMusic-FFmpeg-mini-source-7.1.zip`.

## Audio download component

`resources/download-audio/ffmpeg.exe` is a custom static Windows x64 FFmpeg audio build from upstream revision `5cb9fcd21167cf2f5a2852ea582997bbd0055521`. Its build disables GPL, version3, nonfree, network and external-library autodetection; `ffmpeg -L` reports LGPL-2.1-or-later. It runs as a separate, replaceable executable for remuxing and cutting audio. The FFmpeg license and compiler/runtime package notices are bundled beside it. GCC runtime code uses the applicable runtime-library exceptions; compiler-package notices do not mean the compiler is distributed with this application.

The exact source archive, generated version marker, build recipe, configuration, toolchain versions and SHA256 manifest are available in the [cloud build artifact](https://github.com/Quinloan/ccMusic-Bilibili-Player/actions/runs/39018299209). Immutable [upstream source](https://github.com/FFmpeg/FFmpeg/tree/5cb9fcd21167cf2f5a2852ea582997bbd0055521) and [build recipe](https://github.com/Quinloan/ccMusic-Bilibili-Player/blob/46be78b01433e95db26430f2eb44c8ae383df90a/scripts/build-ffmpeg-audio.sh) identify the corresponding code and build parameters; keep a permanent copy of the source/build archive with distributed releases because Actions artifacts expire. Runtime hashes are pinned in `resources/ffmpeg-audio-manifest.json`. Both build configurations include the executable, notices, recipe and configuration. See [FFmpeg's distribution guidance](https://ffmpeg.org/legal.html). The application does not download this executable at runtime. This component remains separate from the existing `ffmpeg-mini.exe` analysis decoder.

## Recognition and text components

- **Shazam Node client**: `shazamio-api` 1.0.0, MIT; its `shazamio-core` 1.3.1 WASM dependency is MIT. Installed dependency packages include their license files. The client communicates with Shazam; the song catalog is not included or hosted by ccMusic.
- **Chinese conversion**: `opencc-js` 1.4.2, MIT AND Apache-2.0. Its dependency package includes the applicable license notices.
- **Optional local transcription (not bundled by default)**: the development setup can prepare official `ggml-org/whisper.cpp` Windows CPU build b5454 and multilingual `ggml-small-q5_1.bin` from `ggerganov/whisper.cpp`. Download origins, revision and SHA256 are recorded in `resources/whisper/download-manifest.json`; applicable license files accompany these optional resources. Default NSIS and portable builds exclude the model, CLI and DLLs. Without them, recognition uses the fingerprint services and skips local transcription. The app does not automatically download executable code or models; no in-app model installer is provided in this version.
- **KuGou research probe**: the standalone protocol probe references `MakcRe/KuGouMusicApi`. It is not enabled in production recognition or included in the app's runtime file list.

Audio recognition uploads fingerprints. The optional local transcription fallback processes audio on the device and sends selected text phrases to NetEase lyric search. Temporary compressed audio and transcription files are removed when processing finishes or fails. Recognition of a composition by its lyrics does not establish the singer's identity; reference singers are stored separately from the performer field.

## Corresponding source and build resources

Permanent FFmpeg source archives and verified runtime resources are on the [developer resources page](https://github.com/Quinloan/ccMusic-Bilibili-Player/releases/tag/build-resources-v1.6.3). The unchanged decoder binaries are also used in v1.7.0. Ordinary software releases contain the ready-to-run ZIP, installer and update metadata. The MP3 encoder package, license and upstream source/rebuild link are documented above. For building the old v1.6.3 tag, use the source archive on the developer page (its resource URL is updated), or a newer tagged source tree.
