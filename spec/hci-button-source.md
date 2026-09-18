# 按键 HCI 抓包与系统按键抑制通道

初始实现日期：2026-09-13（插件 0.3.0）。当前实现于 2026-09-18 对齐
`xiguashuo-pc` `main@76113b72`，使用 `vokie.appleTvRemote.hci` v4。
前置诊断见 [hid-macos-limitations.md](hid-macos-limitations.md)，A0 型号与身份绑定见
[a0-remote-support.md](a0-remote-support.md)。

## 历史兼容

插件 0.4.0 新增 A0 / 26.2 的 `0x0029` 八字节按键报告、实际 HID 型号/固件、
设备地址与序列号验证后的 HCI 句柄绑定。A0 只有绑定完成才显示按键可用；语音继续
使用 Host BLE 的 ATVV UUID 通道，不从 HCI 重复消费音频。

## 背景

macOS 26.5 上插件进程可直达的按键读取路径全部不可用：IOKit 共享模式收不到报文，
用户态 seize 被拒，事件系统 monitor / CGEventTap 收不到事件，配对后 GATT `2A4D`
又被系统隐藏。遥控器按键实际是发往系统 HID 栈所持连接的 ATT Handle-Value
Notification，HCI 层因此是当前唯一已验证的观测点。

Vokie 设备实验室安装的 root 守护进程 `com.vokie.hcihelper` 监听
`/var/run/com.vokie.hci.sock`。v4 维护一个 PacketLogger 进程和多个订阅连接：第一个
`startCapture` 写入蓝牙 trace 配置、启动 `packetlogger convert -s -f nhdr` 并重载
bluetoothd；后续客户端加入同一 capture，只增加订阅。每条 `nhdr` 按订阅者各自的
`captureId` 转发。只有最后一个订阅者 `stopCapture` 或断开时才停止 PacketLogger、
恢复配置并再次重载 bluetoothd。

## Worker 设计

- `worker/hci-button-source.mjs` 连接 Unix socket，以 `requiredVersion: "4"` 发送
  `startCapture`。所有请求包含唯一 `id`、稳定的进程级 `captureId`、调用者 pid/uid，
  并只接受属于本 capture 的 `captureStarted`、`captureStopped` 与 `nhdr`。
- nhdr 解析按非空白 token 查找 `RECV` / `SEND`，接受 Chromecast 名称或当前 HID
  身份的真实地址；十六进制 token 容忍尾部逗号和冒号。ACL 必须是完整首包、
  L2CAP CID `0x0004`、ATT opcode `0x1b`。
- legacy 只解析句柄 `0x002b` 的两字节确认/返回/松开报告；A0 只解析句柄
  `0x0029` 的完整八字节报告，并额外要求序列号双重验证绑定到同一 HCI 连接句柄。
- `HciButtonValueParser` 对按下去重并从全零报告合成松开沿。仅确认/返回按下沿进入
  `deviceSession.hidEvent`，分别产生 `send_enter` / `undo_last_output`。
- socket 中断或可重试错误每 5 秒重连并重新订阅；异常 `captureStopped` 会立即重订阅，
  成功的 `captureStarted` 同时取消遗留 retry timer，避免 5 秒后多做一次断开/重连。
  关闭连接会清空按键状态、A0 身份绑定、seize 状态和未完成请求。

## 共享 Capture 与 HID Seize

HCI 抓包和系统按键抑制是两个独立资源：

| 资源 | 所有权 | 行为 |
| --- | --- | --- |
| PacketLogger capture | v4 多客户端共享 | 所有订阅者都收到同一 nhdr 流；移除单个订阅者不影响其他客户端 |
| HID seize | 单连接所有 | root daemon 按 VID `0x18d1` / PID `0x9450` 抢占接口，阻止 macOS 和播放器消费遥控器按键 |

`hidSuppressNative` 默认为 `true`。capture 成功后 Worker 发送 `seizeHid`；运行中关闭该
设置会发送 `releaseHid`，重新开启则再次 `seizeHid`，两者都不重启 capture。插件停止时
先请求 `releaseHid`，再请求 `stopCapture` 并关闭 socket；进程崩溃或连接断开时 daemon
也会自动释放该连接拥有的 seize 和 capture 订阅。遥控器断开后重连由 daemon 的 HID
matching 回调继续处理。

`hidSeized` 表示 daemon 已接受并持有抢占会话；响应中的 `seized` / `failed` 计数记录
当前接口的实际打开结果，后续重连仍由 matching 回调接管。`hidSeizeError` 保存建会话失败
原因。`hidSeizeFailed`、抢占请求的 `error`，或第二个客户端遇到已有 seize owner，均只
降级为“仍可收到 HCI 按键，但 macOS 原生动作可能同时发生”；不得停止 capture、触发
IOKit 回退或阻断语音。实际成功 seize 会抑制该遥控器的全部系统 HID 按键，不只确认键。

## 来源选择与失败降级

`hidSource` 支持 `auto`（默认）/ `hci` / `iohid` / `gatt`：

- `auto` 优先 HCI。socket 缺失、PacketLogger 缺失、协议不兼容等确定性 capture 失败
  会结束本轮 HCI 探测并回退 IOKit 助手；重新选择 `auto` 才再次探测。
- v4 要求 daemon 返回版本 4；`versionMismatch`（例如已安装 v3）是确定性失败。升级
  插件代码但未升级特权组件时，不能假定新增命令可用。
- `another capture is active` 仍按历史兼容规则视为可重试而非确定性失败，但同一 v4
  daemon 的正常客户端已共享 capture，不应再因 Apple TV / Google TV 同时订阅而出现。
- 显式 `hci` 模式对 capture 错误持续重试，不启动第二按键源。`iohid` / `gatt` 保留给
  旧系统与诊断；macOS 26.5 实测不可用。
- seize 失败不是 capture 失败，因此无论 `auto` 还是 `hci` 都保持 HCI 按键通道。

## 副作用与约束

- 第一个 capture 订阅和最后一个订阅释放仍会各造成一次全局蓝牙短暂重载；已有共享
  capture 上增加或移除非最后一个订阅者不会重载 bluetoothd。
- 依赖设备实验室安装的 v4 特权组件及
  `/Applications/PacketLogger.app/Contents/Resources/packetlogger`。
- socket 权限为 `0666`，但 daemon 校验请求中的 `caller.uid` 必须等于 Unix 对端 uid。
- 遥控器深度休眠后需长按任意键约 3 秒唤醒，唤醒期间第一个按键可能被设备消耗。

## 验证

- `test/hci-button-source.test.mjs` 覆盖 v4 请求形状、双客户端共享 capture、seize 单 owner、
  动态 seize/release、抢占失败降级、版本不匹配、缺件、断线重连、异常停止、nhdr/ACL
  守卫和按键边沿；异常停止用例还跨过重试期限验证不会发生第三次订阅。
- `test/plugin.test.mjs` 以真实 Worker + fake Host/HCI daemon 验证无 BLE 时的按键命令、
  `auto` 优先与确定性失败回退、配置热切换，以及停止时释放 capture/seize。
- 测试只使用临时 socket 或明确不存在的路径，不连接真机守护进程，不修改系统蓝牙配置。
