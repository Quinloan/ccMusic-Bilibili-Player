# Synthetic audio fixture

`tone-aac.m4a` is a generated 440 Hz sine wave (4 seconds, mono 48 kHz),
created locally for download/remux/split regression tests. It contains no song.

Generation command, using a developer FFmpeg build with AAC encoding:

```text
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=4 -c:a aac -b:a 192k -movflags +faststart tone-aac.m4a
```

The shipped audio-only runtime deliberately has no AAC encoder or signal generator.
