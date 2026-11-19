[English](README.md) · **简体中文**

# pi-voice

给 [pi](https://pi.dev) 加上语音：**点一下耳机，说话，回答会被念出来。**

两个扩展让写代码的智能助手可以完全不看屏幕地使用——轻点蓝牙耳机开始听写，回答在流式输出的同时逐句朗读。用键盘输入的提问不会朗读，所以两种模式可以在同一个会话里共存，不需要切换开关。一切都在你自己的机器上运行：whisper.cpp 负责语音转文字，Kokoro 负责文字转语音。不需要 API key，不需要账号，音频不会离开本机。

```
点耳机 → "listening" → 说话 → 再点一次 → 转写发出 → 回答朗读
```

## 得到什么

- **免手操作听写**——轻点耳机开始和停止录音。便宜的耳机也能用：它们的按键以 AVRCP 命令的形式到达，而不是媒体键。
- **按键说话**——没有耳机？在空输入框里连按两次 `Enter` 开始录音，再按 `Enter` 结束。
- **朗读回答**——本地合成，边流式输出边播放。代码块和表格会被跳过，链接只读文字部分，按 `Enter` 或 `ctrl+s` 可以打断。
- **没有声音就不发送**——麦克风被静音、误触，或者 whisper 凭空编出的内容（例如 `[BLANK_AUDIO]`），都会在消耗一次调用之前被丢掉。

## 快速开始

```bash
git clone https://github.com/zshanhui/pi-voice ~/pi-voice
cd ~/pi-voice && ./scripts/setup.sh    # 缺什么装什么，大文件下载前会先询问
pi install ~/pi-voice                  # 或：pi -e ~/pi-voice 只试一次
```

然后轻点一次耳机开始说话。第一次需要在「系统设置 → 隐私与安全性 → 麦克风」里为你的终端授权，否则录到的全是静音。

在 pi 里验证：`/voice-doctor` 报告后端、模型、麦克风，以及哪个标签页会响应耳机点击；`/speak status` 报告音色、语速和引擎。

### 安装脚本

`scripts/setup.sh` 先检测已经有什么、告诉你缺什么，只有在你确认之后才开始下载。它是幂等的——随时可以重跑，包括移动过目录之后。

| 命令 | 作用 |
|---|---|
| `./scripts/setup.sh` | 引导式安装所有缺失的部分 |
| `./scripts/setup.sh --dry-run` | 只报告有什么、缺什么，不做任何修改 |
| `./scripts/setup.sh --yes` | 全程不询问（适合 dotfiles 引导、CI） |
| `./scripts/setup.sh --whisper small.en` | 安装另一个 whisper 模型 |
| `./scripts/setup.sh --api-only` | 不装本地模型，只检查有没有 API key |
| `./scripts/setup.sh --help` | 用法 |

它分五步执行，并逐步报告：

1. `ffmpeg`——录音（缺失时用 `brew install ffmpeg` 安装）
2. whisper.cpp 可执行文件 **和** ggml 模型——用于转写；如果有 mlx-whisper 或 API key 就跳过
3. Kokoro 虚拟环境，加上 `kokoro-v1.0.int8.onnx` 和 `voices-v1.0.bin`——用于语音合成
4. 把 `sidecar.py` 和提示音 wav 复制到位
5. 汇总，并给出接下来要执行的 `pi install` 命令

如果仍有需要处理的事项，它以 **退出码 1** 结束，方便引导脚本判断。可以用 `KOKORO_DIR` / `PI_SPEAK_KOKORO_DIR`、`CUES_DIR` / `PI_VOICE_CUES`、`PI_VOICE_MODELS_DIR`、`PYTHON` 改变安装位置，或用 `KOKORO_PKG="kokoro-onnx==0.4.9"` 固定 Python 包版本。所有下载只走 HTTPS，并且支持断点续传。

## 使用

| 操作 | 效果 |
|---|---|
| 轻点耳机 | 开始录音，再点一次停止并发送 |
| 连按两次 `Enter` | 用键盘开始录音（输入框为空时） |
| 录音时按 `Enter` | 接受转写并插入输入框 |
| 录音时按 `Escape` | 丢弃这段录音 |
| 它正在说话时按 `Enter` 或 `ctrl+s` | 停止播放 |
| 提交任何提问 | 也会停止播放 |

轻点耳机后，提示音「listening」会在录音真正开始之后才响——这句话的意思是*现在可以说话*——转写结果直接发给模型，因为你可能看不到输入框。用键盘听写则插入到输入框里，方便发送前修改。

| 命令 | 作用 |
|---|---|
| `/voice` | 切换录音状态（不用键盘手势的替代方式） |
| `/voice-doctor` | 已解析的后端、模型、麦克风，以及哪个标签页会响应点击 |
| `/voice-backend` | 显示已保存的转写后端及其实际解析结果 |
| `/voice-backend local\|whisper\|api\|auto` | 选择转写后端；跨会话保存 |
| `/speak` | 切换朗读开关 |
| `/speak on` / `/speak off` | 明确打开或关闭 |
| `/speak status` | 音色、语速、语言、引擎、停止快捷键 |
| `/speak stop` | 立刻停止播放 |
| `/speak last` | 重读上一条回答 |
| `/speak rate 240` | 每分钟词数；会保存 |
| `/speak voice` | 列出引擎里所有音色并选择 |
| `/speak voice af_heart` | 直接指定某一个；会保存 |
| `/speak zh` | 列出中文音色并选择 |
| `/speak zh zf_xiaobei` | 直接指定某一个 |
| `/speak uninstall` | 打印卸载命令 |

## 配置

全部通过环境变量配置；每一个都写在它所属扩展的文件头注释里。值得了解的几项：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PI_VOICE_MIN_DB` | `-40` | 静音阈值（dBFS）——低于此值的片段不会被转写 |
| `PI_VOICE_CUE_DELAY_MS` | `1000` | 念出「listening」之前先录音多久；设备慢就调大 |
| `PI_VOICE_EARBUD` | 开 | 设为 `0` 关闭耳机监听 |
| `PI_VOICE_BACKEND` | `auto` | `whisper-cli`、`parakeet`、`mlx` 或 `api`（需要 `PI_VOICE_API_KEY`） |
| `PI_SPEAK_VOICE` | `am_michael` | 朗读音色，例如 `af_heart`、`bm_george` |
| `PI_SPEAK_RATE` | `200` | 每分钟词数 |
| `PI_SPEAK_ONLY_VOICE` | 开 | 设为 `0` 时所有回答都朗读，包括对键盘提问的回答 |
| `PI_SPEAK` | 开 | 设为 `0` 时启动即为关闭朗读 |
| `PI_SPEAK_FOCUS` | 开 | 设为 `0` 时后台会话也会朗读 |

用 `/voice-backend`、`/speak voice` 和 `/speak rate` 做出的选择保存在 `~/.pi/agent/voice-*.json` 里。

## 两个扩展如何配合

两个扩展运行在同一个 pi 进程里，通过临时目录中的两个「仅本人可读」的文件协作：一个是麦克风锁（录音开始时写入，并在整个录音期间每两秒刷新一次，所以播放会停止，并且这道回答保持静默——之后可以用 `/speak last` 重读——而不是对着麦克风说话），另一个是每个会话一个的标记，记录这次提问是说出来还是打出来的（所以键盘提问得到静默回答）。

## 安全

以你本人的权限作为普通代码运行，只在录音时访问麦克风。运行期不访问网络，除非你配置了转写 API；没有任何遥测。威胁模型、涉及的全部资源，以及如何审计：见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm run setup    # 等同于 ./scripts/setup.sh
npm install
npm test         # 17 个测试：音量计算、提示音过滤、语音分块
```

## 限制

播放仅支持 macOS（使用 `afplay`）；一次只能有一段录音，因为播放和听写通过锁文件共用麦克风；只有当前聚焦的 pi 标签页会朗读或响应耳机点击——后台会话保持静默（设 `PI_SPEAK_FOCUS=0` 可以解除朗读的这条限制）。

## 卸载

```bash
pi remove ~/pi-voice
rm -rf ~/.pi/voice-kokoro ~/.pi/voice-cues ~/.pi/agent/voice-output.json
```

## 许可证

MIT
