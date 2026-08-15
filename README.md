# dsh-speech-plugin

DeepSeek Harness 的树外语音播报插件：在 Web 对话界面为每条落定的助手消息加一个「播报」按钮，并提供「自动播报」开关。使用浏览器内置 Web Speech API（`window.speechSynthesis`），零 API key、零成本、离线可用。不修改 harness 仓库任何源代码。

## 功能

- **每条消息 🔊 按钮**：落在助手消息操作条（复制/分支/点赞旁边）。点击朗读该条回复的文本（只读正文，跳过思考与工具调用块）；朗读中再点即停止。朗读中的按钮显示停止图标。
- **自动播报开关**：会话头部工具区的喇叭按钮。开启后，新落定的助手消息自动朗读；历史消息（包括翻页加载的更早消息）不播。偏好持久化在 Host 设置文档（`ui-speech` namespace），跨标签页一致。默认关闭——浏览器会拦截无用户激活的自动发声，显式点击开关即完成激活。
- **特性检测**：环境没有 `speechSynthesis`（jsdom、非浏览器）时插件静默不注册，不报错。

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
src/speech-settings.ts   共享设置 schema（announce: 'off' | 'on'，默认 off）
src/index.ts             host 半：注册 ui-speech 设置 namespace
src/client/controller.ts 每会话控制器：speechSynthesis 封装（toggle/stop/状态可观察）
src/client/speech-watcher.ts  自动播报：订阅会话快照，水位线区分新旧消息
src/client/SpeechActions.tsx  消息操作条 🔊 按钮
src/client/AnnounceToggle.tsx 会话头部自动播报开关
src/client/index.ts      插槽注册（assistant-actions + header.utilities）
```

插槽契约由 ui-conversation 声明；本包只贡献条目。浏览器 bundle 以 `window.__ModuleLoader__.load` 包装，react/cordis/ui-slots/ui-primitives 等平台模块经外壳模块表共享（external 清单镜像 harness 的 `packages/client/web/src/platform.ts`）。

## 已知限制与后续

- 音色为操作系统自带（macOS「婷婷」等）；`voice`/`rate` 偏好未暴露。
- 长文本不分块；个别引擎对超长 utterance 有截断。
- 自动播报按「新落定」触发：订阅建立时已在场的消息不播（水位线机制，防止回放历史）。切换会话期间，仍在生成的旧会话消息完成时也会播报。
- 云端 TTS（真人音色）与流式打字机播报是规划中的 v2/v3：控制器 `toggle` 即替换缝，host 半加一个音频路由即可，UI 与订阅层不用动。
