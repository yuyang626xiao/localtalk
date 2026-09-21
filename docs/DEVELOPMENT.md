# LocalTalk 开发文档

> 本文收录目录结构、架构要点、与上游 Sokuji 的差异和 Roadmap。
> 使用说明请看根目录 [README.md](../README.md)。

## 目录结构

```
├── LICENSE                 AGPL-3.0（随 Sokuji 代码一并带过来的义务文件）
├── README.md               面向使用者的说明（GitHub 首页）
├── docs/USAGE.md           使用详版（面板语义全览）
├── docs/DEVELOPMENT.md     本文
├── app/                    Electron + Vite + React + TS 桌面应用
│   ├── electron/
│   │   ├── main.js             窗口、麦克风权限、注册 IPC（LT_SHOT=路径时自动截图）
│   │   ├── sidecar-host.js     启动/守护 python sidecar（读 {"port":N} 握手行）
│   │   └── preload.js          只暴露白名单 window.electron.invoke
│   ├── public/wasm/
│   │   ├── vad/silero_vad_v5.onnx   VAD 模型（2.3MB，随应用打包）
│   │   ├── gtcrn/gtcrn_simple.onnx  增强降噪模型（535KB，随应用打包）
│   │   └── ort/*.wasm|*.mjs         onnxruntime-web 运行时（版本必须与依赖精确一致）
│   └── src/
│       ├── App.tsx             应用壳：设置面板 + 会话接线 + 导出
│       ├── stores/
│       │   └── configStore.ts  持久化配置（按语言方向的模型选择、VAD、语速、提示词、显示）
│       ├── conversation/
│       │   ├── model.ts          对话条目模型 + 显示模式四态循环
│       │   └── export.ts         txt/json 导出（Sokuji 同款语义）
│       ├── components/
│       │   ├── ConversationView.tsx  对话流：工具栏（显示模式/字号/折叠/导出/清空）+ 时间线
│       │   ├── DeviceList.tsx        Sokuji 式设备列表（绿色选中行 + 环回警告 + ? 气泡）
│       │   └── VoiceCloneSection.tsx 音色克隆：录音/导入/校验/选择/试听/回放
│       ├── session/
│       │   ├── NativeSession.ts  管线编排（ASR→翻译→TTS 串行队列；PTT/自动双模式）
│       │   ├── NativeVad.ts      VAD worker 封装（init/feed/flush/edge 事件）
│       │   └── createNativeVadWorker.ts
│       ├── workers/
│       │   ├── native-vad.worker.ts   Silero v5 + vad-web FrameProcessor（移植自 Sokuji）
│       │   ├── gtcrn/                 GTCRN 降噪 worker + fft/audio-utils（移植自 Sokuji）
│       │   └── _shared/                 vad-thresholds / onnxruntime-all / vadConfig
│       ├── audio/
│       │   ├── MicRecorder.ts    getUserMedia（设备/降噪三档/直通监听）→ Int16 mono 24kHz
│       │   ├── resampler-worklet.js  线性重采样 worklet（40ms 一帧）
│       │   └── PcmPlayer.ts      24kHz Float32 队列播放（TTS 流式落地 + setSinkId 输出设备）
│       └── lib/native/         ← 移植自 Sokuji 的 WS-RPC 协议层（勿轻改）
│           ├── nativeProtocol.ts       消息类型定义（与 sidecar 的 wire_schema.json 对应）
│           ├── SidecarConnection.ts    一条 socket 一个实例的 RPC 传输层
│           ├── NativeModelClient.ts    目录/状态/下载管理
│           ├── NativeAsrClient.ts      asr_init + vad_mark + 二进制 PCM 上行
│           ├── NativeTranslateClient.ts translate_init / translate(+partial 流)
│           ├── NativeTtsClient.ts      tts_init / set_voice / tts_generate(流式)
│           ├── nativeCatalog.ts        提示词门控 / VRAM 预估 / 默认提示词预览
│           ├── nativeVoiceStores.ts    克隆音色的 IndexedDB 存储 + 校验
│           └── nativePreviewTts.ts     独立试听通道（移植自 Sokuji）
└── sidecar/                ← 原样复制的 Sokuji Python sidecar（AGPL-3.0）
    ├── sokuji_sidecar/         WS-RPC 服务：catalog/planner/accel + asr/translate/tts 引擎
    ├── tools/translate_probe.py 无头翻译探针（隔离麦克风测翻译方向是否正确）
    ├── requirements.txt        含 win_amd64 预编译 sokuji_native wheel（免编译）
    ├── setup-conda.ps1         一键建 conda 环境 localtalk + 装依赖 + 写 .python-path
    └── setup.ps1               普通 venv 方案（需系统 Python 3.11/3.12）
```

解释器解析顺序（`app/electron/sidecar-host.js`）：`$LOCALTALK_SIDECAR_PYTHON` →
`sidecar/.python-path` → `sidecar/.venv`。

## 架构要点（为什么这么设计）

- **每链路一个 sidecar 进程，每进程四条连接**：sidecar 按连接路由二进制帧、并在连接关闭时释放该连接
  加载的模型（VRAM 台账），所以 ASR / 翻译 / TTS / 模型管理各自 `new SidecarConnection()`，
  不要合并成一条。但**引擎本身是进程级单例**（跨连接最后一次 init 顶掉前一次），
  「我/对方」两个翻译方向无法共用一个进程：主进程持 speaker / participant 两个
  SidecarHost，渲染端连接带 lane 参数，IPC 按 lane 路由到对应 python 进程。
- **上行音频**：Int16 mono PCM @ 24kHz，裸帧直接 sendBinary；sidecar 自己重采样到 16k float。
- **分段**：两种模式共用一条原则——**断句标记只来自 VAD worker**。渲染端跑 Silero v5
  （`workers/native-vad.worker.ts`，onnxruntime-web + `@ricky0123/vad-web` 的
  FrameProcessor，移植自 Sokuji）：音频（含静音）**持续**喂给 ASR 与 VAD，VAD 的
  start/end 边沿转成 `vad_mark` 控制 sidecar 的 0.7s 预滚分段；短于「最短语音」的
  误触发发 cancel 丢弃。PTT 松手 = 补 700ms 静音尾 + flush（VAD 不可用时退回手动
  start/end 标记）。**麦克风常开时的 PTT 竞态**：按键瞬间若 VAD 已在说话中（开口
  早于按键），NativeVad 镜像的 speaking 状态会驱动立即补发 start 标记，否则这段
  语音会进不了分段。AudioWorklet 里**不要用 `globalContext`**（Chromium 130 已移除，
  Electron 34 直接 ReferenceError、worklet 静默饿死整条音频链）——用全局 `sampleRate`。
  `onnxruntime-web` 版本被精确钉死（无 caret）：`public/wasm/ort/`
  里的运行时文件必须与依赖版本一致，升级要同步换文件。
- **Electron 里的 VAD 环境**：dev 服务器给所有响应加 COOP/COEP 头（ESM worker 需要），
  打包版用 `enable-features=SharedArrayBuffer` 开关替代；另加三个
  disable-*-backgrounding 开关，防止窗口隐藏时 Chromium 限流 VAD 的定时器。
- **降噪图在重采样 worklet 之后**：标准档把 `srcNode → rnnoise → resampler` 重接线；
  增强档劫持 resampler 的 port 消息，把 24kHz Int16 转给 GTCRN worker（内部降到 16k
  推理再升回，输入采样率是 init 参数——与 Sokuji 的 48k 管线不同）。GTCRN worker 与
  VAD 共用同一份钉死版本的 onnxruntime-web 和 `public/wasm/ort/`，单线程运行；
  worker 跨麦克风开关存活（PTT 松手不重载模型），随会话 dispose 才终止。
- **TTS 下行**：`tts_chunk` JSON 之前紧跟其二进制帧（Int16@24k），协议层按
  "binary-then-JSON" 顺序配对；流式家族必须走 `generate(..., onChunk)`。
- **试听走独立连接**（`app/src/lib/native/nativePreviewTts.ts`，移植自 Sokuji）：引擎是进程
  单例，预览若自己 init 会把**在跑会话的 TTS 顶掉**——所以会话开着且已加载 TTS 时
  复用会话客户端；没有会话才用预览专属连接（保温复用，模型+语言都没变不重 init）。
  会话刚关闭时 sidecar 可能仍记着死连接的引擎所有权，`_not_owner_error` 恢复一次
  （重 init+重放音色+重试），二次失败照实上抛。语言不是装饰参数：init 时写进引擎，
  换语言必须重 init，否则用旧音素体系念新语言。
- **模型解析全在 sidecar 侧**（catalog 卡片 + planner 按显存排行程 + 下载走 HF），
  渲染端只管挑卡、点下载、把 `model id / variant` 传进 init——所以移植极薄。
- **离线 ASR 没有中间 partial**：Cohere Transcribe / Qwen3-ASR / whisper 这类卡片
  （无 `backend="native_asr_stream"`）只在 end 标记后整段转写一次，结果先于 flush
  的 'ok' 应答返回；对话流的原文行必须能在「无 partial」下直接创建。
- **底栏自适应用容器查询**：`.stage` 是 size container，≤720px 折两行、≤700px 隐藏
  方向标签。注意 `@container` 覆盖块必须写在 `flex: 1` 等简写规则**之后**——同特异性
  下简写会把 `flex-basis` 重置回去（踩过）。

## 与 Sokuji 的差异（v0 砍掉的东西）

浏览器扩展、云端 providers（OpenAI/Gemini/…）、账号体系、虚拟声卡、字幕浮窗、
打包/自动更新、评测与 parity 工具链——都与本地单机翻译无关，没带过来。
native/（C++ 源码）不需要：直接用官方发布的 win wheel。

## Roadmap（按性价比排序）

1. ~~连续翻译模式：移植 `native-vad.worker.ts`（vad-web Silero VAD），PTT 与连续双模。~~
   ✅ 已完成（自动模式 + VAD 设置面板）。
2. 量化档位选择：暴露 `list_variants`，小显存机器手动钉档位。
3. ~~音色克隆：`setReferenceVoice`（qwen3_tts / omnivoice 等家族需要参考音频+转写）。~~
   ✅ 已完成（录音/导入/校验/IndexedDB 存储/独立试听，见 README「使用」）。
4. ~~输出设备选择 + 回声规避（参考 Sokuji 的 audio 设备 store）。~~
   ✅ 已完成（音频设备面板：麦克风/扬声器/噪声抑制/原声直通）。
5. 双轨对话（对方声轨）：✅ 已完成（「对方/两者」通道模式，participant 独立进程）。
6. electron-builder 打包 + 图标。
7. （若想完全摆脱 Sokuji）按 clean-room 重写 sidecar：只保留 llama.cpp/transcribe.cpp/
   audio.cpp 三个引擎的薄封装 + 自己的简化 RPC。
