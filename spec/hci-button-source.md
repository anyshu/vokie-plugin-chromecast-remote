# 按键 HCI 抓包通道（macOS 26.5 唯一可用路径）

日期：2026-09-13。实现版本：0.3.0。前置诊断：[hid-macos-limitations.md](hid-macos-limitations.md)。

## v0.4.0 更新（2026-09-15）

新增 A0 / 26.2 的 `0x0029` 八字节按键报告、实际 HID 型号/固件、设备地址与序列号验证后的 HCI 句柄绑定。A0 只有绑定完成才显示按键可用；语音继续使用 Host BLE 的 ATVV UUID 通道。详细迁移与验证见 [a0-remote-support.md](a0-remote-support.md)。下文保留 v0.3.0 的旧款实现背景。

## 背景

macOS 26.5 上插件进程可直达的按键读取路径全部不可用（IOKit 共享零报文、seize 被拒且 root 不豁免、事件系统 monitor / CGEventTap 零事件、GATT `2A4D` 被系统隐藏）。遥控器的确认/返回键是它在**发给系统 HID 栈那条连接**上的 ATT Handle-Value Notification（GATT 句柄 `0x002B`：`41 00` 确认按下、`24 02` 返回按下、`00 00` 松开），任何用户态 HID/GATT 查询都看不到——蓝牙 HCI 层是唯一观测点。

Vokie 主应用的 Google TV 遥控器（设备实验室）正是这样做的：root 守护进程 `com.vokie.hcihelper`（`/var/run/com.vokie.hci.sock`，0666，任何本地进程可连，`caller.uid` 必须等于对端 uid）在 `startCapture` 时写蓝牙 trace 配置、拉起 `PacketLogger.app` 的 `packetlogger convert -s -f nhdr` 并以 JSON 行转发 nhdr 文本流；`stopCapture`（或客户端断开）时恢复配置并 `killall -30 bluetoothd` 重载（一次全局蓝牙闪断）。插件侧复用同一守护进程与协议（`vokie.appleTvRemote.hci` v2），实现对齐主应用 `GoogleTvRemoteHelper`。

## 设计

- `worker/hci-button-source.mjs`：`HciButtonSource` 连接套接字 → `startCapture` → 解析 `nhdr` 行 → 按键沿 → `deviceSession.hidEvent`（`select` 按下 → `send_enter`，`back` 按下 → `undo_last_output`，松开沿忽略，与 GATT/IOKit 通道相同的边沿语义）。
- nhdr 解析与主应用逐 token 对齐：非空白 token 序列中找 `RECV`（序号 ≥ 5），设备名取 `tokens[3..句柄位)` 且不区分大小写等于 `Chromecast Remote`；十六进制字节容忍尾部 `,`/`:`；ACL 要求 PB=2、CID `0x0004`、ATT opcode `0x1b`；只处理句柄 `0x002B`，ATVV 语音（`0x0054`/`0x0057`）仍走插件自己的 GATT 连接，不双通道重复处理。
- 按键状态机（按下去重、`00 00` 合成两个松开沿）与 `HidButtonValueParser` 独立成纯类，便于测试。

## 来源选择与互斥

`hidSource`：`auto`（默认）/ `hci` / `iohid` / `gatt`。

- `auto`：先探测 HCI（连接失败、`versionMismatch`、PacketLogger 缺失等**确定性失败** → 本轮停探测并回退 IOKit 助手；重新选择 `auto` 会再次探测）。争用（`another capture is active`）不是确定性失败：每 5s 重试且**不**启动第二按键源，保证一次物理按压不会双触发。
- `hci`：显式只用 HCI，任何失败持续重试。
- `iohid` / `gatt`：语义同 0.2.6（HID 报文通道，在 26.5 上不可用，保留给旧系统与诊断）。

## 副作用与约束

- `startCapture` / 停止抓包都会重载 bluetoothd（全局蓝牙闪断一次）；失败的尝试不触碰配置。语音 BLE 链路靠既有退避重连恢复。
- 抓包是**系统级独占**：与 Apple TV Remote 麦克风抓包、主应用自己的 Google TV 遥控器服务互斥；对方持有时插件收到 `captureUnavailable` 安静重试，插件持有时对方同理。
- 依赖：主应用设备实验室安装的特权 HCI 组件（`/Library/PrivilegedHelperTools/com.vokie.hcihelper` + LaunchDaemon）与 `/Applications/PacketLogger.app`。缺件时 `auto` 回退 IOKit，`hci` 显式模式状态页显示具体缺件原因。
- 遥控器深度休眠后长按任意键约 3 秒唤醒，唤醒期间第一个按键被遥控器自身消耗（与主应用实测一致）。

## 验证

- `test/hci-button-source.test.mjs`：nhdr/ACL 解析（设备过滤、方向、PB/CID/opcode 守卫、标点容错）、按键状态机、fake 守护进程下的握手/请求形状/争用重试/确定性失败/断线重连/异常 stopCapture 重请求。
- `test/plugin.test.mjs`：真实 worker + fake Host + fake 守护进程——`hci` 显式模式无 BLE 链路下发 `send_enter`/`undo_last_output`、`auto` 模式 HCI 优先且 IOKit 不启动、`auto` 模式守护进程缺失时回退 IOKit。测试一律用 `VOKIE_HCI_SOCKET` 指向 fake/不存在路径，绝不触碰真机守护进程。
