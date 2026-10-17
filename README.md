# ccMusic

把 B 站音乐当歌听的 Windows 桌面播放器，支持歌单、智能分歌、听歌识曲和音频下载。

## 安装

在 [Releases](https://github.com/Quinloan/ccMusic-Bilibili-Player/releases/latest) 下载 `ccMusic-Setup-1.6.0.exe`，适用于 Windows 10/11 x64。覆盖安装可保留本机歌单和登录状态。安装包默认不捆绑 Whisper 模型，无需另外注册识曲服务账号。

## 功能

- 搜索歌手、歌曲、完整视频标题，或粘贴 BV / av / B 站链接；默认筛选至少 3 分钟的内容，支持单曲、长视频筛选和滚动加载。
- 添加时选择目标歌单；长视频默认智能分歌，也可保留整段。多 P 可任意选曲。
- 智能分歌结合简介时间轴与音频分析，切分完成直接弹出预览，可试听或调整边界。确认后立即加入歌单，后台逐首识别并更新名称。
- 网易云指纹与 Shazam 识曲；单曲/P 标题、简介曲目可直接匹配歌名、歌手与专辑封面；可手动编辑歌名/歌手，手改优先。
- 多歌单管理、筛选、多选、移动、排序、导入导出、整组移除、撤销和恢复整段。
- 无损优先默认开启；下载整首、任意多选或分段，支持进度、取消、重试。最高可用音质取决于 B 站登录、账号权益和源音轨。分段 FLAC 不会提升有损源质量。
- 待播队列、循环/单曲/随机模式、媒体快捷键与托盘控制。

识曲和切分可能需要手动修正，尤其是翻唱、混音和连续串烧；同名歌曲信息与演唱者以实际内容为准。

## 数据

歌单、队列和登录信息保存在本机应用数据目录，与安装目录分开。指纹识曲会向服务发送音频指纹；资料查询会发送歌名/歌手等检索词。默认不使用本地语音模型。开发者可另行准备可选 Whisper，转写在本机进行，歌词搜索发送选取的短句。临时音频按任务/会话生命周期清理，下载任务记录暂不跨重启保留。

## 从源码运行

需要 Windows x64、Node.js 22.19 或更新版本、npm 和 Python 3.11 或更新版本。

```powershell
npm ci
python scripts/setup-release-resources.py
npm start
# 构建 Windows 安装包
npm run dist
```

资源准备脚本只用于开发/构建，从 v1.6.0 发布附件下载固定资源并校验 SHA256，默认不下载 Whisper。终端用户安装后无需执行这些步骤。附带 FFmpeg 精简构建的源码、配方、配置与许可证另见发布附件和 [第三方说明](THIRD-PARTY-NOTICES.md)。

核心回归示例：`node scripts/test-audio-analysis.cjs`、`node scripts/test-downloads.cjs`、`node scripts/test-playback.cjs`。界面回归需另外安装 Playwright，并通过 `CCMUSIC_PLAYWRIGHT` / `CCMUSIC_BROWSER` 指定库和 Chromium/Edge；使用模拟 IPC/媒体，不启动 Electron 或播放真实音频。部分处理函数回归需要本地测试音频，不随源码分发。

应用源码采用 [MIT](LICENSE)。使用与下载应符合内容权利人的授权和平台规则，软件不会绕过账号权益。
