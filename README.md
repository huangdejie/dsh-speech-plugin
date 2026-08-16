# dsh-speech-plugin

DeepSeek Harness 的树外语音播报插件：在 Web 对话界面为每条落定的助手消息加一个「播报」按钮，并提供「自动播报」开关。优先使用云端 TTS（阿里百炼 / 火山豆包语音，神经音色），不可用时自动回退浏览器 Web Speech API。不修改 harness 仓库任何源代码。

## 功能

- **每条消息 🔊 按钮**：落在助手消息操作条（复制/分支/点赞旁边）。点击朗读该条回复的正文（自动剥离 markdown、跳过代码块与图片）；朗读中再点即停止。
- **自动播报开关**：会话头部工具区的喇叭按钮。开启后，新落定的助手消息自动朗读；历史消息（包括翻页加载的更早消息）不播。偏好持久化在 Host 设置文档（`ui-speech` namespace），跨标签页一致。默认关闭——浏览器会拦截无用户激活的自动发声，显式点击开关即完成激活。
- **云端 TTS（v2）**：host 侧路由 `/dsh-speech/tts` 代理合成请求，API key 只存在于 host 进程环境变量，浏览器永远接触不到。同文本命中内存缓存，重复点击不重复计费。
- **自动回退**：未配置云端引擎、key 无效、网络失败或文本超长时，自动退回系统音色（`speechSynthesis`）继续播报。
- **特性检测**：非浏览器环境（jsdom、node e2e）没有 `window`/`Audio` 时插件静默不注册，不报错。

## 云端 TTS 配置

引擎选择逻辑（config `engine`）：

| engine | 行为 |
|---|---|
| `auto`（默认） | 有 `DASHSCOPE_API_KEY` 用百炼；否则有火山凭据用火山；否则系统音色 |
| `dashscope` | 强制百炼（缺 key 启动日志提示，路由 503 → 浏览器回退） |
| `volcengine` | 强制火山豆包语音 |
| `system` | 永远用浏览器系统音色 |

环境变量（放 harness 仓库根目录 `.env`，和 `DEEPSEEK_API_KEY` 同一处）：

```sh
DASHSCOPE_API_KEY=sk-...                    # 阿里百炼 API key
VOLCENGINE_TTS_API_KEY=...                  # 火山控制台 API Key（API Key 管理页创建；
                                            #   旧名 VOLCENGINE_TTS_ACCESS_TOKEN 仍被识别）
```

可选配置：在 profile 的 `cordis.patch.yml`（`~/.dsh/profiles/web/cordis.patch.yml`）里覆盖插件行——

```yaml
- id: ui-speech
  config:
    engine: volcengine            # auto | system | dashscope | volcengine
    dashscopeModel: qwen3-tts-flash
    dashscopeVoice: Cherry
    volcengineVoice: zh_female_vv_uranus_bigtts   # 必须 2.0 系音色；公版音色会报 55000000
    volcengineResourceId: seed-tts-2.0  # 必须与开通的服务版本一致（2.0 = seed-tts-2.0）
    maxTextLength: 8000           # 单条消息合成字符上限（成本闸门，超出回退系统音色）
    cacheEntries: 64              # 合成结果内存缓存条数
```

火山走 **V3 单向流式 HTTP 接口**（`/api/v3/tts/unidirectional`），`volcengineResourceId` 必须匹配你在控制台开通的服务版本——开通的是「语音合成大模型 2.0」就填 `seed-tts-2.0`（resource id 与音色版本不匹配会报 55000000）。计费与音色列表见官方文档：[百炼语音合成](https://help.aliyun.com/zh/model-studio/qwen-tts-api)、[火山豆包语音](https://www.volcengine.com/docs/6561/1257584)。长消息自动按句切成引擎限额内的分段顺序合成播放。

## 安装（针对源码运行的 fork）

```sh
# 一次性：构建插件
cd ~/code/dsh-speech-plugin && pnpm install && pnpm run build

# 装进 web profile（首次会自动初始化 ~/.dsh/profiles/web）
cd ~/code/open/fork/deepseek-harness
pnpm dsh plugin --profile web add /Users/huangdj/code/dsh-speech-plugin

# 验证组合层（应看到 "# == dsh-speech-plugin" 层）
pnpm dsh --profile web --dump-config | grep -A2 dsh-speech-plugin

# 启动
pnpm dsh --profile web     # http://127.0.0.1:3080
```

对话需要在 fork 根目录 `.env` 里配置 `DEEPSEEK_API_KEY`。

## 卸载

```sh
pnpm dsh plugin --profile web remove dsh-speech-plugin
```

## 开发循环

改代码后 `pnpm run build`（pnpm link 不跑构建脚本），浏览器刷新即可——模块注册表按内容 hash 生成 rev，改动自动生效。`pnpm run typecheck` 做类型检查。

## 结构

```
src/config.ts            插件 Config schema（引擎/模型/音色/上限/缓存）+ 默认值
src/speech-settings.ts   共享设置 schema（announce: 'off' | 'on'，默认 off）
src/index.ts             host 半：设置 namespace + /dsh-speech/tts 路由
src/tts/types.ts         provider 契约（分段合成、媒体类型、限额）
src/tts/dashscope.ts     阿里百炼 provider（REST，Bearer key，Base64 wav）
src/tts/volcengine.ts    火山豆包 provider（V3 单向流式 HTTP，App-Id/Access-Key/Resource-Id 头）
src/tts/split-text.ts    按句切分成引擎限额内的分段
src/tts/service.ts       引擎解析（auto 优先级）+ 顺序合成 + LRU 缓存
src/client/controller.ts 每会话控制器：云端分段播放，失败回退 speechSynthesis
src/client/clean-text.ts markdown/代码块剥离，只留可读文本
src/client/speech-watcher.ts  自动播报：订阅会话快照，水位线区分新旧消息
src/client/SpeechActions.tsx  消息操作条 🔊 按钮
src/client/AnnounceToggle.tsx 会话头部自动播报开关
src/client/index.ts      插槽注册（assistant-actions + header.utilities）
```

插槽契约由 ui-conversation 声明；本包只贡献条目。浏览器 bundle 以 `window.__ModuleLoader__.load` 包装，react/cordis/ui-slots/ui-primitives 等平台模块经外壳模块表共享（external 清单镜像 harness 的 `packages/client/web/src/platform.ts`）。

## 已知限制与后续

- 播放是流式的：host 边合成边以 NDJSON 推送分段，浏览器收到第一段（≤80 字小段，实测约 1~2 秒）即开始播放，其余分段在播放期间陆续到达；重复点击同一条消息命中缓存，即时回放。
- 火山凭据是控制台 API Key（`X-Api-Key`）；resource id 与开通版本、音色版本三者要匹配（2.0 音色 + seed-tts-2.0）。
- 引擎/音色是部署级配置（cordis.yml），浏览器内切换音色 UI 未做。
- 自动播报按「新落定」触发：订阅建立时已在场的消息不播（水位线机制，防止回放历史）。切换会话期间，仍在生成的旧会话消息完成时也会播报。
- 回退的系统音色质量取决于操作系统；macOS 可在 系统设置 → 辅助功能 → 朗读内容 下载增强版中文音色。
