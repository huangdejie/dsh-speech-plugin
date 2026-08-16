# DEVELOPMENT.md — dsh-speech-plugin 技术文档

面向开发者：架构、双面插件模型、四条云端协议、源码结构、开发循环与分发。面向使用者的安装配置见 [README.md](README.md)。

## 总体架构

一个包、两个半面（dsh 的双面插件模式）：

```text
浏览器半（lib/client.js，由外壳模块表加载）
  🔊 SpeechActions / 📣 AnnounceToggle / 🎤 MicButton
        │  POST /dsh-speech/tts {text}          │  WS /dsh-speech/asr
        │  NDJSON 流式音频段                      │  二进制 PCM 上行 / JSON 事件下行
        ▼                                        ▼
host 半（lib/index.ts → lib/index.js，由 Loader 挂载）
  SpeechTTSService                    bridgeAsr → resolveAsrSession
        │                                   ├─ DashscopeAsrSession
        ├─ dashscopeProvider (REST)         └─ VolcengineAsrSession
        └─ volcengineProvider (V3 HTTP)
```

- 浏览器半只与 host 通信，云端凭据永不下发到浏览器。
- host 半通过 `ctx.inject(['webServer'])` 注册两个 HTTP 路由 + 一个 WebSocket upgrade：`POST /dsh-speech/tts`（NDJSON 流）、`GET /dsh-speech/asr/available`（可用性探针，驱动麦克风按钮态）、upgrade `/dsh-speech/asr`（识别流桥接）。
- 浏览器 bundle 以 `window.__ModuleLoader__.load` 包装；react/cordis/ui-slots/ui-primitives 等平台模块经外壳模块表共享（tsdown external 清单镜像 harness `packages/client/web/src/platform.ts`）。

## 目录结构

```
src/config.ts            Config schema（engine/asrEngine、模型、音色、资源 ID、上限、缓存）+ 默认值
src/index.ts             host 半：TTS 路由、ASR upgrade 桥接、resolveAsrSession 引擎解析
src/asr/types.ts         ASR 共享契约：AsrEvent 事件流 + AsrSession 会话接口
src/asr/dashscope-asr.ts     阿里百炼 Paraformer 双工 WS 会话
src/asr/volcengine-asr.ts    火山豆包 V3 二进制分帧 WS 会话
src/tts/types.ts         TTS provider 契约（分段合成、错误分类 retryable、字符上限）
src/tts/dashscope.ts     百炼 provider：REST，Bearer key，data 内联或 url 下载
src/tts/volcengine.ts    火山 provider：V3 单向流式 HTTP，X-Api-Key + Resource-Id，NDJSON Base64 mp3
src/tts/split-text.ts    按句分段；首段 ≤80 字小预算换最快首响
src/tts/service.ts       引擎解析（auto 优先级）+ 分段重试 + LRU 缓存 + 凭据读取
src/client/controller.ts 每会话 SpeechController：NDJSON 流播放、系统音色回退、状态复位兜底
src/client/asr-client.ts     MicRecorder：ScriptProcessor 采集 16k PCM16 + WS 发送
src/client/MicButton.tsx     composer 麦克风按钮 + 草稿拼装（frozen base）
src/client/clean-text.ts     播报文本清洗：markdown 剥离、emoji 剥离
src/client/speech-watcher.ts 自动播报：会话快照订阅 + seq 水位线
src/client/announce-store.ts 自动播报偏好（浏览器 localStorage）
src/client/SpeechActions.tsx 消息操作条 🔊；src/client/AnnounceToggle.tsx 头部开关
src/client/index.ts      插槽注册（assistant-actions / header.utilities / input.right）
```

插槽契约由 harness 的 ui-conversation 声明（`conversation.chat.assistant-actions`、`conversation.session.header.utilities`、`conversation.input.right`），本包只贡献条目；`inject(sessionId)` 交付每会话资源（controller + mic + watcher）。

## ASR：统一契约与两家实现

`AsrSession`（`src/asr/types.ts`）是两家的公共生命周期：

```text
start(): Promise<void>     连接并等待 ready 信号（百炼 task-started / 火山首个成功帧）
sendAudio(pcm: Buffer)     转发一段 PCM16/16k/mono
finish()                   结束流；服务端回完最后结果后自然收尾
close()                    丢弃式断开（不发 end-of-stream 握手）
```

事件流 `AsrEvent`：`ready` / `partial`（替换尾段）/ `final`（追加落定）/ `error`（code + message）。host 的 `bridgeAsr` 把事件原样转成浏览器 JSON 消息，浏览器半对 provider 无感知。

### 百炼 Paraformer（`dashscope-asr.ts`）

- 端点 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，握手头 `Authorization: Bearer <key>`（鉴权在握手阶段，坏 key 直接 HTTP 401/403）。
- 控制消息是 JSON 文本：`run-task`（`task_group: audio`、`task: asr`、`function: recognition`、模型名、`format: pcm`、`sample_rate: 16000`、`heartbeat: true`）开任务；音频以**裸二进制帧**上行；`finish-task` 收尾。
- 服务端事件：`task-started`（ready）、`result-generated`（`payload.output.sentence`，`sentence_end` false=partial / true=final）、`task-finished`（自然结束，onDone）、`task-failed`（`header.error_code/error_message`）。
- `heartbeat: true` 防长停顿 60s 静音超时；心跳句带 `heartbeat: true`，解析时跳过。

### 火山 V3（`volcengine-asr.ts`）

- 端点 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`，握手头 `X-Api-Key` + `X-Api-Resource-Id`（选版本/计费模式）+ `X-Api-Request-Id` / `X-Api-Sequence: -1` / `X-Api-Connect-Id`。资源未授权 → 握手 HTTP 403，body 带 `requested resource not granted`。
- 客户端帧：4 字节头（version/size、type/flags、serial/compression、reserved）+ u32be payload 长度 + gzip(payload)。type 0x01 = JSON 配置、0x02 = 音频（flags 0x02 标最后的空帧）。
- 服务端帧：type 0x0F = 错误（u32be code + u32be 长度 + JSON）；full 帧 JSON 带 `result.utterances[]`，`definite` false=partial / true=final。
- **坑**：full 帧的 4 字节 sequence 字段只在 flag 0x01 置位时存在——bigasr 1.0 的首帧 flags=0，payload 从 offset 8 开始；解析器按 flag 位算偏移，不能写死 offset 12。
- `result_type: single` 模式下整个会话一个片段、只有一次 final；`code 1013`（无有效语音）忽略。

### 引擎解析（`resolveAsrSession`，index.ts）

`asrEngine: auto` → 按凭据顺序 `dashscope → volcengine`；指定家则锁定（缺 key 时按钮禁用并提示缺失变量名）；`off` 显式关闭。与 TTS 的 `engine` 完全独立，TTS 侧同构（`SpeechTTSService.provider()`）。可用性探针与桥接共用同一解析函数，实例化不建连，探针零成本。

## TTS：provider 契约

- 百炼：非实时多模态端点，一 chunk 一 POST，响应 `output.audio.data`（内联 Base64 wav）或 `output.audio.url`（24h 有效，host 侧下载）。非 2xx / code 非空抛 `TtsError`，5xx 与 429 标记 retryable。
- 火山：V3 单向流式 HTTP，NDJSON 返回 Base64 mp3 段；音色与 `volcengineResourceId` 版本必须匹配（55000000）。
- `SpeechTTSService`：按句分段（首段 ≤80 字）顺序合成、段级重试（3 次、线性退避）、整条消息 LRU 缓存（`sha1(engine\0settings\0text)`）。

## 浏览器半要点

- **草稿拼装（MicButton）**：录音开始时冻结 `baseRef = 当前草稿`，此后每帧写 `base + committed + partial`——partial 替换尾段、final 追加。不冻结基线会把已写入的识别文本重复叠加。输入机进入 `submitting`（用户点了发送）即 `recorder.cancel()`：丢弃式终止，晚到的 final 不会写回已发送的草稿，也不再消耗 ASR 额度。
- **播放（SpeechController）**：云端 NDJSON 段到一段播一段（Blob object URL + Audio）；任何一步失败且尚无音频输出则整条回退 `speechSynthesis`。系统音色回退有 Chrome 搁浅兜底：`onend/onerror` 之外轮询引擎空闲（连续两次 speaking/pending 皆 false）强制复位视图，避免「播报中」状态卡死。
- **文本清洗（clean-text）**：剥 markdown（代码块/图片整体丢弃）、剥 emoji（`Extended_Pictographic` + 旗帜指示符 + ZWJ + 变体选择符——云引擎对表情返回长静音）。
- **自动播报（speech-watcher）**：订阅会话快照，seq 水位线区分「订阅后新落定」与历史；残句（无 messageId）不触发。

## 凭据与环境

只认两个名字：`SPEECH_DASHSCOPE_API_KEY`、`SPEECH_VOLCENGINE_API_KEY`（`src/tts/service.ts`），host 进程环境读取，每请求实时解析。harness 启动层（app-boot）把 `DSH_` 前缀保留为自举命名空间，任何 `.env` 文件出现 `DSH_*` 直接启动报错——所以专属名不能带 `DSH_` 前缀；`.env` 按启动目录分层（项目层 = 启动 cwd，用户层 = `~/.dsh/.env`）。

## 开发循环

```sh
pnpm install && pnpm run build     # 产物 lib/（index.js host 半 + client.js 浏览器半）
pnpm run typecheck                 # tsc --noEmit
```

- profile 以 pnpm 链接安装（`~/.dsh/profiles/web/node_modules/dsh-speech-plugin → 源码目录`），`pnpm run build` 后：浏览器半刷新页面即生效（模块注册表按内容 hash 出 rev）；host 半改动需重启 dsh。`pnpm link` 不会跑构建脚本，别用它替代 plugin add。
- 手工验证 ASR：macOS 可 `say -v Tingting "文本" -o t.aiff && afconvert -f WAVE -d LEI16@16000 -c 1 t.aiff t.wav`，剥掉 44 字节 WAV 头取 PCM，用 tsx 直接实例化 `DashscopeAsrSession` / `VolcengineAsrSession` 走完整会话，核对 partial/final 序列。
- 组合层检查：`dsh --profile web --dump-config | grep -A8 dsh-speech-plugin`。
- 源码运行的 fork 场景：`cd <harness> && pnpm dsh plugin --profile web add /绝对路径/dsh-speech-plugin`，从 harness 根目录启动（`.env` 项目层按启动目录解析）。

## 分发

- **npm（推荐）**：`pnpm run build && pnpm publish`，`files` 字段已列构建产物；用户 `dsh plugin --profile web add dsh-speech-plugin` 即装即用。
- **GitHub 直装**：`lib/` 构建产物提交入库（`.gitignore` 不忽略），`dsh plugin add github:huangdejie/dsh-speech-plugin#<sha>` 不需要任何生命周期脚本即可安装。改代码发布前记得 `pnpm run build` 并把产物一并提交，否则 git 装的用户拿到旧产物。
- **DSH Hub（dsh-hub.cc）**：在 [publish 页](https://dsh-hub.cc/publish) 用 GitHub 登录直接提交仓库地址（校验项是 package.json 的 `dsh.bundle.patch`）；`dsh-plugin` topic 也会被定时自动同步。
- 仓库已挂 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题便于被发现。

## 已知限制（开发者视角）

- 引擎/音色是部署级配置（cordis.yml 行），无浏览器内切换 UI；`asrEngine` 与 `engine` 独立解析但共享凭据函数。
- 火山 TTS 走 V3 单向流式；更低延迟的双向流式（边生成边合成）需接会话事件流，属后续方向。
- 首句超过 80 字时首段优化失效（整句按引擎上限硬切）；语速/音量偏好未暴露。
- 语音输入无说话人分离（开放麦克风）；ASR 无热词、无说话日志持久化。
- 无自动化测试；行为验证依赖真实 key 的手工会话脚本（见「开发循环」）。
