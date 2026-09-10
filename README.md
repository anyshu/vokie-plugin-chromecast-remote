# Vokie Plugin · Chromecast Voice Remote

当前版本：**0.2.6**。

把 Google Chromecast Voice Remote（VID `0x18D1` / PID `0x9450`）变成 Vokie 的蓝牙语音输入与确认控制器。

## 功能

| 遥控器按键 | Vokie 动作 |
| --- | --- |
| 语音键（模式二选一） | **长按模式**（默认，PTT）：按下语音键立即开始录音（`ptt` 会话），松开结束——快速点按只是一次很短的会话。**短按模式**（Hands-free PTT）：每按一下语音键切换录音开关（`handsfree-ptt` 会话），按一下开始、再按一下结束。 |
| 返回键 | 撤销上一次输出（`undo_last_output` 命令） |
| 确认键 | 发送（回车确认输出，`send_enter` 命令） |

插件**不做任何手势时长判定**：`voiceMode` 设置决定语音键的行为与会话类型（`hold` → `ptt`，`tap` → `handsfree-ptt`），Worker 只按设置执行。"长按"和"短按"只是用户对两种模式的叫法。

## 0.2.6 修复

修正通知订阅返回 `failed: The request is not supported. (notify_failed)` 时被误判为整个 BLE 适配器不可用的问题。可选的 ATVV 命令回显订阅失败后继续语音协商；可选 GATT HID 失败仅报告按键不可达。必需的控制/音频订阅失败仍释放连接后重试，并保留特征 UUID 和原始错误。明确的后端不可用、权限拒绝和协议错误仍会停止重试。此修复不代表原生 HID 已恢复报文。

## 工作原理

- **语音（BLE，走 Vokie Host 适配器）**：`ble_scan` / `ble_connect` / `ble_start_notify` / `ble_write`（`apiVersion: "1"`）。扫描使用 ATVV 服务与 Chromecast 名称过滤，并用 `connectedServiceUuids`（ATVV / `1812` / `180F`）找回系统已连接设备。只有名称为 `Chromecast Remote` / `Chromecast Voice Remote` 的设备进入连接候选；共享 ATVV 服务或电池/HID 缓存命中不是型号凭据，小米及无名称设备会被忽略。连接后通过必需 ATVV 特征订阅与 capabilities 协商验证语音链路；失败先等待 Host 完成断开，再按 1s→8s 退避重试。详见 [BLE 接入规格](spec/ble-device-isolation.md)。
- **语音协议（Google ATVV）**：服务 `AB5E0001-…`，命令写 `…0002`，音频通知 `…0003`，控制通知 `…0004`。语音键手势不经 HID：`AUDIO_START reason 0x03`（按下）/ `AUDIO_STOP reason 0x02`（松开）。长按模式在按下瞬间即 `session_start`，接受往返期间的音频由 Host 会话预接受缓冲补发；短按模式按住期间音频本地有界缓冲（约 2 s，超限丢最旧），抬起开启会话时补发，并立即发送 `MIC_OPEN` 转持续收音：开麦确认按 ~1s 间隔有限重试（3 次，对齐 vRemoter 1.1.1 的修复），期间 BLE 重传的重复"松手"通知会被忽略，不误杀会话；重试耗尽以 `session_cancel` 放弃（不产生空输出）。再次按下发送 `MIC_CLOSE` 结束。支持 ATVV v0.4 / v1.0，优先 ADPCM 16 kHz；8 kHz 线性插值重采样到 16 kHz，以 `pcm_s16le` 二进制帧（4 字节 BE 头长 + JSON 头 + PCM）发给 Vokie；流式期间每 4 s keep-alive。Worker stderr 输出 `[cast-atvv]`（设备事件）与 `[cast-session]`（会话结束原因 + 帧数）前缀的日志；插件设置页「当前会话」一栏也会显示最近一次会话的结束原因（如 `host_success（12 帧音频）`、`device_lost(cancel)（0 帧音频）`），便于现场诊断。
- **按键（原生 HID 主通道，GATT 显式选用）**：usage `0x07` = 确认、`0x0B` = 返回（Chromecast 输入 report ID `0x01`）。原生助手兼容 macOS 将 report ID 放在回调参数或报文 buffer 的差异，先统一报文再由解析器过滤，只认按下沿并去抖。
  1. **GATT 通道**：HID 报告特征 `2A4D`（先短形式订阅，失败回退 128 位全形式）。是否可用取决于系统是否暴露该特征及设备的配对/加密要求。
  2. **IOKit 助手通道**：内置 `assets/chromecast-hid-helper`（Swift 编译的独立二进制，vRemoter 同款 IOKit 机制）。遥控器与 macOS 配对后，GATT HID 特征可能不向插件暴露（订阅返回 `not_found`），此时由助手经系统 HID 接口读按键。助手在 manager 层统一打开并监听所有匹配的 HID collection，不再只保留最后一个设备对象；按键链路与语音 BLE 链路独立。
  - `hidSource` 设置：`auto`（默认，在 macOS 使用原生助手按键 + Host BLE 语音）/ `iohid`（原生助手）/ `gatt`（显式使用 GATT 按键）。前两种模式不订阅 `2A4D`，不会因 GATT 订阅确认而停止助手；GATT 模式失败则报告按键不可用，不静默切换。切换原生/GATT 来源会重连并结束当前录音。
  - 助手默认 `--seize`，由 manager 统一独占匹配接口以拦截原生按键；打开失败时先完整关闭，再创建新的 manager 尝试共享模式。`hidSuppressNative: false` 直接使用 `--observe`。共享回退不保证收到报文，也不保证免权限；状态页仅在实际收到有效按键报文后显示 IOKit 通道可用，回退时标注原生按键未拦截。助手输出权限检查结果、接口数量和原始错误码，随 Worker 退出释放设备（SIGTERM / stdin EOF）。详见 [HID 修复规格](spec/hid-helper.md)。

## 目录结构

```
vokie.plugin.json        # 插件清单（id 为不可变 UUID）
worker/
  index.mjs              # Host WebSocket 生命周期、会话桥接、命令路由
  ble-transport.mjs      # Host BLE 适配器客户端 + 连接管理/重连
  ble-device-selection.mjs # 型号筛选与失败候选冷却
  device-session.mjs     # 语音键手势状态机（hold / tap 两模式）
  atvv-protocol.mjs      # ATVV 控制事件、命令、ADPCM 帧解码
  hid-reports.mjs        # HID 按键报文解析（GATT 与助手共用）
  hid-helper-source.mjs  # IOKit 助手进程管理（启动/重启/清理）
  host-session.mjs       # Vokie 会话簿记（requestId / 预接受缓冲 / 音频帧）
  pcm.mjs                # 重采样、PCM 编码、有界缓冲
native/
  chromecast-hid-helper.swift  # CLI、信号与 stdin 生命周期
  HidBridge.swift              # manager 级 HID 打开、回退、接口跟踪与报文
  HIDDiagnostics.swift        # JSON 输出、权限只读检查、错误分类
  HIDReport.swift             # 可测试的 HID 报文规范化，不猜测未知 report ID
  build-helper.sh              # 重建助手二进制
assets/
  chromecast-hid-helper # 预编译助手（arm64）
  icon.svg, vokie-plugin-sdk.js
ui/index.html            # 状态/设置页
test/                    # 单元测试 + fake Host/设备端到端测试
```

## 安装与运行

把本目录复制为 `<userData>/plugins/<pluginId>`（或在 Vokie PC 的插件页安装本目录的打包 zip）。Worker 仅依赖 Node 内建模块（Node ≥ 22 的全局 `WebSocket`），无需 `npm install`。插件页显示实际运行版本，启动日志 `[cast-plugin]` 记录插件 ID、版本和加载路径。修改仓库不会自动更新安装目录。

> **注意（可执行位）**：Host 直接 spawn `worker/index.mjs` 与 `assets/chromecast-hid-helper`（均依赖 shebang 与可执行位，仓库已按 `755` 提交）。若拷贝/解压方式不保留 Unix 权限（安装后报 `spawn … EACCES`），执行：
>
> ```bash
> chmod +x <userData>/plugins/<pluginId>/worker/index.mjs <userData>/plugins/<pluginId>/assets/chromecast-hid-helper
> ```
>
> Worker 也会在启动助手时自动修复助手的执行位。

## 设置

设置页**改动即存**（无需保存按钮）：UI 通过 configure 桥把变更发给 Host，Worker 确认后立即生效，页面显示「✓ 已生效」反馈。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `voiceMode` | `hold` \| `tap` | `hold` | 语音键模式（二选一）：长按模式（PTT）/ 短按模式（Hands-free PTT） |
| `hidSource` | `auto` \| `gatt` \| `iohid` | `auto` | 按键通道选择 |
| `hidSuppressNative` | boolean | `true` | 助手独占设备、拦截遥控器原生按键 |

旧版本的 `holdThresholdMs` / `tapMode` / `holdMode` 配置键已废弃，Worker 收到时会忽略并记录日志（不会拒绝，避免阻断插件启动）。

## 测试

```bash
node --test
sh native/build-helper.sh
```

- `test/ble-isolation.test.mjs`：混合型号扫描、旧请求隔离、连接超时、断开确认后重试、失败候选恢复及 BLE/HID 通道分离。
- `test/native-helper.test.mjs`：编译纯 Swift 报文规范化测试，验证未知报文不冒充按键；不打开设备。macOS 上需 Swift 工具链。
- `test/protocol.test.mjs`：ATVV 编解码（手工推演的 IMA-ADPCM 参考值）、PCM 帧、HID 去抖、BLE 传输（握手、UUID 短/长回退、退避重连）、手势状态机（hold/tap 两模式 + 互斥忽略 + 开麦重试 + 会话拒绝 + 设备丢失）、助手进程管理（崩溃有限重启、执行位自修复）。
- 构建脚本的冒烟验证仅运行 `--help`，不打开实际设备；自动化测试使用 fake helper，不触发系统 HID 授权。真实遥控器的共享/独占读取仍需按 spec 现场验收。
- `test/plugin.test.mjs`：真实 worker 进程 + fake Host + fake 遥控器 —— 清单一致性、hold→ptt / tap→handsfree-ptt 全流程音频帧字节级校验、模式切换后旧手势失效、HID 命令、GATT 与 IOKit 助手两条按键通道、配置校验（含 legacy 键拒绝）、断连 `session_cancel`、stop/shutdown 幂等。

## 已知限制

- **仅 macOS**：Host BLE 适配器只有 CoreBluetooth 后端；IOKit 助手也是 macOS 专属。其他平台进入 `error`。
- **IOKit 助手要求遥控器与 macOS 配对**（系统蓝牙 HID 栈可见设备）；未配对时可显式尝试 GATT 通道（部分固件可能拒绝未加密的 HID 订阅，此时按键不可用，语音不受影响）。
- **BLE 自动识别基于名称**：无名称、改名或其他名称的设备会被忽略；名称加 ATVV 协商不等于硬件认证。HID 仍独立按 VID/PID 精确匹配；多只同型号遥控器暂不支持逐只绑定。
- **助手预编译二进制为 arm64**（本机构建）。Intel Mac 需重跑 `native/build-helper.sh`（交叉编译时需把构建脚本列出的全部 Swift 源文件传给 `swiftc -arch x86_64`）。
- **权限与占用是不同问题**：`kIOReturnExclusiveAccess` 表示独占访问冲突，不能直接归因为缺少输入监控。共享读取也可能受输入监控限制；助手仅检查权限，不主动调用授权请求接口（IOKit 打开设备本身仍可能触发系统授权流程）。应以实际运行进程的权限归属和报文结果判断，不预设某个 Electron 路径授权后必定恢复。
- 短按模式（handsfree-ptt）的会话在抬起瞬间开启，按住期间的音频（最多约 2 s）已缓冲并在接受后补发；更长的按住只保留最后约 2 s。

## 致谢

ATVV 协议细节（特征 UUID、capabilities 协商、reason 码语义、短按/长按手势判定）与 IOKit 按键读取参考并实测对齐 [VincentKingHsu/vRemoter](https://github.com/VincentKingHsu/vRemoter)（MIT）的逆向实现。
