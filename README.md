# dsh-speech-plugin

DeepSeek Harness 的树外语音插件：在 Web 对话界面为每条落定的助手消息加一个「播报」按钮、提供「自动播报」开关，并在输入框工具行加入「语音输入」麦克风按钮。优先使用云端 TTS/ASR（阿里百炼 / 火山豆包语音），不可用时 TTS 自动回退浏览器 Web Speech API。以独立插件包安装，不修改 harness 仓库任何源代码。

## 功能

- **每条消息 🔊 按钮**：落在助手消息操作条（复制/分支/点赞旁边）。点击朗读该条回复的正文（自动剥离 markdown、表情符号，跳过代码块与图片）；朗读中再点即停止。
- **自动播报开关**：会话头部工具区的喇叭按钮，开启后图标变绿色高亮。开启后，新落定的助手消息自动朗读；历史消息（包括翻页加载的更早消息）不播。默认关闭——浏览器会拦截无用户激活的自动发声，显式点击开关即完成激活。
- **语音输入**：composer 工具行的麦克风按钮，点击开始收音，实时把识别结果追加到输入框草稿；再次点击结束并发送最终识别结果；点击发送消息同样会立即终止收音（不保留尾句 flush）。需要云端 ASR 引擎（阿里百炼 Paraformer 实时识别或火山豆包 V3 流式识别），未配置时按钮禁用并提示原因。
- **云端 TTS**：合成在 host 侧代理，API key 只存在于 host 进程环境变量，浏览器永远接触不到。同文本命中内存缓存，重复点击不重复计费。
- **自动回退**：未配置云端引擎、key 无效、网络失败或文本超长时，自动退回系统音色（`speechSynthesis`）继续播报，并在浏览器控制台说明原因。
- **特性检测**：非浏览器环境（jsdom、node e2e）没有 `window`/`Audio` 时插件静默不注册，不报错。

## 工作原理

一个包、两个半面（dsh 的双面插件模式）：

```text
浏览器半（lib/client.js，由外壳模块表加载）
  🔊 按钮 / 自动播报开关  →  每会话 SpeechController
                                   │  POST /dsh-speech/tts {text}
                                   ▼
host 半（lib/index.js，由 Loader 挂载）
  NDJSON 流式路由 → 引擎解析 → 按句分段（首段 ≤80 字）
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                   ▼
          阿里百炼（REST）                     火山豆包（V3 单向流式 HTTP）
                 └──────── 分段音频逐段回推 ────────┘
                                   │
           浏览器收到第一段即开speak，其余分段在播放期间陆续到达
```

- **流式播放**：host 边合成边以 NDJSON 推送分段；首段刻意切小（≤80 字，实测约 1~2 秒出声，其余分段 280 字/段在播放期间合成）。重复点击同一条消息命中缓存，即时回放。
- **回退顺序**：云端失败（key 缺失/无效、网络、超长）→ 系统音色整条播报；**不会**在两家云端引擎之间自动切换（音色突变比回退更糟），引擎由配置决定。
- **自动播报的偏好是浏览器本地存储**：声音从哪台机器的音箱出，开关就属于哪台浏览器（host 设置服务的客户端可见名单目前不对树外插件开放，本地存储也是语义上更正确的归属）。

## 云端 TTS 配置

引擎选择逻辑（config `engine`）：

| engine | 行为 |
|---|---|
| `auto`（默认） | 有百炼 key 用百炼；否则有火山 key 用火山；否则系统音色 |
| `dashscope` | 强制百炼（缺 key 时路由 503 → 浏览器回退系统音色） |
| `volcengine` | 强制火山豆包语音 |
| `system` | 永远用浏览器系统音色 |

环境变量（源码运行放 harness 仓库根目录 `.env`，和 `DEEPSEEK_API_KEY` 同一处；全局安装则放启动 dsh 的 shell 环境）：

```sh
# 专属名优先（推荐：显式声明这个 key 是给本插件的，可单独建限额 key）；
# 未设置专属名时回退官方通用名（复用已有配置）。
DSH_SPEECH_DASHSCOPE_API_KEY=sk-...         # 或回退 DASHSCOPE_API_KEY
DSH_SPEECH_VOLCENGINE_API_KEY=...           # 或回退 VOLCENGINE_TTS_API_KEY
                                            #   （更早的旧名 VOLCENGINE_TTS_ACCESS_TOKEN 仍识别）
```

凭据获取：

- **阿里百炼**：[百炼控制台](https://bailian.console.aliyun.com) → API-KEY（`sk-` 开头）。注意账户欠费（Arrearage）会拒一切调用，控制台提示见[错误码文档](https://help.aliyun.com/zh/model-studio/error-code)。
- **火山豆包**：[语音控制台](https://console.volcengine.com/speech/app) → 开通「语音合成大模型 2.0」→ **API Key 管理**创建 API Key（注意：不是应用级的 Access Token——V3 接口只认 API Key）。

可选配置：在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）里覆盖插件行——

```yaml
- id: ui-speech
  config:
    engine: volcengine            # TTS：auto | system | dashscope | volcengine
    asrEngine: auto               # ASR：auto | off | dashscope | volcengine（与 TTS 独立）
    dashscopeModel: qwen3-tts-flash
    dashscopeAsrModel: paraformer-realtime-v2   # 百炼实时识别模型
    dashscopeVoice: Cherry
    volcengineVoice: zh_female_vv_uranus_bigtts   # 必须 2.0 系音色；公版音色会报 55000000
    volcengineResourceId: seed-tts-2.0  # 必须与开通的服务版本一致（2.0 = seed-tts-2.0）
    volcengineAsrResourceId: volc.seedasr.sauc.duration  # ASR 资源 ID：2.0 小时版
    maxTextLength: 8000           # 单条消息合成字符上限（成本闸门，超出回退系统音色）
    cacheEntries: 64              # 合成结果内存缓存条数
```

计费与音色列表见官方文档：[百炼语音合成](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[火山豆包语音](https://www.volcengine.com/docs/6561/1598757)。

## 语音输入（ASR）配置

语音输入支持两家云端引擎，与 TTS 的 `engine` **完全独立**选择（`asrEngine` 配置项）：

| asrEngine | 行为 |
|---|---|
| `auto`（默认） | 有百炼 key 用百炼 Paraformer；否则有火山 key 用火山；否则按钮禁用 |
| `dashscope` | 强制百炼实时识别（缺 key 时按钮禁用并提示） |
| `volcengine` | 强制火山豆包流式识别（缺 key 时按钮禁用并提示） |
| `off` | 显式关闭语音输入 |

组合自由：TTS 和 ASR 各自按 key 与配置解析——播报用阿里、输入用豆包（`engine: dashscope` + `asrEngine: volcengine`），或反过来，或都走同一家，只需配好对应凭据。

环境变量（两家各自复用 TTS 的 key，一个账号 key 同时覆盖 TTS 与 ASR）：

```sh
DSH_SPEECH_DASHSCOPE_API_KEY=sk-...         # 或回退 DASHSCOPE_API_KEY（百炼）
DSH_SPEECH_VOLCENGINE_API_KEY=...           # 或回退 VOLCENGINE_TTS_API_KEY
                                            #   （更早的旧名 VOLCENGINE_TTS_ACCESS_TOKEN 仍识别）
```

凭据获取：

- **阿里百炼**：[百炼控制台](https://bailian.console.aliyun.com) → API-KEY（`sk-` 开头），开通「实时语音识别 Paraformer」后同一 key 即可用（模型默认 `paraformer-realtime-v2`，经 `dashscopeAsrModel` 可改）。
- **火山豆包**：[语音控制台](https://console.volcengine.com/speech/app) → 开通「流式语音识别」→ **API Key 管理**创建 API Key（V3 接口只认 API Key，不是应用级 Access Token）。

启用条件：

- `asrEngine` 不为 `off`，且能按上表解析到对应 key。
- 浏览器需要麦克风权限；首次点击麦克风按钮时由浏览器弹出授权请求。

音频规格：浏览器采集 16 kHz 单声道 PCM16，经 WebSocket `/dsh-speech/asr` 由 host 桥接到对应引擎（百炼 `api-ws/v1/inference` 双工任务，或火山 V3 `sauc/bigmodel_async` 二进制分帧）；识别结果统一以 `partial`（实时预览）和 `final`（句末确认）事件回写到 composer 草稿。

ASR 资源 ID 对照（火山，通过 `volcengineAsrResourceId` 配置，默认 `volc.seedasr.sauc.duration`）：

| 模型版本 | 小时版 | 并发版 |
|---|---|---|
| 豆包流式语音识别 1.0 | `volc.bigasr.sauc.duration` | `volc.bigasr.sauc.concurrent` |
| 豆包流式语音识别 2.0 | `volc.seedasr.sauc.duration` | `volc.seedasr.sauc.concurrent` |

> 火山控制台必须开通与资源 ID 对应的能力，否则握手阶段会直接返回 403。

## 安装

### 源码运行的 fork（开发场景）

```sh
# 一次性：构建插件
cd dsh-speech-plugin && pnpm install && pnpm run build

# 装进 web profile（首次会自动初始化 ~/.dsh/profiles/web）
cd <你的 deepseek-harness 目录>
pnpm dsh plugin --profile web add /绝对路径/dsh-speech-plugin

# 验证组合层（应看到 "# == dsh-speech-plugin" 层）
pnpm dsh --profile web --dump-config | grep -A2 dsh-speech-plugin

# 启动
pnpm dsh --profile web     # http://127.0.0.1:3080
```

对话本身需要 `DEEPSEEK_API_KEY`（fork 根目录 `.env`）。

### 全局安装的 dsh

```sh
npm i -g @deepseek-ai/dsh
dsh plugin --profile web add /绝对路径/dsh-speech-plugin
dsh --profile web
```

### 分发给别人

- **npm 发布（推荐）**：`pnpm run build && pnpm publish`（`files` 字段已列好构建产物），用户一句 `dsh plugin --profile web add dsh-speech-plugin` 即装即用。
- **GitHub 直装有构建陷阱**：git 安装拉到的是源码且 `lib/` 不入库，需要包内自足的 `prepare` 脚本，且 pnpm ≥10 要求用户在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行——除非专门做了适配，否则走 npm。
- 记得给仓库加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现（`gh repo edit --add-topic dsh-plugin`）。

## 卸载

```sh
dsh plugin --profile web remove dsh-speech-plugin   # 源码运行前缀 pnpm dsh
```

## 开发循环

改代码后 `pnpm run build`（pnpm link 不跑构建脚本），浏览器刷新即可——模块注册表按内容 hash 生成 rev，改动自动生效。`pnpm run typecheck` 做类型检查。host 半的改动需要重启 dsh。

## 故障排查

浏览器 DevTools 控制台里 `[dsh-speech]` 开头的警告会带具体原因（括号内）；服务端日志 `dsh-speech:` 前缀同理。

| 现象/警告 | 原因与处理 |
|---|---|
| `tts-unavailable` | 没有任何云端凭据，或 `engine: system`。配置 env 后重启 |
| `dashscope ... Arrearage` | 百炼账户欠费。费用中心结清，或换火山的 key |
| `load grant not found in SaaS storage` | 凭据类型与接口不匹配：V3 只认**控制台 API Key**（`X-Api-Key`），应用级 Access Token 不行；或该 key 没有绑定语音合成服务授权 |
| `55000000 resource ID is mismatched with speaker` | `volcengineResourceId` 与音色版本不匹配：2.0 授权配 2.0 音色（如 `zh_female_vv_uranus_bigtts`），公版音色配 `volc.service_type.10029` |
| `text-too-long` | 清洗后的文本超过 `maxTextLength`（默认 8000 字），已回退系统音色；确需更长可调大该值（成本自负） |
| `asr-start: asr handshake rejected (http 403)` | 火山 key 未被授权当前 `volcengineAsrResourceId`：控制台开通的是 1.0 时应配 `volc.bigasr.sauc.duration`（默认的 `volc.seedasr.*` 是 2.0，需控制台开通 2.0 后才能用），或去控制台给该 API Key 关联对应资源 |
| `asr-start: asr handshake rejected (http 401/403)`（阿里） | `DASHSCOPE_API_KEY` 无效或账户欠费；换有效 key 后重启 dsh |
| 点击后 1~2 秒才出声 | 正常：这是云端神经合成的推理延迟，已是流式首段（≤80 字）优先的极限；缓存命中则即时 |
| 播报遇到表情符号卡一下 | 表情已在清洗层剥除（不发声）；若旧版仍在卡，刷新浏览器加载新 client |
| 没在播报但图标停在「播报中」 | 旧版走系统音色回退时，Chrome 可能不触发朗读结束事件导致状态搁浅；已加引擎空闲兜底自动复位，刷新浏览器即可恢复 |
| 界面没有 🔊 按钮 | 该消息是中断产生的残句（无 messageId），或环境无 `Audio`；刷新页面确认插件行在 `--dump-config` 里 |
| 没有麦克风按钮 / 按钮禁用 | `asrEngine: off`，或百炼、火山两家 key 都没配；按提示补 key 或改 `asrEngine` 后重启 dsh |
| 点击麦克风后一直显示「连接中」 | 浏览器→host 的 WebSocket 被代理/防火墙阻断；或火山服务握手失败，查看控制台 `[dsh-speech]` 警告 |
| 麦克风授权被拒 | 浏览器地址栏 🔒/🎤 图标 → 重新允许麦克风权限，然后刷新 |
| 启动报 `EADDRINUSE :3080` | 旧实例占着端口：`lsof -ti :3080 | xargs kill` |

## 结构

```
src/config.ts            插件 Config schema（TTS/ASR 引擎、模型、音色、上限、缓存）+ 默认值
src/index.ts             host 半：/dsh-speech/tts 流式路由 + /dsh-speech/asr WebSocket 桥接
src/asr/types.ts         ASR 共享契约（AsrEvent 事件 + AsrSession 会话接口）
src/asr/dashscope-asr.ts     阿里百炼 Paraformer 实时 ASR 会话（双工任务 → partial/final/error）
src/asr/volcengine-asr.ts    火山豆包 V3 流式 ASR 会话（PCM16/16k/mono → partial/final/error）
src/tts/types.ts         provider 契约（分段合成、错误分类、限额）
src/tts/dashscope.ts     阿里百炼 provider（REST，Bearer key，Base64 wav）
src/tts/volcengine.ts    火山豆包 provider（V3 单向流式，X-Api-Key + Resource-Id，NDJSON Base64 mp3）
src/tts/split-text.ts    按句分段；首段小预算换取最快首响
src/tts/service.ts       引擎解析（auto 优先级）+ 分段重试 + LRU 缓存
src/client/controller.ts 每会话控制器：NDJSON 流式播放，失败回退 speechSynthesis
src/client/asr-client.ts     浏览器麦克风录制器：ScriptProcessor 采集 + WebSocket 发送
src/client/MicButton.tsx     composer 语音输入按钮
src/client/announce-store.ts  自动播报偏好（浏览器本地持久化 store）
src/client/clean-text.ts markdown/代码块剥离，只留可读文本
src/client/speech-watcher.ts  自动播报：订阅会话快照，水位线区分新旧消息
src/client/SpeechActions.tsx  消息操作条 🔊 按钮
src/client/AnnounceToggle.tsx 会话头部自动播报开关
src/client/index.ts      插槽注册（assistant-actions + header.utilities + input.right）
```

插槽契约由 ui-conversation 声明；本包只贡献条目。浏览器 bundle 以 `window.__ModuleLoader__.load` 包装，react/cordis/ui-slots/ui-primitives 等平台模块经外壳模块表共享（external 清单镜像 harness 的 `packages/client/web/src/platform.ts`）。

## 已知限制与后续

- 引擎/音色是部署级配置（cordis.yml），浏览器内切换音色的 UI 未做。
- 自动播报按「新落定」触发（水位线机制，防止回放历史）；切换会话期间，仍在生成的旧会话消息完成时也会播报。开关状态按浏览器存储，换设备/浏览器需各自开启。
- 首句超过 80 字时首段优化失效（整句按引擎上限硬切）；语速/音量偏好未暴露。
- 火山走 V3 单向流式接口；更低延迟的双向流式（边生成边合成）需要接会话事件流，属于后续方向。
- 回退的系统音色质量取决于操作系统；macOS 可在 系统设置 → 辅助功能 → 朗读内容 下载增强版中文音色。

## License

MIT
