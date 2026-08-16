# dsh-speech-plugin

DeepSeek Harness 的语音插件：为每条助手消息提供「播报」、会话级「自动播报」开关，以及输入框的「语音输入」麦克风。云端 TTS/ASR 支持阿里百炼与火山豆包，播报与输入可各选一家；云端不可用时播报自动回退浏览器系统音色。以独立插件安装，不修改 harness 仓库任何源代码。

## 功能

- **🔊 每条消息播报**：点消息操作条的喇叭即朗读该条回复正文（自动剥离 markdown 与表情符号、跳过代码块和图片）；朗读中再点即停止。
- **📣 自动播报**：会话头部的喇叭开关，开启后新完成的回复自动朗读，历史消息不播；偏好按浏览器本地存储，默认关闭。
- **🎤 语音输入**：点麦克风开始说话，识别结果实时写入输入框草稿；再点一次结束并发送，或直接点发送（发送即终止收音，不留尾巴、不继续消耗额度）。
- **☁️ 双引擎任意组合**：播报与语音输入各自独立选阿里百炼或火山豆包，也可都走同一家。
- **🔇 优雅回退**：云端凭据缺失、失效或失败时，播报自动回退浏览器系统音色，语音输入按钮禁用并提示原因，控制台均有日志。

## 快速开始

**① 安装**（任选其一）：

```sh
# 从 npm 安装：构建产物已在包内，装完即用
dsh plugin --profile web add dsh-speech-plugin

# 从本地目录安装：源码仓库须先构建
git clone https://github.com/huangdejie/dsh-speech-plugin
cd dsh-speech-plugin && pnpm install && pnpm run build
cd <你的 deepseek-harness 目录>
dsh plugin --profile web add /绝对路径/dsh-speech-plugin
```

**② 取一个云端 key**（二选一，见下方「凭据获取」）：

**③ 配置并重启**：

```sh
# 全局安装的 dsh：放启动 dsh 的 shell 环境（如 ~/.zshrc）
# 源码运行的 fork：放 harness 仓库根目录 .env（与 DEEPSEEK_API_KEY 同一处，且从仓库根目录启动）
export SPEECH_DASHSCOPE_API_KEY=sk-...      # 或 SPEECH_VOLCENGINE_API_KEY=...
```

重启 dsh，打开 http://127.0.0.1:3080：点 🔊 播报消息；点 🎤 授权麦克风后说话。

只配一个 key、不写任何配置文件即可使用——引擎默认 `auto`，按已有凭据自动选择（两家都有时百炼优先）。

## 凭据获取

| 家 | 入口 | 要点 |
|---|---|---|
| 阿里百炼 | [百炼控制台](https://bailian.console.aliyun.com) → API-KEY | `sk-` 开头；**一个 key 同时用于 TTS 与 ASR**；欠费（Arrearage）会拒一切调用 |
| 火山豆包 | [语音控制台](https://console.volcengine.com/speech/app) → **API Key 管理** | 必须是控制台 API Key，**不是**应用级 Access Token（也无须 APP ID）；开通的服务须与资源 ID 对应 |

## 配置

### 环境变量（共 2 个）

```sh
SPEECH_DASHSCOPE_API_KEY=sk-...   # 阿里百炼：TTS + ASR
SPEECH_VOLCENGINE_API_KEY=...     # 火山豆包：TTS + ASR
```

放哪都行：harness 仓库根目录 `.env`（源码运行，与 `DEEPSEEK_API_KEY` 同处）、`~/.dsh/.env`（全局安装）、或启动 dsh 的 shell 环境。注意变量名不要写成 `DSH_` 开头（如 `DSH_SPEECH_*`）：harness 启动层把 `DSH_` 前缀保留为自举命名空间，`.env` 里出现任何 `DSH_*` 都会启动报错。

### 引擎组合（可选，`~/.dsh/profiles/web/cordis.patch.yml`）

```yaml
- id: ui-speech
  config:
    engine: dashscope       # 播报：auto | dashscope | volcengine | system
    asrEngine: volcengine   # 语音输入：auto | dashscope | volcengine | off
```

`engine` 与 `asrEngine` 完全独立。常用组合：

| 想要的效果 | engine | asrEngine | 需要的 key |
|---|---|---|---|
| 全自动（默认，零配置） | `auto` | `auto` | 任一家的 |
| 播报阿里 + 输入火山 | `dashscope` | `volcengine` | 两家的 |
| 播报火山 + 输入阿里 | `volcengine` | `dashscope` | 两家的 |
| 只播报，不要语音输入 | 任意 | `off` | 对应家的 |

### 全部可配字段（均有默认值，按需覆盖）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `engine` | `auto` | 播报引擎，见上表 |
| `asrEngine` | `auto` | 语音输入引擎，见上表 |
| `dashscopeModel` | `qwen3-tts-flash` | 百炼合成模型 |
| `dashscopeAsrModel` | `paraformer-realtime-v2` | 百炼实时识别模型 |
| `dashscopeVoice` | `Cherry` | 百炼音色 |
| `volcengineVoice` | `zh_female_vv_uranus_bigtts` | 火山音色（须 2.0 系；公版音色会报 55000000） |
| `volcengineResourceId` | `seed-tts-2.0` | 火山合成资源 ID，须与开通版本一致 |
| `volcengineAsrResourceId` | `volc.seedasr.sauc.duration` | 火山识别资源 ID：2.0 小时版；**1.0 用 `volc.bigasr.sauc.duration`**，并发版把 `duration` 换 `concurrent` |
| `maxTextLength` | `8000` | 单条播报字符上限（成本闸门，超出回退系统音色） |
| `cacheEntries` | `64` | 合成结果内存缓存条数 |

改配置后重启 dsh 生效；查看合成结果：`dsh --profile web --dump-config | grep -A8 dsh-speech`。

## 使用说明

- **播报**：点击消息下的 🔊；长回复边合成边播（首段 1~2 秒出声），同一条重复点击命中缓存即时重放。
- **自动播报**：点会话头部喇叭开启（浏览器要求先有一次显式点击才允许发声）；换设备/浏览器需各自开启。
- **语音输入**：点 🎤 开始，实时看到识别预览；句末自动落定（带标点）。结束方式二选一：再点 🎤，或直接点发送——发送会立即停止收音，屏幕上已识别的文字随消息一起发出。

## 故障排查

浏览器 DevTools 控制台里 `[dsh-speech]` 开头的警告自带具体原因；服务端日志 `dsh-speech:` 前缀同理。

| 现象/警告 | 原因与处理 |
|---|---|
| `tts-unavailable` | 指定引擎的 key 没配或没进进程（源码运行须从 harness 仓库根目录启动，项目层 `.env` 按启动目录找）；或 `engine: system`。配置后重启 |
| `dashscope ... Arrearage` | 百炼账户欠费，费用中心结清 |
| `load grant not found in SaaS storage` | 火山凭据类型不对：V3 只认控制台 API Key，应用级 Access Token 不行；或 key 未绑定服务授权 |
| `55000000 resource ID is mismatched with speaker` | 火山 `volcengineResourceId` 与音色版本不匹配（2.0 授权配 2.0 音色） |
| `asr-start: asr handshake rejected (http 403)`（火山） | key 未被授权当前 `volcengineAsrResourceId`：开通的是 1.0 就配 `volc.bigasr.sauc.duration`，或去控制台给 key 关联对应资源 |
| `asr-start: asr handshake rejected (http 401/403)`（阿里） | `SPEECH_DASHSCOPE_API_KEY` 无效或账户欠费 |
| `text-too-long` | 清洗后文本超过 `maxTextLength`，已回退系统音色；确需更长可调大（成本自负） |
| 点击后 1~2 秒才出声 | 正常：云端神经合成延迟，已是流式首段优先的极限；缓存命中即时 |
| 没有麦克风按钮 / 按钮禁用 | 两家 key 都没配，或 `asrEngine: off`；按提示补 key 后重启 |
| 点击麦克风后一直「连接中」 | 浏览器→host 的 WebSocket 被代理/防火墙阻断；或云端握手失败，看控制台警告 |
| 麦克风授权被拒 | 浏览器地址栏 🔒/🎤 图标改回允许，刷新页面 |
| 启动报 `EADDRINUSE :3080` | 旧实例占端口：`lsof -ti :3080 \| xargs kill` |

## 已知限制

- 引擎与音色是部署级配置，浏览器内切换音色的 UI 未做。
- 自动播报按「新完成」触发；切换会话期间，旧会话仍在生成的消息完成时也会播报。
- 语音输入是开放麦克风，不做说话人分离：录音期间环境人声也会被识别。
- 回退的系统音色质量取决于操作系统；macOS 可在 系统设置 → 辅助功能 → 朗读内容 下载增强版中文音色。

## 开发者文档

架构、双引擎协议细节、源码结构与开发循环、分发方式见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
