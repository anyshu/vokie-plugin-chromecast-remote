# Chromecast Voice Remote for Vokie

把 Google Chromecast Voice Remote 变成 Vokie 的蓝牙语音输入控制器：**按住说话，或点按免提；确认键发送，返回键撤销。**

当前版本 **0.5.0**，基础功能已完成。支持 macOS，适配 Google Chromecast Voice Remote（VID `0x18D1` / PID `0x9450`）。本项目是 Vokie 插件，需要由 Vokie 主应用加载，不是独立运行的电视遥控软件。

支持 **A0 / 26.2** 遥控器和旧款 `hid_mouse`。插件自动读取实际型号与固件，按型号解析确认 / 返回键；A0 的 HCI 按键须完成设备身份验证后才启用，语音会在解码与重采样后应用专用 DSP 和 -6 dBFS 峰值保护。

## 功能

| 操作 | 效果 |
| --- | --- |
| 语音键 · 长按模式（默认） | 按下立即录音，松开结束，使用 Vokie PTT 会话 |
| 语音键 · 短按模式 | 按一下开始录音，再按一下结束，使用 Vokie Hands-free PTT 会话 |
| 确认键 | 发送 / 回车确认输出 |
| 返回键 | 撤销上一次输出 |

- **自动连接与恢复**：扫描匹配的遥控器，协商语音协议；可恢复的连接故障会自动重试，断连时取消当前录音。
- **独立的语音与按键通道**：语音通过 BLE 传输；确认 / 返回键默认通过 HCI 抓包读取，按键不可用不等于语音不可用。
- **即改即用的设置页**：切换语音模式和按键来源，查看设备连接、按键通道、插件版本、当前会话及上次结束原因。

> 长按 / 短按是两种可选模式，**不是自动识别按压时长**。长按模式下快速点按只会产生一次很短的录音。当前只映射语音、确认、返回三个按键，不提供其他按键映射，也未启用独立长录音、翻译或实时翻译能力。

## 使用前准备

- **macOS + Vokie**：Vokie 需支持插件 API v1 和 Host BLE 适配器；A0 还要求适配器按特征属性支持无响应写入（当前 xiguashuo-pc 已实现）。其他平台暂不支持。
- **Chromecast Voice Remote**：为完整使用语音和按键功能，先在 macOS 蓝牙设置中完成配对，并保持遥控器唤醒。
- **蓝牙权限**：按系统提示允许 Vokie 使用蓝牙。
- **确认 / 返回键所需组件**：通过 Vokie「设备实验室」安装特权 HCI 组件 `com.vokie.hcihelper`，并准备位于 `/Applications/PacketLogger.app` 的 PacketLogger。插件本身不包含这两个组件。

> **macOS 26.5 注意事项**：当前实测环境下，确认 / 返回键需要 HCI 抓包；缺少上述组件时，即使自动回退到 IOKit 助手，按键仍不可用，语音链路不依赖这些组件。HCI v4 允许插件、Apple TV 麦克风和主应用 Google TV 遥控器共享同一份 PacketLogger 抓包；只有第一个订阅开始和最后一个订阅结束时才会切换全局抓包，边界操作可能短暂重载系统蓝牙并影响其他蓝牙设备。

## 快速开始

1. 在 Vokie 插件页安装本插件的打包 ZIP；也可按下方方式从源码目录安装。
2. 完成上述配对、权限与组件准备，启用插件。Worker 由 Vokie 启动，不需要手动运行。
3. 打开插件设置页，等待显示「遥控器已连接」，并确认按键来源 / 可用状态。
4. 默认使用**长按模式**：按住语音键说话，松开结束；在 Vokie 输出后，按确认键发送，或按返回键撤销。
5. 如需免提，在设置中选择**短按模式**，按一下语音键开始，再按一下结束。

### 从源码目录安装 / 更新

将本仓库目录复制到 Vokie 的插件目录：

```text
<userData>/plugins/eb5f9200-de02-49bf-b602-57c49ebf78b9/
```

`<userData>` 是 Vokie 的实际用户数据目录；插件 ID 见 [vokie.plugin.json](vokie.plugin.json)。Worker 仅依赖 Node.js 内建模块，需要 **Node.js 22 或更高版本**，无需 `npm install`。

更新时重新安装 ZIP，或替换安装目录后重新启动插件。**修改本仓库不会自动更新已安装副本**；以插件设置页显示的运行版本为准。

若拷贝 / 解压没有保留 Unix 可执行权限，启动时可能报 `spawn … EACCES`。将下面路径替换为实际安装路径后执行：

```sh
chmod +x '<插件安装目录>/worker/index.mjs' '<插件安装目录>/assets/chromecast-hid-helper'
```

Worker 也会在启动 IOKit 助手时尝试自动修复助手的可执行位。

## 设置

设置页**改动即保存**，无需保存按钮；Vokie 确认后显示「✓ 已生效」。

| 设置 | 配置键 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 语音键模式 | `voiceMode` | `hold` | `hold`：按住说话（PTT）；`tap`：点按切换（Hands-free PTT） |
| 按键来源 | `hidSource` | `auto` | `auto`：HCI 优先，确定性不可用时回退 IOKit；`hci`：仅 HCI；`iohid`：仅 IOKit 助手；`gatt`：仅 GATT，供诊断使用 |
| 拦截原生按键 | `hidSuppressNative` | `true` | HCI 抓包通过特权组件抢占 HID，IOKit 助手尝试独占设备；设为 `false` 时不抢占。抢占失败只表示原生动作未拦截，不影响 HCI 按键读取；GATT 通道不受此设置影响 |

切换到或离开 `gatt` 会重新连接语音链路并结束当前录音。其他来源切换会加入或离开共享 HCI 抓包；若恰好成为第一个或最后一个订阅者，仍可能因系统蓝牙重载而打断连接，建议在空闲时更改。

旧版本的 `holdThresholdMs` / `tapMode` / `holdMode` 配置已废弃，Worker 会忽略并记录日志，不会因此阻止启动；未知配置项或非法值仍会被拒绝。

## 常见问题与限制

### 已连接，但确认 / 返回键没有反应

「遥控器已连接」表示语音链路连接状态，**请同时检查设置页的按键状态**。

- 确认 HCI 特权组件和 PacketLogger 已安装。`auto` 只有在组件缺失、协议不兼容等确定性失败时才回退 IOKit。
- 确认特权组件支持 HCI 协议 v4；插件会与其他 v4 客户端共享抓包。协议版本不兼容属于确定性失败，`auto` 会回退 IOKit 助手，显式 `hci` 模式会显示错误。
- 开启「拦截原生按键」后若状态显示拦截失败，HCI 按键仍然可用，但确认键等原生动作也可能同时送到播放器。
- macOS 26.5 上 IOKit / GATT 按键路径在本项目实测中不可用；保留它们用于兼容性尝试与诊断，其他系统版本仍需验证。详见 [macOS HID 限制与实测记录](spec/hid-macos-limitations.md)。
- IOKit 的「独占冲突」不等于「缺少输入监控权限」；即使成功打开设备也不代表收到按键报文，应以实际状态和日志判断。

### 闲置后没有反应

遥控器闲置数分钟后可能深度休眠。长按任意键约 3 秒唤醒，唤醒期间第一个按键会被遥控器自身消耗。若仍无反应，可取下电池约 5 秒后装回，再等待重连。

### 扫不到遥控器，或一直连接失败

- 检查系统蓝牙、Vokie 的蓝牙权限及遥控器是否唤醒。
- BLE 自动连接只接受名称为 `Chromecast Remote` / `Chromecast Voice Remote` 的候选；HCI 接受这两个名称或已识别遥控器的真实蓝牙地址；A0 还必须通过 HID UUID + 序列号回读绑定。无名称、改名或其他型号的设备可能被忽略。
- 可恢复的 BLE 故障按 1–8 秒退避重试；明确的权限拒绝、后端不可用或协议错误会停止重试，需要先解决原因。状态页会显示连接阶段和错误原因。
- 有 HID 身份时按其外设 UUID 选择语音连接；无身份时保留旧版名称筛选。多只遥控器同时在线时优先选择 A0，同一 profile 内保持当前设备，暂不提供手动选择。A0 若一直显示「等待设备身份验证」，请检查蓝牙权限与配对状态；插件不会因全零地址而放宽验证。

### 短按模式下，按住期间的声音会丢失吗？

短按模式在第一次松开语音键时创建会话，并打开持续收音。按住期间的音频会先缓冲、随后补发，但只保留最近约 **2 秒**；不要将短按模式当作长时间按住录音使用。持续收音开麦失败会有限重试，耗尽后取消会话，避免产生空输出。

### Intel Mac 可以用吗？

仓库内置的 IOKit 助手是 **arm64** 二进制。Intel Mac 如需使用 IOKit 通道，需在本机重新构建助手；这不代表其他依赖或整套链路已经过 Intel 真机验证。

## 工作原理

```text
Chromecast Voice Remote
├─ 语音键与麦克风 → BLE / ATVV → Vokie Host BLE 适配器 → 插件 Worker
└─ 确认 / 返回键 → HCI 抓包（默认）/ IOKit / GATT → 插件 Worker
                                                          ↓
                                         Vokie 录音会话与发送 / 撤销命令
```

- **语音**：支持 ATVV v0.4 / v1.0，优先协商 ADPCM 16 kHz；8 kHz 音频重采样至 16 kHz，通过插件 WebSocket 发送单声道 `pcm_s16le` 音频帧。A0 在解码、重采样后应用独立 DSP 与 -6 dBFS 峰值保护，处理 profile 在每次手势开始时固定；旧款保持原始 PCM。ATVV v1.0 物理流每 10 秒发送 `MIC_EXTEND`（写失败后本连接停止重试），免提主机流每 4 秒保活，v0.4 物理流不发送 `MIC_EXTEND`。
- **按键**：默认通过 HCI v4 连接特权守护进程 `/var/run/com.vokie.hci.sock`，共享 PacketLogger 抓包，从蓝牙通知中解析确认 / 返回键并做按下去重。开启原生按键拦截时，抓包建立后请求守护进程抢占 HID，离开抓包前释放；抢占失败只降级拦截，不中断 HCI 按键。IOKit 助手与 GATT 是可选按键源，不与 HCI 同时处理按键。
- **会话**：`hold` 对应 `ptt`，`tap` 对应 `handsfree-ptt`；确认键发出 `send_enter`，返回键发出 `undo_last_output`。

协议、兼容性调查与实现细节见：

- [BLE 设备筛选、连接隔离与重试](spec/ble-device-isolation.md)
- [A0 新款兼容、身份验证与迁移记录](spec/a0-remote-support.md)
- [HCI 按键通道、共享抓包与原生按键拦截](spec/hci-button-source.md)
- [IOKit 助手实现与诊断](spec/hid-helper.md)
- [macOS 26.5 HID 逐层实测记录](spec/hid-macos-limitations.md)

这些文档包含对应开发阶段的历史记录；当前功能与默认行为以本 README 和代码为准。

## 开发与测试

### 目录

```text
vokie.plugin.json  # 插件清单、版本与能力声明
worker/            # Host 通信、BLE / ATVV、按键源、音频与会话状态机
ui/index.html      # 状态与设置页
native/            # Swift IOKit 助手源码与构建脚本
assets/            # 预编译助手、图标与插件 UI SDK
spec/              # 接入规格、诊断与实现记录
test/              # 单元测试与 fake Host / 遥控器 / HCI 集成测试
```

### 运行测试

在源码仓库根目录执行：

```sh
node --test
```

覆盖 ATVV / PCM 编解码、A0 DSP 与峰值保护、物理/免提保活、两种语音模式、BLE 候选隔离与重连、三条按键通道、HCI v4 共享抓包、HID 抢占与回退、配置校验及 Worker 生命周期。macOS 上的原生报文规范化测试需要 Swift 工具链（Xcode Command Line Tools）。

测试使用 fake Host、设备与助手；HCI 套接字指向测试服务或不存在路径，不连接真实守护进程，也不打开真实 HID 设备。**自动化通过不替代真机兼容性验收。**

### 重建 IOKit 助手

仅在修改原生源码或需要本机架构的二进制时执行，需要 Swift 工具链：

```sh
sh native/build-helper.sh
```

脚本会覆盖 [assets/chromecast-hid-helper](assets/chromecast-hid-helper)，并仅以 `--help` 做冒烟检查，不打开实际设备。新增 `--identity` 模式只枚举 HID 身份；只有收到插件的抓包已开启通知后，才对 A0 指定 UUID 读取序列号，不订阅或写入 ATVV。

### 排查日志

优先查看插件设置页的连接、按键与会话信息。Worker stderr 中，`[cast-plugin]` 记录插件 ID、版本与加载路径，`[cast-ble]` / `[cast-atvv]` 记录连接与语音事件，`[cast-hci]` / `[cast-hid]` 记录按键信息，`[cast-session]` 记录会话结束原因与音频帧数。

## 致谢

ATVV 协议与 IOKit 按键读取参考了 [VincentKingHsu/vRemoter](https://github.com/VincentKingHsu/vRemoter) 的逆向实现。感谢其对 Chromecast Voice Remote 协议的探索与公开分享。
