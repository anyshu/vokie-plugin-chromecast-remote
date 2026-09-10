# Vokie Plugin · Chromecast Voice Remote

把 Google Chromecast Voice Remote（VID `0x18D1` / PID `0x9450`）变成 Vokie 的蓝牙语音输入与确认控制器。

## 功能

| 遥控器按键 | Vokie 动作 |
| --- | --- |
| 语音键（模式二选一） | **长按模式**（默认，PTT）：按下语音键立即开始录音（`ptt` 会话），松开结束——快速点按只是一次很短的会话。**短按模式**（Hands-free PTT）：每按一下语音键切换录音开关（`handsfree-ptt` 会话），按一下开始、再按一下结束。 |
| 返回键 | 撤销上一次输出（`undo_last_output` 命令） |
| 确认键 | 发送（回车确认输出，`send_enter` 命令） |

插件**不做任何手势时长判定**：`voiceMode` 设置决定语音键的行为与会话类型（`hold` → `ptt`，`tap` → `handsfree-ptt`），Worker 只按设置执行。"长按"和"短按"只是用户对两种模式的叫法。

## 工作原理

- **语音（BLE，走 Vokie Host 适配器）**：`ble_scan` / `ble_connect` / `ble_start_notify` / `ble_write`（`apiVersion: "1"`）。扫描以 ATVV 服务 UUID 为主过滤，并用 `connectedServiceUuids`（ATVV / `1812` / `180F`）覆盖已被 macOS 连接的遥控器；断开后 1s→8s 退避自动重连，适配器不可用属永久错误并上报 `error`。
- **语音协议（Google ATVV）**：服务 `AB5E0001-…`，命令写 `…0002`，音频通知 `…0003`，控制通知 `…0004`。语音键手势不经 HID：`AUDIO_START reason 0x03`（按下）/ `AUDIO_STOP reason 0x02`（松开）。长按模式在按下瞬间即 `session_start`，接受往返期间的音频由 Host 会话预接受缓冲补发；短按模式按住期间音频本地有界缓冲（约 2 s，超限丢最旧），抬起开启会话时补发，并立即发送 `MIC_OPEN` 转持续收音：开麦确认按 ~1s 间隔有限重试（3 次，对齐 vRemoter 1.1.1 的修复），期间 BLE 重传的重复"松手"通知会被忽略，不误杀会话；重试耗尽以 `session_cancel` 放弃（不产生空输出）。再次按下发送 `MIC_CLOSE` 结束。支持 ATVV v0.4 / v1.0，优先 ADPCM 16 kHz；8 kHz 线性插值重采样到 16 kHz，以 `pcm_s16le` 二进制帧（4 字节 BE 头长 + JSON 头 + PCM）发给 Vokie；流式期间每 4 s keep-alive。Worker stderr 输出 `[cast-atvv]`（设备事件）与 `[cast-session]`（会话结束原因 + 帧数）前缀的日志；插件设置页「当前会话」一栏也会显示最近一次会话的结束原因（如 `host_success（12 帧音频）`、`device_lost(cancel)（0 帧音频）`），便于现场诊断。
- **按键（HID，双通道自动回退）**：usage `0x07` = 确认、`0x0B` = 返回（report ID `0x01`），只认按下沿并去抖。
  1. **GATT 通道**：HID 报告特征 `2A4D`（先短形式订阅，失败回退 128 位全形式）。遥控器未与 macOS 配对时可用。
  2. **IOKit 助手通道**：内置 `assets/chromecast-hid-helper`（Swift 编译的独立二进制，vRemoter 同款 IOKit 机制）。遥控器与 macOS 配对后系统 HID 栈独占 HID 服务（GATT 订阅得 `not_found`），此时由助手读按键——与语音链路完全独立，断连重连期间按键依然可用。
  - `hidSource` 设置：`auto`（默认，GATT 优先、失败自动用助手）/ `gatt` / `iohid`。
  - 助手默认 `--seize` 独占设备以拦截遥控器的原生系统按键（避免"双回车"）；若系统拒绝独占（`kIOReturnExclusiveAccess`，常见于系统蓝牙 HID 栈或其他软件已持有设备），自动回退为 `--observe` 旁听模式：按键照常工作，但原生按键不再被拦截（状态页会标注）。`hidSuppressNative: false` 可直接关掉独占。助手随 Worker 退出自动清理（SIGTERM / stdin EOF 双保险）。

## 目录结构

```
vokie.plugin.json        # 插件清单（id 为不可变 UUID）
worker/
  index.mjs              # Host WebSocket 生命周期、会话桥接、命令路由
  ble-transport.mjs      # Host BLE 适配器客户端 + 连接管理/重连
  device-session.mjs     # 语音键手势状态机（hold / tap 两模式）
  atvv-protocol.mjs      # ATVV 控制事件、命令、ADPCM 帧解码
  hid-reports.mjs        # HID 按键报文解析（GATT 与助手共用）
  hid-helper-source.mjs  # IOKit 助手进程管理（启动/重启/清理）
  host-session.mjs       # Vokie 会话簿记（requestId / 预接受缓冲 / 音频帧）
  pcm.mjs                # 重采样、PCM 编码、有界缓冲
native/
  chromecast-hid-helper.swift  # IOKit 助手源码（JSON 行输出）
  build-helper.sh              # 重建助手二进制
assets/
  chromecast-hid-helper # 预编译助手（arm64）
  icon.svg, vokie-plugin-sdk.js
ui/index.html            # 状态/设置页
test/                    # 单元测试 + fake Host/设备端到端测试
```

## 安装与运行

把本目录复制为 `<userData>/plugins/<pluginId>`（或在 Vokie PC 的插件页安装本目录的打包 zip）。Worker 仅依赖 Node 内建模块（Node ≥ 22 的全局 `WebSocket`），无需 `npm install`。

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
```

- `test/protocol.test.mjs`：ATVV 编解码（手工推演的 IMA-ADPCM 参考值）、PCM 帧、HID 去抖、BLE 传输（握手、UUID 短/长回退、退避重连）、手势状态机（hold/tap 两模式 + 互斥忽略 + 开麦重试 + 会话拒绝 + 设备丢失）、助手进程管理（崩溃有限重启、执行位自修复）。
- `test/plugin.test.mjs`：真实 worker 进程 + fake Host + fake 遥控器 —— 清单一致性、hold→ptt / tap→handsfree-ptt 全流程音频帧字节级校验、模式切换后旧手势失效、HID 命令、GATT 与 IOKit 助手两条按键通道、配置校验（含 legacy 键拒绝）、断连 `session_cancel`、stop/shutdown 幂等。

## 已知限制

- **仅 macOS**：Host BLE 适配器只有 CoreBluetooth 后端；IOKit 助手也是 macOS 专属。其他平台进入 `error`。
- **IOKit 助手要求遥控器与 macOS 配对**（系统蓝牙 HID 栈可见设备）；未配对时依赖 GATT 通道（部分固件可能拒绝未加密的 HID 订阅，此时按键不可用，语音不受影响）。
- **助手预编译二进制为 arm64**（本机构建）。Intel Mac 需重跑 `native/build-helper.sh`（或 `swiftc -arch x86_64`）。
- **`--seize` 可能被系统拒绝**：系统蓝牙 HID 栈或其他软件（如 vRemoter）持有遥控器时，独占打开返回 `kIOReturnExclusiveAccess`——助手会自动回退为旁听模式（按键可用、原生按键未拦截，状态页有标注）。
- 短按模式（handsfree-ptt）的会话在抬起瞬间开启，按住期间的音频（最多约 2 s）已缓冲并在接受后补发；更长的按住只保留最后约 2 s。

## 致谢

ATVV 协议细节（特征 UUID、capabilities 协商、reason 码语义、短按/长按手势判定）与 IOKit 按键读取参考并实测对齐 [VincentKingHsu/vRemoter](https://github.com/VincentKingHsu/vRemoter)（MIT）的逆向实现。
