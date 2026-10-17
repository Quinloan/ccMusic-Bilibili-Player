#!/usr/bin/env bash
set -euo pipefail
# Run on a Linux MinGW-w64 build host. No downloaded executable runs on the host.
revision=5cb9fcd21167cf2f5a2852ea582997bbd0055521
source_sha=3f768271927cbfef65d475bd48570939687567b0a673662e40cebb335803088a
workspace="${GITHUB_WORKSPACE:-$PWD}"
build="$workspace/ffmpeg-build"
out="$workspace/ffmpeg-audio-out"
mkdir -p "$build/src" "$out"
curl --fail --location --retry 3 "https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/$revision" -o "$out/FFmpeg-source.tar.gz"
printf '%s  %s\n' "$source_sha" "$out/FFmpeg-source.tar.gz" | sha256sum --check
tar xf "$out/FFmpeg-source.tar.gz" -C "$build/src" --strip-components=1
cd "$build/src"
# Source archive is inside the app checkout; do not let FFmpeg inherit the app's
# parent Git revision as its own version string.
printf 'git-%s-ccmusic-audio\n' "$revision" > FF_VERSION
./configure \
  --prefix="$build/install" --target-os=mingw32 --arch=x86_64 \
  --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-gcc-posix \
  --enable-cross-compile --pkg-config=false \
  --disable-everything --disable-autodetect --disable-network \
  --disable-gpl --disable-version3 --disable-nonfree \
  --enable-static --disable-shared --disable-doc --disable-debug \
  --disable-programs --enable-ffmpeg --disable-avdevice --disable-swscale \
  --enable-small --optflags=-Os \
  --extra-cflags='-ffunction-sections -fdata-sections' \
  --extra-ldflags='-static -Wl,--gc-sections' \
  --enable-swresample --enable-avfilter \
  --enable-filter=aresample,aformat,abuffer,abuffersink,anull,atrim \
  --enable-demuxer=mov,mp3,flac,ogg,wav,aac,ac3,eac3 \
  --enable-decoder=aac,aac_latm,mp3,mp3float,flac,opus,vorbis,ac3,eac3,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le \
  --enable-parser=aac,aac_latm,mpegaudio,flac,opus,vorbis,ac3 \
  --enable-protocol=file,pipe \
  --enable-muxer=pcm_s16le,wav,null,mov,mp4,ipod,flac,ogg,opus,eac3,mp3 \
  --enable-encoder=pcm_s16le,flac \
  --enable-bsf=aac_adtstoasc,extract_extradata
make -j"$(nproc)"
x86_64-w64-mingw32-strip ffmpeg.exe
cp ffmpeg.exe "$out/ffmpeg.exe"
cp COPYING.LGPLv2.1 "$out/LICENSE-FFmpeg.txt"
cp COPYING.LGPLv2.1 "$out/LICENSE-LGPL-2.1.txt"
cp config.h config_components.h ffbuild/config.mak ffbuild/config.log FF_VERSION "$out/"
for notice in /usr/share/doc/mingw-w64-common/copyright /usr/share/doc/gcc-mingw-w64-x86-64-posix/copyright /usr/share/doc/gcc-mingw-w64-base/copyright; do
  if test -f "$notice"; then cp -L "$notice" "$out/LICENSE-TOOLCHAIN-$(basename "$(dirname "$notice")").txt"; fi
done
cp "$workspace/scripts/build-ffmpeg-audio.sh" "$out/"
x86_64-w64-mingw32-gcc-posix --version > "$out/compiler-version.txt"
dpkg-query -W 'gcc-mingw-w64*' 'mingw-w64*' 'nasm' > "$out/toolchain-packages.txt"
x86_64-w64-mingw32-objdump -p ffmpeg.exe | sed -n '/DLL Name:/p' > "$out/windows-imports.txt"
OUT="$out" REVISION="$revision" SOURCE_SHA="$source_sha" python3 - <<'PY'
import hashlib, json, os, pathlib, re
out = pathlib.Path(os.environ['OUT'])
config = (out / 'config.h').read_text()
for feature in ['GPL', 'VERSION3', 'NONFREE', 'NETWORK', 'AVDEVICE', 'SWSCALE']:
    assert re.search(r'^#define CONFIG_' + feature + r' 0$', config, re.M), feature
components = (out / 'config_components.h').read_text()
encoders = re.findall(r'^#define CONFIG_(\w+)_ENCODER 1$', components, re.M)
assert set(encoders) == {'FLAC', 'PCM_S16LE'}, encoders
manifest = {
    'source': 'https://github.com/FFmpeg/FFmpeg', 'revision': os.environ['REVISION'],
    'source_url': 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/' + os.environ['REVISION'],
    'recipe_url': os.environ.get('GITHUB_SERVER_URL', '') + '/' + os.environ.get('GITHUB_REPOSITORY', '') + '/blob/' + os.environ.get('GITHUB_SHA', '') + '/scripts/build-ffmpeg-audio.sh',
    'source_archive_sha256': os.environ['SOURCE_SHA'], 'license': 'LGPL-2.1-or-later',
    'description': 'Custom static Windows x64 audio-only build. File/pipe input; no network/video libraries; PCM and FLAC encoders only.',
    'run_url': os.environ.get('GITHUB_SERVER_URL', '') + '/' + os.environ.get('GITHUB_REPOSITORY', '') + '/actions/runs/' + os.environ.get('GITHUB_RUN_ID', ''),
    'exe_sha256': hashlib.sha256((out / 'ffmpeg.exe').read_bytes()).hexdigest(),
    'bytes': (out / 'ffmpeg.exe').stat().st_size,
    'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.iterdir()) if p.is_file()},
}
(out / 'download-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'README.md').write_text('ccMusic custom audio FFmpeg\n\nLGPL-2.1-or-later. FFmpeg is a separate executable. '
    'This build disables GPL, version3, nonfree, external autodetection, network, libavdevice and libswscale. '
    'Only FLAC and PCM encoding are enabled. Exact source, configuration, compiler/package versions and recipe are in the cloud build artifact. '
    'Keep that artifact with distributed binaries; distribute corresponding source and license notices. '
    'The executable SHA256 and cloud build URL are recorded in download-manifest.json.\n')
print(json.dumps({key: manifest[key] for key in ['bytes', 'exe_sha256', 'license', 'run_url']}, indent=2))
PY
