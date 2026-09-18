# Chromecast A0 遥控器兼容

初始迁移日期：2026-09-15（插件 0.4.0）。2026-09-18 增量对齐本地
`xiguashuo-pc` 最新基线 `main@76113b72`。初始型号、按键与 HCI 身份逻辑来自
`692b6d11` / `40ba1c2f`；本轮继续对齐 `GoogleTvRemoteProfile.swift`、
`GoogleTvHciIdentity.swift`、`GoogleTvPhysicalKeepAlive.swift`、`a0AudioDsp.ts`、
`a0PeakLimiter.ts` 与 HCI v4 共享抓包/抢占行为。插件 ID、API v1、macOS 平台及
既有配置键保持兼容。

## 型号与按键

同 VID `18d1` / PID `9450`，旧款以 Keyboard（usage page 1 / usage 6）枚举，
新款 A0 / 26.2 以 Consumer Control（page 12 / usage 1）枚举。
只在 VID/PID 与支持的 usage 同时匹配时读取身份；不能以“Keyboard”设备分类排除 A0。

| 型号 | 按键句柄 | 确认 | 返回 | 松开 | 控制 / 音频句柄 |
| --- | --- | --- | --- | --- | --- |
| hid_mouse / legacy | 0x002b | 41 00 | 24 02 | 00 00 | 0x0057 / 0x0054 |
| A0 | 0x0029 | 07 00 00 00 00 00 00 00 | 0b 00 00 00 00 00 00 00 | 八字节全零 | 0x003f / 0x003c |

`worker/remote-profile.mjs` 独立维护映射，按 HID ModelNumber 选择 A0，其他型号沿用
legacy。严格检查句柄、长度及 A0 后七字节；错款、截断或其他按键不触发命令。
保留按下去重、松开边沿与 `send_enter` / `undo_last_output`。诊断 GATT 通道在已识别
A0 时接受无 report ID 的八字节通知，原生助手可带 report ID 1 前缀；通道可达性不变。

## 身份与 HCI 绑定

`assets/chromecast-hid-helper --identity` 使用独立 `native/IdentityBridge.swift`：

- 每秒枚举匹配 HID 身份，不打开/独占输入报告通道，不申请输入监控。
- 读取 PhysicalDeviceUniqueID、ModelNumber、固件、序列号与地址；设置页只展示型号、固件和验证状态。
- 多个 HID collection 先去重。A0 的选择优先级高于 legacy：即使 legacy 已选中，
  后到 A0 也会被提升；同一 profile 内保持当前设备，首次则按不透明 UUID 稳定排序。
  A0 移除后可回选仍在线的 legacy。暂不提供多遥控器手动选择 UI。
- 有 HID UUID 时，Host BLE 扫描结果只选择该 UUID；晚到身份与正在连接的候选不一致时，先等待旧连接释放再重连。
- A0 且 HCI 抓包已启动时，身份助手通过 CoreBluetooth 按该 UUID 获取外设，只读取 DIS 180A / Serial Number 2A25；不扫描其他设备，不订阅或写入 ATVV。

`worker/hci-identity.mjs` 复刻序列号双重验证：开始读取后三秒内，必须同时收到 HCI 的
ATT Read Request / 同连接的匹配序列号 Read Response，以及身份助手的相同序列号回读。
确认回调与 HCI 报文允许任意先后顺序。只有一个候选句柄时建立绑定；多个候选、错误序列号、
超时、截断包或无请求的响应不能绑定。未成功时身份助手每四秒重试，验证成功后停止读取。

来源必须是 Chromecast 名称或当前 HID 的真实地址（兼容冒号/连字符）；A0 也允许观察
PacketLogger 的全零地址，但按钮只有在上述验证绑定的连接句柄上才放行。
显式其他地址不放行。普通按钮、音频报文和同名设备本身不能建立 A0 绑定。
连接断开事件、抓包关闭、HID 移除、助手退出均清空绑定和按键状态；助手丢失时保留已知
A0 型号，不退回宽松 legacy 路径。验证等待期间 UI 明示按键不可用。

身份助手通过 `worker/remote-identity-source.mjs` 独立管理，随插件 start 启动、
stop / shutdown / WebSocket close 停止；使用现有进程管理的有限重启与执行位修复。
抓包依旧由现有特权守护进程持有；身份助手不启动第二份抓包，不改变按键来源配置。
HCI 客户端已升级为 v4，capture 可与其他 v4 客户端共享；`hidSuppressNative`
开启时另行请求 root daemon 按 `18d1:9450` seize HID。seize 失败只表示系统原生
按键可能仍会发送给播放器，不影响 HCI 按键、A0 身份验证或 ATVV 语音。

## 语音与 Host 兼容

语音仍经 Host BLE 适配器按 ATVV UUID 订阅，所以不依赖新旧型号的数字句柄。
A0 的 AUDIO_START `04 03 02 xx`、AUDIO_STOP `00 02` 和原始 ADPCM 与既有会话兼容：
160 字节 ADPCM 解码为 320 个 16 kHz PCM16 采样，接受前有界缓冲，接受后才发送。

A0 命令特征实测 properties=0x04，仅支持 Write Without Response。
源仓库 `VokieBleAdapter.swift::handleWrite` 已在无 `.write`、有 `.writeWithoutResponse`
时使用 `.withoutResponse`；插件沿用标准 `ble_write`，不添加不存在的 writeType 协议字段。
部署宿主必须具备这一分支。插件仍不复制内置服务的 HCI 音频解码链路：ATVV 通知、
ADPCM 解码与 PCM 传输继续由 Host BLE + Worker 单路处理，避免重复音频。

## A0 专用音频处理

`worker/a0-audio-dsp.mjs` 与 `worker/a0-peak-limiter.mjs` 忠实转换自
`xiguashuo-pc main@76113b72`。Worker 先将 8 kHz 编解码结果插值到 16 kHz，再按设备
profile 处理 PCM：

- A0 使用 100 Hz 二阶高通（Q = `sqrt(1/2)`）和 20 ms 有界 RMS 窗。电平目标为
  -28 dBFS，语音活动门限 -50 dBFS，自适应补偿限制在 0 至 +15 dB，增益上升/
  下降时间常数为 50/60 ms。
- 低于活动门限时不追高增益；保持 100 ms 后以 80 ms 时间常数回到 +3 dB
  初始基线。快速压缩器以 -23 dBFS 包络为目标，最多衰减 15 dB；压缩后再加
  固定 +3 dB 输出增益。
- 末级限幅器将首个过高采样立即压到 **-6 dBFS** 以下，并以 8 ms 时间常数
  释放，为重采样与 Opus 编码留出余量。处理不增加缓冲、不改变采样数，且输出
  与 BLE 分包边界无关。
- profile 在每次物理语音手势开始时快照。手势中途身份变化不会切换处理器；
  会话结束、中断、设备丢失或 teardown 都会 flush/reset。legacy 路径保持现有原始
  PCM 行为，不套用 A0 DSP。

## 物理流保活

- 只有完整的 ATVV 1.0 capabilities（当前以至少 9 字节为门禁）才标记
  `physicalKeepAliveSupported`。物理 `AUDIO_START 04 03 codec streamId` 必须恰好 4 字节、
  且 codec 为 1/2；过短或带多余字节的 v1 报文按 unknown 忽略。v0.4 原有两字节
  `AUDIO_START` 格式保持兼容。
- 物理 ATVV 1.0 流从开始 10 秒后，每 10 秒写入 `MIC_EXTEND 0e streamId`。
  `AUDIO_STOP`、断连、reset 或 teardown 会取消定时器，不补发过期命令。
- 物理 `MIC_EXTEND` 写入返回失败或 Promise reject 后，本连接锁存为不再尝试；普通
  流 reset 不会清除，下一次 `deviceReady` 才恢复。异步结果带连接 generation 守卫，
  旧连接迟到的失败不会停用新连接的保活。
- **物理 ATVV 0.4 流不保活**，不把 v0.4 的 `MIC_OPEN` 重发逻辑误用到物理
  按住场景。tap / hands-free 产生的主机开麦流保留原有 4 秒保活，与物理
  10 秒定时及其失败锁存分开。

## 验证与交付边界

- `node --test` 覆盖 A0 捕获报告、legacy 回归、序列号双重验证顺序、错误来源、
  过期/多候选/断开、A0 优先选择、HID UUID 候选切换、HCI v4 共享与 seize 降级、
  真实 Worker + fake Host/HCI/身份助手完整回放。
- `test/a0-audio-dsp.test.mjs` 覆盖持续轻声/大声均衡、瞬态峰值、暂停恢复、分包边界独立、
  reset、数字静音与弱短音节；`test/protocol.test.mjs` 另验证 profile 快照、10 秒
  MIC_EXTEND 时序、严格 AUDIO_START 长度、写失败锁存、旧连接异步结果隔离及
  ATVV 0.4 物理流不保活。
- A0 完整回放覆盖：验证前不发按键命令；验证后确认/返回各一次；其他地址与连接句柄忽略；
  160 字节音频预接受缓冲及 640 字节 PCM 输出；物理松开停止；身份移除后旧报文不触发。
- 原生纯函数测试覆盖 Keyboard / Consumer Control 两类接口与错误 VID/PID 拒绝。
- 已重建 arm64 助手并执行 `--help`；单独运行 `--identity` 后立即 stdin EOF，只读本机
  HID 元数据并正常退出，未开启抓包或发起序列号读取。
- 本机 Swift 缓存受沙箱限制时使用
  `CLANG_MODULE_CACHE_PATH=/tmp/chromecast-swift-cache SWIFT_MODULE_CACHE_PATH=/tmp/chromecast-swift-cache sh native/build-helper.sh`。
  集成测试需要本机临时套接字监听权限，所有套接字和助手都为测试替身。
- 本插件未因此次迁移自动获得 A0 真机按键、长时间保活或音质验收结论；来源仓库
  的真机记录只是设计依据，不能代替插件安装包实测。
  未修改源仓库、已安装插件副本或远端运行环境。
