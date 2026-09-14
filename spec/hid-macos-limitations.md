# Chromecast 遥控器按键 · macOS 26.5 逐层实测结论

日期：2026-09-10。环境：macOS 26.5（arm64），Chromecast Voice Remote（VID `0x18D1` / PID `0x9450`，固件 0.0.1），Vokie 开发版（Electron 38）。方法：现场逐层探测（IOKit 助手、IOHIDEventSystemClient monitor、CGEventTap、CoreBluetooth 探针、root 授权弹窗），每层由真实按键触发验证。范围仅诊断记录；本轮不改变按键架构。

## 结论

本机（macOS 26.5）上，**插件进程可触达的所有按键读取路径均不可用**。语音链路（ATVV over BLE GATT）完全正常，且实测**无配对、无加密**状态下也能完成 capabilities 协商（`0A 01 00 00 03 03` → `0B 01 00 02 03 00 F7 01 00`）。

## 逐层证据

| # | 路径 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | IOKit 共享打开（`kIOHIDOptionsTypeNone`） | ❌ 零报文 | 助手以 `--observe` 运行、成功匹配 collection（usagePage 1 / usage 6），按键期间 `raw_report` 为 0 条。ioreg 显示 `DeviceOpenedByEventSystem = Yes`：DriverKit `AppleUserHIDEventDriver` 独占报文通道 |
| 2 | IOKit 独占（`kIOHIDOptionsTypeSeizeDevice`） | ❌ `kIOReturnNotPrivileged (0xE00002C1)` | ① CLI 子进程（输入监控 TCC `granted`）seize 失败；② root（osascript 管理员授权拉起）seize 与共享均失败 `kIOReturnNotPermitted (0xE00002E2)`，且该上下文 `IOHIDCheckAccess` 从 `unknown` 变 `denied`——TCC 归属是门禁，root 不豁免；③ 插件助手（Electron 子进程）在给 Electron 授予输入监控前后，seize 均未成功（系统 `AppleUserHIDEventService` 始终在场，hidutil 可见）。hidapi issue #266：键盘类设备 seize 需要 root（Leopard 起）。唯一未验证的变体：vRemoter 式 App 进程内 seize（见「遗留问题」） |
| 3 | HID 事件系统 monitor（`IOHIDEventSystemClientCreateWithType(Monitor)` + 事件回调 `(target, refcon, sender, event)`，签名核对自 Apple 开源 `IOHIDEventSystemMonitor.c` / `HIDEventSystemClient.m`） | ❌ 该设备零事件 | 普通鼠标按钮事件（type=6）、SPU 传感器事件均可见可收；遥控器按键期间 sender `0x100049742` 零事件；键盘类事件对无 entitlement 客户端被隔离（实测敲字母，monitor 零键盘事件） |
| 4 | CGEventTap（ListenOnly，公开 API） | ❌ 零事件 | 普通键盘字母键码正常可见；遥控器按键零事件。与 #3 合并结论：遥控器按键 usage（Button 页等）不被 HID 栈映射为任何系统事件 |
| 5 | GATT `2A4D`（系统配对状态） | ❌ 整个 `1812` 服务被隐藏 | CoreBluetooth attach 连接 `discoverServices` 只返回 `AB5E0001`；`retrieveConnectedPeripherals(withServices: [1812])` 返回空。小米 RC003 同样被隐藏（其插件注释所述 2A4D 路径应为 Windows 行为，仓库含 `XiaomiRemoteHelperWindows.cpp`） |
| 6 | GATT `2A4D`（解除配对，配对广播模式） | ❌ 遥控器自己不暴露 HID | 广播只带 `1812`（配对邀请），不带 ATVV UUID；连接后 GATT 表为 `180A` / `180F` / `AE40` / `AB5E0001` / `D343BFC0`（Google vendor 配对服务），无 `1812`。序列号等读特征无加密要求 |
| 7 | vendor 通道 `AE42` / `D343BFC5`（notify） | ❌ 无按键数据 | 配对状态下两者均可订阅成功，按键期间零数据 |
| 8 | LE 配对触发（读 Serial Number / 用户确认系统配对弹窗） | ⚠️ bond 建立后 HID 仍不可达 | bond 建立瞬间遥控器断开链路，重连后（attach）GATT 表仍无 `1812`（其余 vendor 服务可见）；系统 HID 栈随即接管 |

## 附带发现

- 遥控器广播名固定 `Chromecast Remote`，配对广播**不含 ATVV 服务 UUID**；插件扫描若按 ATVV UUID 过滤将永远扫不到未配对的遥控器（需按名称前缀扫描，Host 适配器已支持 `namePrefix` 无 `serviceUuid` 的扫描）。
- 12:59 遗留的旧版 `--observe` 助手曾长期共享打开设备；任何与 seize 的冲突都可能被误读为权限问题。独占失败回退共享后，助手不会重试独占（进程重启前为终态）。
- vRemoter（`VincentKingHsu/vRemoter`，MIT，README 中已致谢）的按键实现与插件同款：manager 级 `IOHIDManagerOpen(SeizeDevice)` + input report 回调，但发生在**签名 App 进程内**且配套权限向导。本机未安装 vRemoter，其进程内 seize 在 macOS 26.5 是否仍可用未验证。

## 遗留问题与方向

1. **安装 vRemoter 实测**（用户决策，第三方未签名应用）：若其按键映射在本机可用，则证明 macOS 26.5 仅放行「App 进程内 + 权限归属」的 seize，插件需要 Vokie Host 在 App 进程内提供 HID seize 适配（主项目改动）；若同样失败，则该系统版本上按键对所有第三方应用不可达，可彻底关闭该方向。
2. 逆向 Google 配对握手（`D343BFC0` 服务，`D343BFC1-4` 写 + `D343BFC5` 通知）：完成握手后遥控器是否向未与系统 HID 栈配对的主机暴露 `1812`，未知；即使暴露，macOS 对已 bond 设备的 `1812` 隐藏（#5）大概率仍适用。投入产出比低。
3. 语音链路无配对也工作（#6 附 capabilities 实测），可作为断连/恢复场景的备选连接方式保留观察。

## 验证方式（现场已执行）

- `./assets/chromecast-hid-helper --seize / --observe`（本仓库助手，含权限与错误 JSON 输出）
- `hidutil list`、`ioreg`（`DeviceOpenedByEventSystem`、`DeviceUsagePairs`、Button 页 elements）
- 自建 C 探针：IOHIDEventSystemClient monitor（`/tmp/hid-event-probe2.c`，事件回调 + sender registryId）
- 自建 Swift 探针：CGEventTap（`/tmp/cg-eventtap-probe.c`）、CoreBluetooth attach/广播/订阅（`/tmp/cb-probe*.swift`，覆盖配对/未配对/vendor 通道/GET_CAPS）
- root 探针：`osascript ... with administrator privileges` 拉起助手（TCC 归属 denied 证据）
