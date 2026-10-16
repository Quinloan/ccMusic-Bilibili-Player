# ccMusic 项目交接文档

给接手的 AI：这是一份从 0 了解本项目的说明。读完你应该能定位代码、理解原理，并继续完善「智能分歌」和「听歌识曲」两个还不成熟的功能。

---

## 一、软件是什么

**ccMusic** 是一个 Windows 桌面端 **B 站纯音频连播播放器**（Electron）。它不下载视频画面，只取 B 站的**音频流**来播放，定位是"把 B 站当音乐库用"。

- 技术栈：Electron（主进程 Node + 渲染进程原生 JS，无框架）+ electron-builder 打包，仅出 Windows x64 安装包
- 代码位置：`bili-radio/`
  - `main.js` 主进程：B 站接口、播放地址、智能分歌、听歌识曲、托盘/媒体键
  - `preload.cjs`：IPC 桥（contextBridge 暴露 `window.api`）
  - `renderer/app.js`：渲染端全部逻辑（约 3000 行，无框架）
  - `renderer/index.html` + `renderer/style.css`
  - `resources/ffmpeg-mini.exe`：自编译裁剪版 ffmpeg（1.86MB，纯 LGPL），只用于分歌解码
  - `resources/afp/afp.js` + `afp.wasm.js`：音频指纹 wasm（360KB），用于听歌识曲
  - `scripts/*.js`：探针与测试脚本
  - `.github/workflows/build-mini-ffmpeg.yml`：裁剪版 ffmpeg 的交叉编译工作流

## 二、核心原理

1. **取数据**：B 站接口需要 wbi 签名 + cookie（`main.js` 的 `ensureSession` / `signWbi`）。视频信息走 `/x/web-interface/view`，播放地址走 `/x/player/wbi/playurl`（返回 DASH 音轨列表，代码里归一化成 `tracks: [{id, kbps, url}]`）。
2. **播放**：`<audio>` 直接播 DASH 音频 URL。音质策略 `pickTrack` 支持"无损优先"（有 FLAC 走 FLAC）。
3. **音量平衡**：Web Audio 图（`applyBalanceRouting` + `startAgc`），用 AnalyserNode 测峰值算出补偿增益，拉平不同视频/不同 P 的音量差异。
4. **数据持久化**：`%APPDATA%\ccMusic\radio-data.json`（歌单 + 登录 cookie + 队列），与安装目录分离，覆盖安装不丢。

## 三、主要功能

| 功能 | 说明 |
| --- | --- |
| 首页 | 默认启动页，展示 B 站搜索「音乐」的结果卡片（悬停可播放/加入队列/加入收藏夹） |
| 收藏夹 | 侧栏多个收藏夹，歌单持久化 |
| 多 P 分组 | 同一视频拆出的多个 P 聚成一组，可折叠（组头显示封面叠层 + 数量 + 视频标题） |
| 播放列表 | 悬浮卡片，与收藏夹分离（临时队列） |
| 设置面板 | 居中悬浮卡片，含播放/音质/更新设置 |
| 删除确认 | 删歌/删歌单前弹确认（Esc 或点空白取消） |
| 音量感知曲线 | 音量条用小声区精细、大声区快速的平方曲线 |
| 智能分歌 | 见下（重点） |
| 听歌识曲 | 见下（重点） |

## 四、歌曲数据结构

歌单里的条目 `item` 字段：

```js
{
  bvid, cid, page,          // B 站定位（cid 由 ensureCid 保证有效）
  title, vtitle,            // 标题 / 所属视频标题（决定分组）
  up, cover, duration,      // UP 主 / 封面 / 秒
  // 智能分歌产出的额外字段：
  split: true, startSec, endSec, artist
}
```

分组逻辑在 `renderList()`：`isPart(it)` 为真的相邻同 bvid 条目聚成一组，组头由 `groupHtml()` 渲染。分歌曲目 `split:true` 也参与分组，组头显示「智能切分 · N 首」+ 视频标题。

## 五、智能分歌（重点，还不够好）

**要解决的问题**：B 站有大量"一个视频塞几十首歌"的合集（无分 P，几小时）。用户希望能自动切成一首首曲目，可单独播放/连播。

**原理**：歌曲之间通常有**静音间隙** → 检测静音段作为切点。

**实现链路**（`main.js` 的 `split:analyze`）：

1. `getPlayurl(bvid, cid)` 取音频流 URL（带 Referer/UA/Cookie）
2. Node 边下载边**管道**喂给 `resources/ffmpeg-mini.exe`（不落盘，全程内存）
3. ffmpeg 输出 **8kHz 单声道 s16le PCM**（`-f s16le -ac 1 -ar 8000`）
4. Node 流式算 **RMS**（每 100ms 一个窗口）
5. 找静音段 → 取中点作切点 → 生成曲目 `{startSec, endSec}`
6. 顺带每 30 秒留 8 秒 PCM 采样，供听歌识曲用
7. 渲染端 `maybeSplit()` 把原条目**替换**成切好的曲目入库

**关键参数**（`main.js` 顶部常量）：

```
SPLIT_RATE      = 8000   // 重采样率
SPLIT_TH        = 0.008  // RMS 低于此值算静音
SPLIT_MIN_SIL   = 1.5    // 静音至少持续 1.5 秒才算切点
SPLIT_MIN_TRACK = 60     // 单曲最短 60 秒，滤掉碎片
SAMPLE_EVERY    = 30     // 每 30 秒留一段采样
SAMPLE_SEC      = 8      // 每段 8 秒
```
渲染端触发阈值：`SPLIT_MIN_DURATION = 600`（**视频时长 > 10 分钟**且单 P 才自动分析）。

**实测数据**：

- 速度：约 681 倍实时（4.5 小时视频全流程约 200 秒，含下载）
- 切分：热门歌合集（4.5h）切出 56 首（平均 4.7 分钟/首，符合歌曲长度）；35 分钟视频切 3 首

**已知问题 / 待完善**：

1. **依赖静音**：DJ 串烧、交叉淡入、中间有人说话的合集切不开或误切——这是算法原理限制
2. **阈值是写死的**：不同音频（Hi-Res 动态范围大）可能需要不同阈值，应做成自适应或可调
3. **只处理单 P**：多 P 视频的每个 P 是独立音频，目前不处理（多 P 合集本来就是分好的）
4. **中断要重来**：下载中断会报错重来，无断点续传/结果缓存
5. 切完**直接入库不微调**（用户明确要求过），若切错只能手动改

## 六、听歌识曲（重点，命中率不理想）

**要解决的问题**：分歌切出的曲目没有标题（视频简介通常没有歌单时间戳），靠识别音频自动命名。

**原理**：**音频指纹**——本地生成指纹 → 上传指纹 → 服务端在曲库里比对 → 返回歌名。

**实现**（`main.js` 的 `identifySong`）：

1. `resources/afp/afp.js`（wasm，来自网易云官方 Chrome 插件的逆向）把 8kHz Float32 PCM 转成指纹字符串
2. GET `https://interface.music.163.com/api/music/audio/match?sessionId=0123456789abcdef&algorithmCode=shazam_v2&duration=<秒>&rawdata=<URL编码指纹>&times=1&decrypt=1`
3. **免登录、免加密**，且**只上传指纹（约 3KB），不上传音频**，隐私友好
4. 取 `data.result[0].song.name` 作为曲目标题，失败则回退「曲目 N」

**采样策略很重要**：早期取曲目**开头**命中率低（片头/前奏/空白），改成取**中段**（长曲试 30%/50%/70% 三个位置）后明显改善。

**实测数据**：

| 场景 | 结果 |
| --- | --- |
| 原曲搬运合集 | ✅ 识别出「星晴 — 周杰伦」「甲乙丙丁 — 李佳薇」 |
| 翻唱/二创合集 | ❌ 基本全军覆没（返回 `noMatchReason:10`） |

**核心局限（必须理解）**：音频指纹只能匹配**曲库里存在的同一份录音**。B 站这类合集大量是翻唱、AI 翻唱、自制混音，网易云没有同一录音 → 识别不出来。**这不是 bug，是原理限制**。

**已知问题 / 待完善**：

1. 翻唱/二创场景失效 → 备选方案：**歌词识别**（Whisper 类模型把唱词转文字再搜歌名，翻唱也能识别，代价是模型约 75MB + 准确率约 5~7 成）
2. 接口是**逆向非官方**，可能失效；应在失效时优雅回退到「曲目 N」
3. 每次识别有 350ms 间隔 + 10 秒超时防限频（已加）
4. 采样质量依赖切分结果（切错 → 采样跨界 → 识别更差）
5. 未做缓存：同一视频重复分析会重复识别

## 七、开发 / 验证工作流

```bash
# 开发模式（让用户看效果，不打包）
双击 bili-radio/启动.bat          # 已 unset ELECTRON_RUN_AS_NODE
# 改渲染端后窗口内 Ctrl+R 刷新；改主进程需重启

# 回归测试（默认不播放歌曲，用户明确要求过）
node_modules/electron/dist/electron.exe scripts/test-parts.js BV1FPjy6TEiE shots/x.png
# 需要真播放验证时加 --audio

# 界面截图（不联网不播放，注入演示数据）
node_modules/electron/dist/electron.exe scripts/dev-screenshot.js shots/xx.png --demo [--home|--split|--settings|--queue|--search]

# 分歌端到端探针
node_modules/electron/dist/electron.exe scripts/probe-split-ipc.js <bvid> [maxSec]

# 听歌识曲单独验证（需 AFP_DIR 指向 afp.js 所在目录）
node_modules/electron/dist/electron.exe scripts/probe-shazam.js <bvid> [第几P] [偏移秒]
```

**注意事项**：

- **测试不要播放歌曲**（用户明确要求过，会打扰他）
- **发版前先问用户是否需要提供截图**——他会自己截好给我上传，不要自己跑截图
- GitHub PAT 在 `~/.workbuddy/.github_token`，**只有仓库内容权限**（无 Actions 权限）；触发 workflow 需要用户在网页点 Run workflow
- 裁剪版 ffmpeg 的重编走 `.github/workflows/build-mini-ffmpeg.yml`（ubuntu + mingw-w64 交叉编译，需用户手动触发）
- 打包：`unset ELECTRON_RUN_AS_NODE && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --win`

## 八、踩过的坑（别重复踩）

1. **16 位样本跨块对齐**：ffmpeg stdout 的网络分包可能是奇数字节，直接拼接会导致 int16 **全部错位**，指纹变成噪声，表现为接口正常返回"无匹配结果"（`noMatchReason:10`），极难排查。已用残字节 carry 机制修复。
2. **管道 EPIPE**：ffmpeg 提前退出时 stdin 写入会抛 EPIPE，必须 `ff.stdin.on('error', () => {})`，否则 Electron 主进程弹窗崩溃。
3. **识别请求必须加超时**：否则接口卡住会让整个 IPC handler 挂起（`reply was never sent`）。
4. **configure 里 muxer 名要写 `pcm_s16le`**（写 `s16le` 会被 ffmpeg configure **静默忽略**，编译成功但输出 0 字节）；另外必须保留最小滤镜链（aresample/aformat/abuffer/abuffersink），否则 `-ar/-ac` 降采样失效。
5. **多 P 合集的 P1 也满足分歌触发条件** → 分歌只在 `addToFolder`（单 P 路径）触发，`pmCommit` 不触发。

## 九、当前状态

- 版本 1.5.0 已发布；首页 + 删除确认 + 智能分歌 + 听歌识曲均在 main 分支（未发版）
- 分歌：可用，切分准确（实测符合歌曲长度）
- 听歌识曲：链路通，但**翻唱场景命中率≈0**，是最大的待优化点
