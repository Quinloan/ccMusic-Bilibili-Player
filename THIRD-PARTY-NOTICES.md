# Recognition components

## Audio download component

`resources/download-audio/ffmpeg.exe` is an unmodified BtbN FFmpeg-Builds Windows x64 LGPL build, version `N-127579-g5cb9fcd211-20261016`, licensed LGPL-3.0-or-later. It is executed separately for remuxing and cutting audio. The archive and executable hashes, build origin, and version are recorded in `resources/download-audio/download-manifest.json`; the LGPLv3 and incorporated GPLv3 license texts and source/build references are included beside it. Both build configurations include these resources. See that directory's README for corresponding-source distribution requirements. The application never downloads this executable at runtime. This component is distinct from the original `ffmpeg-mini.exe` analysis decoder.

## Recognition and text components

- **Shazam Node client**: `shazamio-api` 1.0.0, MIT; its `shazamio-core` 1.3.1 WASM dependency is MIT. Installed dependency packages include their license files. The client communicates with Shazam; the song catalog is not included or hosted by ccMusic.
- **Chinese conversion**: `opencc-js` 1.4.2, MIT AND Apache-2.0. Its dependency package includes the applicable license notices.
- **Local transcription**: official `ggml-org/whisper.cpp` Windows CPU build b5454 and multilingual `ggml-small-q5_1.bin` from `ggerganov/whisper.cpp`. Download origins, revision and SHA256 are recorded in `resources/whisper/download-manifest.json`; license files are bundled beside the model. Runtime does not download executable code or models.
- **KuGou research probe**: the standalone protocol probe references `MakcRe/KuGouMusicApi`. It is not enabled in production recognition or included in the app's runtime file list.

Audio recognition uploads fingerprints. The optional local transcription fallback processes audio on the device and sends selected text phrases to NetEase lyric search. Temporary compressed audio and transcription files are removed when processing finishes or fails. Recognition of a composition by its lyrics does not establish the singer's identity; reference singers are stored separately from the performer field.
