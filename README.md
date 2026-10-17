# ccMusic

把 B 站音乐当歌听的 Windows 桌面播放器。支持音频播放、歌单、智能分歌、听歌识曲和音频下载。

## 下载

前往 [GitHub Releases](https://github.com/Quinloan/ccMusic-Bilibili-Player/releases) 下载 Windows x64 安装包。

**v1.6.0-beta.1 是测试版。** 推荐先体验和反馈，正式版 v1.5.0 仍保留在发布页。安装包包含本地识曲模型和下载组件，体积比旧版大。

## 功能

- 搜索歌手、歌曲、视频标题，或粘贴 BV / av / B 站分享链接。默认筛选适合听歌、至少 3 分钟的候选，也可切换全部内容。
- 多歌单管理、筛选、多选、移动、排序、改名，以及歌单 JSON 导入导出。
- 长合集智能分歌，结合简介时间轴、静音分析和多路识曲。分析完成后可试听、改歌名、调整边界、拆分或合并，确认后才应用，支持撤销和恢复整段。
- 网易云指纹、Shazam 与本地唱词转写辅助识曲，无需用户注册识曲接口或填写密钥。翻唱、混音和连续串烧仍可能识别失败或需要手动调整。
- 无损优先默认开启。B 站扫码登录后按账号权益和源视频提供的音轨播放，不保证所有视频都有无损。
- 下载整首、分 P 或已切分歌曲；歌单「批量下载…」和合集「选择下载…」可自由勾选。默认最高可用音质，未登录先提醒；整首保留原编码，分段保存为 FLAC，但不会提高有损源的原音质。
- 列表循环、单曲循环、随机播放、进度拖动、音量、媒体快捷键和托盘播放。

## 数据与隐私

歌单和登录信息保存在本机应用数据目录。指纹识曲会向识曲服务发送音频指纹；本地转写在设备上完成，歌词搜索会发送选取的文本短句。临时音频在处理完成、失败或取消后清理。下载任务记录暂不跨重启保留。

## 源码构建

需要 Windows x64、Node.js 22.19 以上版本和 npm。

```powershell
npm ci
python scripts/setup-release-resources.py
npm start
# 生成安装包
npm run dist
```

`setup-release-resources.py` 只供开发和构建使用，下载本测试版发布页提供的固定资源包并校验 SHA256。运行中的播放器不下载程序或模型。原有 `resources/ffmpeg-mini.exe`、`resources/afp/` 和图标随仓库保留。

可运行 `node scripts/test-downloads.cjs`、`node scripts/test-playback.cjs`、`node scripts/test-add-flow.cjs` 等回归。真实页面回归 `test-ui.cjs` 需要另外准备 Playwright 和 Chromium/Edge，通过 `CCMUSIC_PLAYWRIGHT`、`CCMUSIC_BROWSER` 指定本机路径；它使用模拟 IPC/媒体，不等同 Electron 在线验证。

## 许可证与第三方组件

应用源码采用 MIT。第三方识曲、文字转换、本地模型及 FFmpeg 使用各自许可证，见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。FFmpeg 的固定源码与构建来源资料随本测试版发布页提供。

下载与使用应符合视频权利人的授权及平台规则；软件不会绕过账号权益限制。
