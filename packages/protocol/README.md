# dsh-digital-human-protocol

数字人 App 与本机桥接插件共用的协议层（对应 `docs/design.md` §5.1）。零依赖、纯 ESM、无构建步骤。

- **帧格式**：NDJSON，一行一个 JSON 对象，`\n` 结尾；单帧上限 `MAX_FRAME_BYTES_DEFAULT`（262144 字节）。
- **协议版本**：`PROTOCOL_VERSION = 1`；握手双向校验，不匹配即拒绝。
- **镜像类型**：协议自带最小 `SessionSummaryMirror` 形状与手写 guard，App 不依赖 DSH 包类型。

## 用法

```js
import {
  METHODS, EVENT_NAMES,
  hello, welcome, ready, rpc, result, error,
  baseline, activity, approvalRequest, approvalSettled,
  validateFrame, assertOk, encodeFrame, createFrameDecoder,
} from 'dsh-digital-human-protocol'

// 客户端
socket.write(encodeFrame(hello({ protocol: 1, clientId, clientName, token, clientNonce })))

// 服务端解码（不抛异常；非法行经 onError 上报后自动重新同步）
const decode = createFrameDecoder({
  onFrame(frame) {
    const failure = validateFrame(frame)
    if (failure !== undefined) return onError(failure)
    handle(frame)
  },
  onError: (err) => { socket.destroy() },
})
socket.on('data', decode)
```

## API

| 导出 | 说明 |
|---|---|
| `PROTOCOL_VERSION` / `MAX_FRAME_BYTES_DEFAULT` / `HANDSHAKE_TIMEOUT_MS` | 常量 |
| `METHODS` / `EVENT_NAMES` / `ACTIVITY_KINDS` / `APPROVAL_DECISIONS` / `APPROVAL_OUTCOMES` / `CAPABILITIES` | 冻结词表（`Object.freeze`） |
| `hello` `welcome` `ready` `rpc` `result` `error` | 握手与 RPC 构造器 |
| `event` `baseline` `sessionsChanged` `controlFrame` `activity` `approvalRequest` `approvalSettled` `bridgeNotice` | 事件构造器 |
| `validateHello` `validateWelcome` `validateReady` `validateRpc` `validateResult` `validateError` `validateEvent` `validateFrame` | 帧校验 |
| `validateActivity` `validateSessionSummary` `validateDecision` `validateApprovalOutcome` `validateNoticeLevel` | 载荷校验 |
| `isJsonValue` | 深检查：仅 null / boolean / 有限 number / string / array / 普通对象，拒绝 `undefined`、函数、symbol、bigint、非有限数、类实例与环 |
| `ProtocolError` / `assertOk` | 错误类型与「校验失败即抛」的封装 |
| `encodeFrame` / `createFrameDecoder` / `truncateText` | 编解码与 UTF-8 安全截断 |

## 约定

- **校验器不抛异常**：每个 `validate*` 成功返回 `undefined`，失败返回错误消息字符串。`validateFrame` 对未知 `type` 返回失败（调用方按非法处理）；`assertOk(validation, context)` 供偏好抛异常的调用方使用。
- **可选键省略**：构造器只在参数不为 `undefined` 时写入可选键（如 `approvalRequest` 的 `callId` / `reason` / `args`）。
- **解码器不抛异常**：非法 JSON 或超长行经 `onError` 上报并重置缓冲，随后从下一个换行处继续；`\r\n` 与 `\n` 均可作为终止符；`decoder.flush()` 返回并清空残余的不完整行。
- **截断**：`truncateText(text, maxBytes)` 按码点截断，绝不切断多字节字符，也不追加省略号（是否截断由调用方设置 `truncated: true`）。`encodeFrame` 在超过上限时抛 `ProtocolError`。

## 测试

```sh
node --test test/
```

零依赖，仅用 `node:test` + `node:assert/strict`。

## Running the tests

```sh
npm test          # node --test test/  (standard; spawns one child per file)
npm run test:direct  # node test/protocol.test.mjs
```

Both run the identical `node:test` assertions. Use `test:direct` inside a
restricted harness that denies child processes with piped stdio: Node's default
test runner spawns a child per test file and captures its stdio over a pipe,
which such sandboxes reject (`Program 'node.exe' failed to run: Access is
denied`), while an in-process run is unaffected.