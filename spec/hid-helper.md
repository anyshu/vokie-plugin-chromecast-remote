# Chromecast HID 助手修复规格

日期：2026-09-10。范围仅限本仓库；不同步已安装插件，不修改 Vokie 主项目或系统设置。插件版本 0.2.6；本轮仅修正 BLE 错误分类，原生实现未改动。

## 问题与证据边界

旧助手先用 manager 共享打开匹配设备，再逐个尝试设备级独占。manager 并非只做发现：其 Open 会传播到当前及后续匹配设备。每次新匹配还会 detach 前一个设备，只留下最后一个输入回调；任一移除回调会清空当前设备。

Chromecast 可暴露多个 HID collection。上述实现可能漏掉按键接口，且无法保证拦截全部原生动作。此前“共享模式零报文”不足以证明固件仅支持独占，亦不足以排除实现、权限、进程占用问题。此次修复不把权限授予当作报文必然恢复的保证。

## 原生助手行为

- 默认或 `--seize`：在 IOHIDManager 上注册输入报告回调，直接以 seize 模式打开全部 VID 0x18D1 / PID 0x9450 匹配接口；不再调用 IOHIDDeviceOpen。
- `--observe`：同一路径直接共享打开。共享读取仍可能受到输入监控限制。
- 独占打开失败：解除回调、取消调度并关闭整个 manager（含部分打开的设备），再新建 manager 共享打开。共享打开失败即退出，由 Worker 执行现有的有界重启。
- 后续匹配接口报错：记录错误；若处于独占模式，在当前回调结束后执行一次完整共享回退，避免继续保留部分独占。共享模式的匹配错误仅上报，仍允许后续设备事件到达。
- 跟踪所有成功匹配的设备对象；新增接口不解绑旧接口，移除一个接口不影响其他接口。最后一个接口消失时才发 connected=false。
- 所有非空报告先输出独立 raw_report 诊断，保留回调 report ID、原始长度及前 32 字节十六进制值。只有明确的 report ID 1，或 report ID 0 且 buffer 已含 1 的完整报文才送入按键解析器。单字节 payload=1 规范化为 [1,1]（power），不误判为只有 report ID 的空报文；未知 report ID 不猜成 1。沿用按下沿去重。
- 保持信号源的强引用；SIGTERM/SIGINT、stdin EOF 均关闭 manager 并退出。
- `--help` 不初始化 HID、不检查或请求权限；构建后的冒烟验证使用它，避免用 stdin EOF 错判进程失败。

## 诊断与状态协议

| JSON type | 字段及含义 |
| --- | --- |
| started | seize：本次 manager 的打开模式，不代表已收到报文 |
| device | connected、collectionCount：当前成功匹配接口集合 |
| collection | connected、registryId（字符串）、usagePage、usage：单接口诊断 |
| permission | inputMonitoring：granted / denied / unknown；使用 IOHIDCheckAccess，只读检查，不主动调用 IOHIDRequestAccess |
| error | operation、code（十六进制）、recoverable、message；区分独占冲突与系统访问拒绝，不把 ExclusiveAccess 等同于 TCC 拒绝 |
| raw_report | reportId、length、hex：原始回调诊断；Worker 保存计数及最近一条到 extensions，并仅将每次助手启动后的前 20 条写入 stderr |
| hid_report | data：含 report ID 的 base64 报文 |

IOKit 打开设备本身可能触发系统的授权流程；只读预检查不绕过该机制，也不预设父 App 的 TCC 身份。授权要以实际运行环境为准。

Worker 中，助手“进程运行”和“已收到有效按键报文”分别记录。仅收到至少两字节且以 0x01 开头的报文才将 IOKit 按键通道标为可用。启动、停止、崩溃、报错或最后一个接口移除会清除该状态；重新连接后需要新报文确认。接口数量减少但仍 connected=true 不清除状态。最后一个接口移除、重新启动及错误时重置按键去重状态，使重连后相同按键仍可触发。

错误显示于插件状态及 Worker stderr。输入监控 denied 在按键不可用时显示，unknown 不推断为拒绝。语音 BLE 尚未连接时也展示独立的 HID 状态。auto/iohid 保持原生助手按键，Host BLE 仅用于 ATVV。GATT 是显式选项；订阅结果不能替代原生助手的收报证据，来源变更需重连，详见 [BLE 接入规格](ble-device-isolation.md)。

## 验证

自动化：

- `node --test`：现有协议及 fake Host 测试；新增可控 fake helper 验证启动不误报可用、权限诊断、多个接口状态、重复报文去重、最后接口移除、相同按键重连、错误回退及停止状态。
- `sh native/build-helper.sh`：编译全部 Swift 源文件、重建仓库内 arm64 二进制并运行无设备 `--help` 冒烟检查。
- `git diff --check`：检查补丁空白错误。

当前回归结果：59 项 Node 测试（含纯 Swift 规范化验证）全部通过；arm64 助手编译及 `--help` 冒烟验证通过；UI 脚本语法检查及 `git diff --check` 通过。未启动真实 HID 采集，未进行安装目录同步、提交或推送。

现场验收（本次未代替用户执行）：

1. 从实际 Vokie 启动链运行修复后的助手，记录 permission、collection、started、error。共享/独占对照使用相同启动链与有效按键窗口。
2. 按确认/返回：出现 hid_report，分别触发一次 send_enter / undo_last_output；重复报文不重复触发。
3. 独占模式确认原生按键被拦截；共享回退验证是否能读到报文，并确认界面标注未拦截。不得仅凭 started.seize=true 宣称所有原生动作已验证。
4. 断开重连后再次按同一键仍触发；退出插件后助手退出，原生按键恢复。

自动化不能证明真实 Chromecast 已恢复报文，也不能验证当前系统的 TCC 归属及原生事件抑制效果。
