# Chromecast BLE 接入与设备隔离 v0.2.6

日期：2026-09-10。依据本次更新后的 vokie-plugin-creator skill 及其 references/protocol.md。只修改本插件；不修改 Host、小米插件、安装目录或系统权限。

## 问题及实现选择

0.2.4 的 BLE 选择器将名称包含 Chromecast 的候选排在前面，但仍会回退到列表中的其他设备。ATVV 是多型号共用的语音服务，1812/180F 缓存查询也可能返回其他遥控器；这些信息无法单独确认 Chromecast 型号。这是代码中可复现的误连路径，但不能据此断定用户此前小米插件控制 Chromecast 的现象已被实机归因。

保留 Host BLE adapter v1 传输 ATVV 语音；保留插件自带 IOKit helper 读取标准 HID 按键。macOS 系统配对后 CoreBluetooth 可能不暴露标准 HID Report 2A4D，不能将 GATT 订阅确认当成实际收到按键，也不能因为语音可用就认定 HID 可用。此次不新增或假设 Host 权限请求 API，不改为插件私有 BLE helper。

## 设备选择

- 扫描请求含 ATVV serviceUuid、namePrefix=Chromecast、connectedServiceUuids=[ATVV,1812,180F]；所有请求带 apiVersion=1。
- Worker 自行再次检查名称。仅接受去首尾空格、不区分大小写的 Chromecast Remote / Chromecast Voice Remote；deviceId 必须为非空字符串且按不透明值原样传递。
- 不接受 RC003、小米、无名称设备或仅有 ATVV/电池服务的候选。不回退到“第一个设备”。serviceUuids 缺失或为空时，名称合格的缓存候选可进入连接验证。
- 必需 ATVV control/audio 特征订阅及 capabilities 协商成功后才报告 connected；缺少必需特征时释放连接，不启动会话。
- 名称不是硬件认证；当前 Host BLE 接口不提供设备型号认证或可用于关联 HID 的 VID/PID。改名/无名称遥控器会被忽略，多只同型号设备暂不做逐只绑定。HID helper 仍仅匹配 18D1:9450。

## 连接与资源生命周期

- 只处理当前 scan requestId 对应的结果；scan 的 ble_accepted 不能提前结束扫描，仍等待 ble_scan_result。重复结果及旧请求拒绝均忽略。
- 在发出 ble_connect 前保留候选 deviceId，防止并发扫描结果导致重复连接。
- 断连、失败、stop 和重启递增连接 generation，取消该代的协商/能力超时和请求；迟到的回调不得订阅、发送命令或重置新连接。
- connect 拒绝、超时、必需特征订阅失败等先发送幂等 ble_disconnect。必须等待 ble_accepted（原生断开完成）才重试；ble_disconnected 可在该确认之前或之后到达，不启动重复重试。
- stop 后立即 start 同样等待上一连接释放。释放失败/超时会报告错误并停止自动重试，防止在未知占用状态下重新连接。
- 单次重连使用唯一退避定时器，间隔 1/2/4/8 秒封顶。连接或必需特征失败的候选冷却 10 秒后可以再尝试；新启动清空冷却记录，不再永久排除暂时忙碌的遥控器。
- 权限拒绝、无效协议及明确的平台/后端不可用是永久错误；即使失败来自可选订阅也不会被吞掉。已有或正在建立的连接同样释放。
- 仅处理当前设备及已支持的通知特征；协商前不转发音频/按键，重复 capabilities 不重置会话。保留 receivedAtMs；未提供时使用本地接收时间。

## 按键来源

| 配置 | BLE | HID |
| --- | --- | --- |
| auto（默认） | ATVV 语音，不订阅标准 HID | 使用插件原生助手 |
| iohid | ATVV 语音，不订阅标准 HID | 使用插件原生助手 |
| gatt | ATVV + 显式尝试 2A4D（短/长 UUID） | 不启动原生助手；不可达时明确报告 |

默认模式下 BLE ready 不停止助手；BLE 语音断连也不清除仍在收报的独立 HID 状态。原生/GATT 选择变化时结束当前录音并重连以更新订阅，界面明确说明。语音模式和原生按键抑制开关不额外触发 BLE 重连。

## 可诊断性与验证

版本同时更新到 manifest 与握手副本的 0.2.6，插件页显示 live extensions.package.version。Worker 启动日志记录插件 ID、版本、实际 Worker/helper 路径，不包含认证 token。BLE 选择记录候选数量、选中名称及不透明 deviceId；原生 raw_report 记录保持与按键转换分离。

验证覆盖混合小米/Chromecast 列表、无名称缓存、旧扫描/错误、连接超时、断开事件与确认两种顺序、连接中 stop/start、订阅中断连、缺少 ATVV 特征、失败冷却恢复、原生按键与 BLE 语音共存，以及原始 HID 报文规范化。

本次 `node --test`：59 项通过。原生 helper 本轮未改动；沿用已构建二进制。0.2.6 独立目录启动、包内路径及首条握手消息验证通过，git diff --check 通过。真实设备报文、系统 TCC 归属及多遥控器现场行为尚未验证，不能以 fake Host 测试代替。

## 0.2.6 通知错误分类修复

用户报告：`failed: The request is not supported. (notify_failed)` 使 0.2.5 整个连接进入永久错误。原分类正则只要匹配 not supported、unavailable 等词就触发永久停用，误把设备单次操作拒绝当作平台不可用；此代码路径已通过相同错误字符串复现。原报错未带特征 UUID，不能直接断定现场失败的是哪个特征。

- 永久失败仅包括 permission_denied、invalid_request，或 failed 且消息明确说明 adapter/backend/helper/platform 不可用、未安装等情况。
- `notify_failed`、通用 not supported 不单独说明整个适配器不可用，交由对应请求的恢复逻辑处理。
- ATVV command（…0002）回显订阅可选：失败后仍发送 capabilities 查询，从 control（…0004）接收结果和语音按键事件。
- 显式 GATT 模式的 HID 2A4D 订阅可选：两种 UUID 均失败时按键不可达，但 ATVV 语音仍继续。
- ATVV control/audio 订阅必需：失败不得声明就绪，保留 UUID 和错误，等待断开确认后退避重试。
- 每个拒绝记录 operation、characteristicUuid、reason、message，通过 `[cast-ble] request failed` 日志和 extensions.bluetooth.lastRequestFailure 展示；不再只留下缺少特征上下文的泛化错误。
- 回归测试包含可选命令回显失败后完整语音协商、GATT HID 失败降级、两个必需通知失败恢复，以及可选订阅上的真实后端/权限/协议拒绝仍然停用并释放设备。
