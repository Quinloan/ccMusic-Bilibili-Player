# Recognition components

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
