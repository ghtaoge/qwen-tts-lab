# Qwen Voice Lab

Qwen3-TTS **0.6B CustomVoice** 本地中文语音项目，包含网页、微信小程序和 ESP32-S3 N16R8 固件。默认等待整条语音转换完成，再自动播放，避免CPU生成速度跟不上播放时断续。手机播放完整WAV，开发板在生成完成后接收已就绪的片段并连续输出。已生成的语音可以点击重播，无需重新转换。没有云端TTS调用或演示音替代模式。

## 安装与电脑试听

使用 **Windows x64、Python 3.12**。在项目目录打开 PowerShell：

```powershell
.\setup.ps1 -Python C:\Python312\python.exe
.\download-model.ps1
# 优先生成速度：转换已有官方模型，安装加速后端
.\.venv\Scripts\python.exe tools\prepare_fast_engine.py
.\start.ps1
```

打开 **http://127.0.0.1:8766**。已有环境和加速资产时，双击 `start.cmd` 或 `start-fast-cpu.cmd` 使用量化CPU后端；`start-cpu.cmd` 使用原版Torch CPU FP32回退。三个入口均将临时目录、Hugging Face缓存及Numba缓存放在项目 `.downloads/` 下。PowerShell的 `start.ps1` 仍默认使用 `-Backend auto -Device auto`，用于自动选择引擎和尝试显卡。

启动会在后台加载、预热，等待页面提示“模型已预热”后再比较生成速度。`stop.cmd` 仅停止本项目服务；切换后端、CPU/CUDA或局域网模式前先停止旧服务。

没有可用显卡时，可使用独立的CPU安装与启动流程：

```powershell
.\setup.ps1 -Backend CPU -Python C:\Python312\python.exe
.\download-model.ps1
.\.venv\Scripts\python.exe tools\prepare_fast_engine.py
.\start.ps1 -Backend fast -Device cpu
```

这里的 `-Device cpu` 同时禁用原生Talker/Predictor的Vulkan推理，并让语音解码器使用CPU。状态接口将其标记为 `gguf-cpu-stateful-codec`，避免将量化CPU推理显示为Vulkan。

主模型、PyTorch安装包、下载缓存和导出中间文件均较大，全新安装建议预留约20GB可用磁盘空间；已有模型和主环境时，加速转换仍需额外若干GB。首次下载和CPU转换可能需要一段时间，不属于每次语音生成耗时。模型默认从ModelScope下载，可改为 `download-model.ps1 -Source huggingface`；本地目录包含 `speech_tokenizer`，推理时不再下载模型。

`setup.ps1` 将PyTorch/torchaudio固定为2.7.1，CUDA安装使用12.6构建。大文件下载中断可重试；`tools/fetch_wheel.py` 提供Windows Python 3.12官方cu126 wheel的分块续传和响应头SHA256校验。其他项目的Python环境不受影响。

## 加速后端与原版后端

两种后端使用同一份官方 **Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice** 权重和内置音色，不需要训练、自定义声音或风格指令。

| 选择 | 实现 | 行为 |
|---|---|---|
| `auto`，默认 | 资产齐全时使用加速后端，否则使用原版Torch | `/api/status` 的 `backend` 显示实际选择 |
| `fast` | Talker Q5_K、Predictor Q8_0 GGUF；Vulkan或CPU原生推理；原始有状态语音解码器 | 内部持续合成PCM片段，默认整条完成后再播放 |
| `torch` | 官方Qwen-TTS Python/PyTorch推理 | 保留原版回退路径，按句输出音频 |

量化会改变数值计算，输出不保证与原版逐样本一致；这里没有更换成其他TTS模型。加速后端基于 [Qwen3-TTS-GGUF](https://github.com/HaujetZhao/Qwen3-TTS-GGUF) 的固定提交和官方 [llama.cpp b10621](https://github.com/ggml-org/llama.cpp/releases/tag/b10621) Windows Vulkan二进制。下载二进制会校验固定SHA256。

```powershell
# 检查已准备的资产，不下载、不生成语音
.\.venv\Scripts\python.exe tools\prepare_fast_engine.py --check
# 强制使用加速后端
.\start.ps1 -Backend fast
# 加速后端不适配当前机器时，停止服务后选择原版
.\start.ps1 -Backend torch
# 原版CPU模式
.\start.ps1 -Backend torch -Device cpu -Precision float32
```

转换工具只写入被Git忽略的 `acceleration/`，从已有官方模型提取并量化权重，不下载其他TTS模型。它另外创建 `acceleration/.venv-fast/`，在其中安装CPU版Torch进行转换，避免再次加载CUDA版Torch占用大量系统提交内存；主 `.venv` 的CUDA版Torch保持不变。运行服务仍使用主 `.venv`。重新导出时，先停止服务，再运行 `tools/prepare_fast_engine.py --rebuild`。

Windows上的Vulkan原生推理与PyTorch使用不同OpenMP运行库，因此加速后端通过独立子进程运行Talker/Predictor，主进程运行原始解码器。关闭服务时会清理工作进程。`auto` 只按资产是否齐全选择，不会在运行错误时悄悄切换模型；出现不兼容错误时，可明确选择 `-Backend torch`。

**两种后端都不依赖FlashAttention。** 原版Torch使用SDPA；支持GPU BF16时默认BF16，否则使用FP32。加速后端的GGUF精度固定，解码器在支持BF16的CUDA显卡上使用BF16，其余使用FP32；`-Precision` 参数用于原版Torch。FP16曾在本机触发GPU执行异常，因此不是默认方案。`setup.ps1 -Backend CPU/CUDA` 选择安装的Torch构建，`start.ps1 -Backend auto/fast/torch` 选择运行引擎。

**GTX 1050 Ti的GPU推理尚未实测。** 已在i5-8300H、32GB内存、GTX 1050 Ti 4GB的电脑上验证量化CPU模式；当前430.81驱动下，原生加速库未列出该NVIDIA显卡，因此这些CPU结果不代表GPU速度。相同短句、关闭缓存时，纯推理由原版约22.57秒降到8.56～8.84秒，首段约1.91～1.93秒可用，详见 `TEST_RESULTS.md`。

GTX 1050 Ti不支持原生GPU BF16，不能套用下述RTX 3050结果。可以单独尝试Vulkan加速后端并检查运行、显存和速度；原版回退可先用CPU FP32，原版CUDA FP32在4GB显存下可能不足。加速安装脚本当前验证的平台是Windows x64与Python 3.12；使用Vulkan推理需要兼容的显卡驱动，量化CPU模式不要求可用的Vulkan设备。

## 真实速度与计时口径

**当前默认播放策略为 `playback_mode=complete`。** 生成期间不会向客户端或开发板发布可播放片段；全部成功后再自动播放。下面保留的历史首包速度和延迟优化记录来自流式测试，不代表当前默认开始播放的时间。仅在明确进行流式实验时可通过API设置 `playback_mode=stream`。播放策略不影响声音或缓存键。

以下既有GPU测试来自 **RTX 3050 Laptop 4GB、i5-11260H、约16GB内存**，与上文CPU测试使用不同机器，结果分别记录。以下均为Serena、1.0倍速、关闭缓存的真实生成：

| 场景 | 首段可用或下载 | 完整生成/接收 | 音频时长 |
|---|---|---|---|
| 原版Torch对照 | 本机HTTP首段约9.49秒 | 约9.49秒 | 2.72秒 |
| 加速后端，GPU连续工作 | 服务发布首段约0.25秒 | 服务处理约1.0秒 | 2.88秒 |
| 加速后端，GPU空闲后降频 | 服务发布首段约0.57～1.90秒 | 服务处理约1.3～2.7秒 | 2.88秒 |
| 加速后端，较长中文段落、GPU已工作 | 本机HTTP首段约0.30秒 | 本机HTTP全部接收约4.56秒 | 11.68秒 |
| 加速后端，协议2模拟接收 | 提交到首PCM缓冲约0.446秒 | 生成2.551秒，全部接收2.566秒 | 6.32秒 |

较早冷启动仅加载模型约9～11秒，第一次内核预热还可能增加数秒；最新重启测得加载8.018秒、预热1.274秒，合计约9.3秒就绪。笔记本GPU空闲后会从P0降到P8，本机测得210MHz与1980MHz的差异；因此“模型已加载”不意味着每次请求都能达到连续生成的最快值。完整记录及各项口径见 `TEST_RESULTS.md`。

- **全部音频就绪**：默认完整播放策略下，`playback_ready_seconds` 和 `first_audio_seconds` 都表示整条转换完成的时间，之前为空；客户端下载及播放缓冲另计。内部首段生成时间保留在 `first_generated_part_seconds`，不表示可以提前播放。
- **历史流式首包可用**：从任务创建到首个已关闭、可下载WAV发布，包含排队、本次加载、生成和首段后处理，不包含客户端下载或播放缓冲。
- **纯推理耗时**：生成器实际计算时间之和，不包含客户端等待和WAV发布；**RTF**为该耗时除以最终音频时长，小于1表示平均生成速度快于播放。改变语速会改变该比值。
- **手机/浏览器开始试听**：客户端实际启动音频播放的时间；**ESP32开始播放**来自固件首次I²S写入的确认，离线或未回报时显示空值。I²S写入并不等同于用麦克风测量喇叭发声。
- 本机HTTP下载一个片段通常约5～7毫秒，个别请求约30毫秒。它不代表手机Wi-Fi或物理ESP32的下载延时。协议模拟器和播放调度模拟也不能替代实物验证。
- 缓存命中复用已有音频，不代表模型推理性能。Torch显存统计只包含该进程的PyTorch分配；加速后端另有Vulkan工作进程，不将Torch统计冒充总显存。

准备好服务后，可复测真实模型与HTTP音频下载：

```powershell
.\.venv\Scripts\python.exe tools\benchmark_latency.py --output logs\latency-benchmark.json
```

连续运行和空闲一段时间后运行应分别记录。该工具固定关闭缓存，记录服务发布、客户端下载和模拟播放断供，不向设备投递任务。可按 [NVIDIA官方说明](https://nvidia.custhelp.com/app/answers/detail/a_id/3130)尝试给项目Python设置“最高性能优先”，再测空闲后的响应；此设置对当前Vulkan驱动的效果尚未验证，程序不会自动修改系统电源或驱动设置。

## 网页功能

- 最多300字符，5种中文内置音色和4种其他语言音色。
- 模型加载、预热、硬件识别、任务状态、错误和计时显示。
- 转换完成后自动播放完整音频；浏览器阻止自动播放时可点击播放，播放结束后可从头重播。
- 完整WAV下载、最近记录、内容缓存、停止生成与播放。
- 语速0.75～1.50倍，通过FFmpeg `atempo` 流式后处理保持音高；试听音量只影响浏览器。

## OLED 屏幕小剧场

小程序和网页新增“屏幕玩法”，随下一次文字一起发送。默认“声波伙伴”，另有“声波电台”和“专注文字”。在电脑打开 [互动设计预览](http://127.0.0.1:8766/oled-preview.html)，也可直接打开 `static/oled-preview.html`。预览使用模拟振幅，不合成声音、不连接设备，字体效果以实物字库为准。

| 阶段 | 屏幕反应 | 驱动依据 |
|---|---|---|
| 待机 | 伙伴眨眼、安静等候 | 无活动任务 |
| 排队/生成 | 等候气泡、顶部阶段提示 | 服务真实 queued/loading/synthesizing 状态 |
| 接收与缓冲 | 小沙漏，正文继续保留 | 等待首包或播放暂时断供 |
| 正在播放 | 嘴巴开合，或声柱随音量起伏 | ESP32实际送入I²S的、经过音量缩放的PCM |
| 完成 | 短暂爱心/举手庆祝，再安静下来 | I²S播放结束后的确认 |
| 停止/出错 | 安静休息/困惑表情 | 取消或真实错误状态 |

声波伙伴与电台在左侧占42像素，右侧保留中文3行；专注文字使用完整128像素宽度。文字在首次开始播放时回到第一页，再每3秒轮播。嘴型跟随振幅，不声称逐字口型或字幕精确对齐；电台声柱是振幅驱动装饰，不做FFT频谱分析。

性能优先：

- 动画由独立低优先级显示任务绘制，音频首包不等待开场或显示刷新。
- 复用PCM转换循环计算整数平均绝对振幅，没有新的模型调用、FFT或整段音频复制；静音时嘴型和柱高归零。
- 常规动画上限8fps；重要状态变化可优先刷新。只比较并传输改变的8×8像素区域，画面不变时不发I²C数据。SDA=8、SCL=9及100kHz兼容时钟保持不变。
- `display_mode` 复用现有任务/清单通信，不参与音频缓存键。同一句话换玩法可继续复用WAV；选择玩法本身不额外发送网络请求。
- 任务完成后串口输出 `[OLED] frames=... payload_bytes=... max_flush_us=...`，便于上板后检查实际显示负载。这里的字节统计是像素载荷，不含I²C协议开销。

新固件需重新编译烧录，旧固件会忽略新增显示字段。没有增加硬件模块。当前已完成代码、协议测试与编译，实体动画帧率、声画延时及微信真机效果仍需设备验证。

## 第二轮延迟优化

- 网页和小程序通过 `revision`、`after_parts`、`wait_ms=1000` 等待任务变化。新音频发布后立即唤醒请求，不再在每次响应后固定等待150毫秒；旧后端没有revision时仍回退普通轮询。等待使用异步通知，不占住服务器HTTP线程。
- ESP32清单也接入发布通知，不再靠20毫秒间隔发现首包。固件领取任务后直接请求清单，OLED通过独立任务刷新，保留GPIO8/9及100kHz；控制连接复用TCP。先预装有效PCM再启动I²S，避免开启空DMA环。
- 整条任务只启动一个FFmpeg变速管线，跨文本分句保留滤镜状态，减少长文本的重复进程启动。变速滤镜有前瞻要求，1.15倍速的首包可能需要等下一模型包；保留约0.24秒音频缓冲，避免只为更低首包数字而引入断流。
- 网页默认在整条转换完成后下载并解码完整WAV，再启动播放；小程序也只播放完整文件，减少重复页面数据传输。停止、断线和旧请求回包仍有独立防护。
- 原生模型推理默认启用两项等输出优化：KV清理只清有效元数据；Predictor仅对合法2048候选采样。5轮交叉对照中位耗时1.02794→0.98447秒，降低约4.23%，多文本/音色的音频码与完整波形逐位一致；没有改变模型精度或音色设置。可在启动前设置 `TTS_FAST_OPTIMIZE=0` 对照旧原生实现。

`tools/benchmark_notifications.py` 会在同一个真实生成任务上，同时比较150毫秒轮询和新通知方式，排除两个任务之间GPU频率变化的干扰：

```powershell
.\.venv\Scripts\python.exe tools\benchmark_notifications.py --runs 5
```

最新对照、音频一致性及实体设备验证边界见 `TEST_RESULTS.md`。

模型剖析工具会单独加载一套模型，先停止网页服务再运行，避免4GB显存竞争：

```powershell
.\stop.cmd
.\.venv\Scripts\python.exe tools\profile_fast_engine.py --runs 5 --variants baseline,combined_native --coverage
.\start.ps1
```

## 手机与开发板接入

```powershell
.\.venv\Scripts\python.exe tools\bootstrap.py
# 多网卡自动选错时指定电脑局域网IP：
# .\.venv\Scripts\python.exe tools\bootstrap.py --host 192.168.1.100
.\start.ps1 -Lan -Backend fast -Device cpu
```

也可双击 `start-lan.cmd`，以量化CPU模式向局域网提供服务，临时文件和缓存继续保存在项目 `.downloads/` 下。手机、电脑和ESP32需互相可达，ESP32连接2.4GHz Wi-Fi。Windows防火墙如阻止入站，可为该Python程序在“专用网络”放行；程序不会自动修改防火墙。

初始化创建并保留以下本机文件：

- `server.local.json`：客户端令牌、设备令牌、设备编号。
- `miniprogram/config.local.js`：小程序后端地址和客户端令牌。
- `firmware/include/secrets.h`：固件网络和设备配置。**填写实际Wi-Fi名称、密码与功放引脚。**

这些文件均被Git忽略。初始化不覆盖已有配置；IP变化后编辑对应文件或使用小程序“连接设置”。令牌用于局域网原型，不能代替正式用户登录和设备归属管理。请勿把本地HTTP服务直接暴露到公网。

若电脑显示生成成功、开发板播放失败，应查看设备错误和串口 `[AUDIO]` 记录。固件区分认证、文件不存在、WAV格式、PSRAM分配和网络中断/超时；下载连接不跨片段复用，瞬时连接或截断读取最多重试3次。每次失败会释放不完整PCM，取消任务不会继续重试。

传输超时时，先确认ESP32日志/OLED显示的真实IP与电脑服务地址所在网络；服务器看到的来源地址可能经过路由器NAT。优先在同一主路由、同一网段验证。已在实物上确认一次跨路由链路持续超时，而改为同一主路由直连后缓存音频4/4片段、真实生成6/6片段均完整播放，记录见 `TEST_RESULTS.md`。

### 微信小程序

微信开发者工具导入 `miniprogram/`，将项目AppID改为自己的开发AppID（模板 `touristappid` 为占位符）。“设备→连接设置”可编辑地址、令牌和设备编号。

小程序分为三个大字号底部标签：

- **生成**：输入文字，选择音色、语速及播放位置，查看本次语音。
- **记录**：直接在手机重播，或让开发板重播已有音频；等待中的重播也可停止。同一语音的重复播放合并展示，点击正文可展开完整文字。
- **设备**：在线状态、音量与OLED模式；缓存与模型预热放在折叠的“更多设置”中。连接信息使用独立页面。

生成页选择手机时，整条转换完成后自动下载并播放完整WAV；选择开发板时由开发板在转换完成后自动播放。旧版“首包连续试听”偏好不再启用。手机的重播按钮每次从头开始，并复用已下载文件，停止操作单独提供。开发板重播调用 `/api/jobs/{id}/replay`，创建独立播放任务并复用原WAV，不重新运行模型。重播仍可在生成时关闭过缓存的记录上使用，文件已丢失时会明确提示重新生成。正文与主要操作使用32rpx左右字号，并为窄屏设置最小字号；导航标签也使用大字号按钮。更新源码后，在开发者工具中重新编译并刷新手机预览。

开发阶段可在工具“详情→本地设置”开启不校验合法域名。手机使用电脑局域网地址，不能使用 `localhost`。局域网通信、iOS本地网络权限和正式域名配置需在实际微信环境验证；本次代码检查不等于微信真机验证。

小程序支持音色、语速、缓存、转换完成自动播放、手机/开发板重播、设备音量和停止控制。**默认转换未完成时不会播放任何片段**；生成失败或取消也不会自动播放半成品。开发板仍使用有上限的分段下载缓冲，避免把长音频一次装入内存；完整生成后所有片段已就绪，消除等待后续合成造成的断续，网络传输仍需要稳定连接。

### ESP32-S3固件与接线

现有OLED工程使用SSD1306，本固件默认SSD1306；实际为SH1106时修改 `OLED_IS_SH1106=true`。支持0x3C/0x3D地址、GB2312中文字库，缺字以问号代替。三种玩法均保留正文分页，播放特效随真实PCM振幅变化；不做逐字声画同步。

| 模块 | 引脚 | ESP32-S3 |
|---|---|---|
| OLED | SDA | **GPIO8（已确定）** |
| OLED | SCL | **GPIO9（已确定）** |
| OLED | VCC/GND | 按模块规格使用3.3V/共地 |
| MAX98357A | BCLK | GPIO15（建议，按实际接线修改） |
| MAX98357A | LRC/WS | GPIO16（建议，按实际接线修改） |
| MAX98357A | DIN | GPIO17（建议，按实际接线修改） |
| MAX98357A | VIN/GND | 合适的5V电源/共地 |
| 4Ω 3W喇叭 | 两端 | 功放SPK+、SPK−；均不接地 |

固件领取协议2任务后读取增量清单，分离控制、片段下载和I²S播放任务；下载队列提前获取下一段，将有上限的PCM缓冲放入PSRAM。收到第一段后开始I²S输出，不等待最终完整WAV。播放任务跨段保持I²S通道开启，避免每段重新初始化；停止时丢弃旧任务队列。固件将单声道复制到左右声道，避免MAX98357A通道配置造成无声。

每段解析RIFF/fmt/data块，只接受单声道16位PCM，按音频采样率配置I²S；不将整个语音任务一次加载到内存。支持停止、音量、断线重连、任务租约、逐段进度、首包下载计时和首次I²S写入确认。首包下载计时从音频HTTP请求开始，到完整PCM缓冲就绪；不包含此前等待模型发布首包的时间。模拟接收器的计时和在线标记与实物区分。语音模型运行在电脑，ESP32负责显示、网络接收和播放。

```powershell
cd firmware
pio run
# 确认secrets.h和串口后再烧录，会替换开发板现有程序：
pio run -t upload
pio device monitor
```

默认仅构建，不自动烧录。开发板Wi-Fi凭据未填写时无法联网；电脑模型测试不需要连接实物。

## 协议

API文档：`/docs`。127.0.0.1本地网页可直接访问；局域网控制接口需 `X-Client-Token`，设备接口及设备音频下载需 `X-Device-Token`。

| 路由 | 功能 |
|---|---|
| `GET /api/status`、`GET /api/voices` | 实际后端、硬件、模型状态和音色 |
| `POST /api/model/load` | 加载并预热 |
| `POST /api/jobs` | 提交任务，立即返回任务ID |
| `POST /api/jobs/{id}/replay` | 复用已生成WAV创建开发板重播任务，不调用模型；请求包含device_id，可选display_mode |
| `GET /api/jobs/{id}` | 状态、分段、音频与计时；可带revision/after_parts/wait_ms异步等待变化 |
| `POST /api/jobs/{id}/cancel` | 请求停止生成与设备播放 |
| `GET /api/audio/{name}.wav` | 已完整写入的16位单声道WAV片段或最终音频 |
| `GET /api/devices` | 在线状态 |
| `POST /api/devices/{id}/volume` | 设置0～100音量 |
| `GET /api/device/{id}/next` | 设备领取协议2任务与租约，包含增量清单地址 |
| `GET /api/device/{id}/jobs/{job_id}/manifest` | 按 `after`、`lease`、`wait_ms` 读取新增片段、结束/取消标记 |
| `POST /api/device/{id}/heartbeat` | 续租、逐段进度、首次I²S写入、完成确认及停止/音量读取 |

单进程、单推理worker，最多4个未完成任务。取消在生成步骤间检查，不能抢占当前GPU内核。设备租约30秒，心跳约0.5秒；完整生成不会清除正在播放任务的有效租约。服务重启后历史可试听，但不自动重播旧设备任务。设备重启或租约超时可能重复播放未确认任务，协议不承诺严格“恰好一次”投递。生成音频与历史保存在 `outputs/`，当前不自动清理。

## 检查与设备模拟

```powershell
.\.venv\Scripts\python.exe -m pytest -q
node tools\check_miniprogram.cjs
node tools\check_stream_playback.cjs
cd firmware
pio run
```

后端自动测试使用专用替身引擎，不会把测试音频写入真实历史；真实模型性能另用上述基准工具验证。pytest只扫描项目 `tests/`，不会执行下载的加速项目测试。

设备协议模拟器验证指定任务的领取、增量清单、WAV格式、心跳和完成确认；它会消费该设备任务，不能与实物同时领取同一任务。先在页面提交“发送到开发板”的任务，取得任务ID，再运行：

```powershell
.\.venv\Scripts\python.exe tools\device_simulator.py --job-id "替换为实际任务ID" --simulate-pace
```

`--job-id` 只领取该任务并在完成后退出，不会消费其他待播放任务。仅在明确希望持续领取后续设备任务时使用 `--consume-next`。`--simulate-pace` 按片段时长等待，仍不会驱动物理OLED、I²S或喇叭；模拟计时与实物首次播放计时分开保存。

也可通过独立工具创建一个新任务，只领取该任务，记录提交、协议2领取、首PCM、各包下载和模拟FIFO欠载：

```powershell
.\.venv\Scripts\python.exe tools\benchmark_device.py --output logs\device-benchmark.json
```

它固定关闭缓存、不会领取其他旧任务，但仍使用配置中的设备编号；测试时避免实物竞争领取这个新任务。该工具会发送带 `simulated: true` 的设备心跳与完成确认，报告明确标记为模拟，不回填物理ESP32播放成功或首次I²S时间。

项目结构：`app.py` 后端、`job_updates.py` 异步通知、`fast_engine.py` 加速适配、`device_protocol.py` 设备协议、`static/` 网页、`miniprogram/` 微信小程序、`firmware/` PlatformIO固件、`tools/` 安装/配置/验证工具、`tests/` 项目测试。

官方模型与代码：[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。第三方代码、二进制及模型遵循各自许可证；加速源码和资产保留于本地 `acceleration/`，不包含在源码压缩包中，可用安装脚本重建。
