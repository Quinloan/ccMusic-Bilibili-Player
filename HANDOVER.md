# ccMusic 开发说明

当前正式版为 v1.6.1，用户与构建入口见 README.md。

- main.js / preload.cjs：Electron 主进程和 IPC。
- renderer/：播放器、搜索、歌单、任务、下载和分段预览。
- audio-analysis.cjs / analysis-cache.cjs：分段分析与缓存。
- shazam-provider.cjs / netease-lyrics.cjs / lyric-recognition.cjs：识曲及可选唱词辅助。
- cover-art.cjs / video-search.cjs：音乐资料、封面与视频搜索。
- audio-downloads.cjs / download-ipc.cjs：下载队列。
- scripts/setup-release-resources.py：校验并准备固定构建资源，默认无 Whisper。
- scripts/test-*.cjs：离线与模拟 IPC/媒体回归，部分测试需自备音频。

不要在二进制、依赖目录或测试音频上进行全文读取。运行资源、源码与许可说明见发布附件和 THIRD-PARTY-NOTICES.md。
