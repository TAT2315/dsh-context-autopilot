# dsh-context-autopilot

DeepSeek Harness（DSH）插件：会话上下文超过阈值时自动压缩。

An automatic compaction plugin for DeepSeek Harness — it compacts the conversation once its context passes a configurable token threshold, before a very long context degrades the model.

本插件的问题定位、需求定义与发布决策由维护者完成，实现过程使用了 AI 辅助。

---

## 它解决的问题

长会话跑到后面，模型会开始出现「只思考不输出」：推理块写了一大段，正文一个字都没有，回合直接结束。

以下是一次长期会话的实测（约 800 轮）：

| 上下文规模 | 出现「只思考不输出」的比例 |
|---|---|
| 20 万 – 40 万 | 约 1% |
| 40 万 – 50 万 | 约 2% |
| 50 万 – 55 万 | 约 6% |
| 55 万 – 60 万 | 约 10% |

整体不到 3%，但分布极不均匀：会话前期几乎不出现，上下文长期停在 50 万以上之后明显变密，接近一半的回合会踩到。

也就是说，它不是随机抽风，是上下文规模撑到一定程度后的产物，而且越往后越频繁。

## 为什么 DSH 内置的自动压缩来不及

`dsh-compaction-basic` 的默认触发点是：

```
floor(min(W × thresholdRatio, W − O − headroomTokens))

W = 1048576      上下文窗口（示例，按你的部署填）
O = 256000       输出预留（示例，取你的 maxTokens）
headroom = 65536 默认余量
thresholdRatio = 0.8 默认值

= floor(min(838861, 727040))
= 727,040
```

也就是说内置机制要到 72.7 万 tokens 才动手。而退化从 40 万就开始了，55 万以上已经是 10% 的命中率——它永远慢一步。

这个插件把触发线拉到 42 万，在退化区之前压缩一次。

## 触发链路

1. 每个 `assistant/message` 事件都会带上本次请求的 usage；
2. 上下文规模 = `inputTokens + cacheReadTokens`（只取 `inputTokens` 会把长会话严重低估，因为命中缓存的部分单独记账）；
3. `turn/end` 提交之后比较阈值；
4. 超线则等 50 ms 让驱动器让出 agent，再在 `agent.runMaintenance()` 里调用 `ctx.compaction.compactNow()`——与人工 `/compact` 完全同一条代码路径，只是不需要人按。

会恢复会话、不会改动 session 日志以外的任何状态；压缩本身是 DSH 的原生能力，插件只负责「什么时候按」。

## 安装

在 DSH 里用 `plugin_manager` 的 `install_bundle`，目标填本目录的绝对路径：

```
plugin_manager({ action: "install_bundle", target: "<这个目录的绝对路径>" })
```

也可以走界面：**插件** → **添加插件** → 选择本地目录。

安装后本插件会作为一行出现在插件列表里，id 为 `context-autopilot`。

## 配置（阈值可自定义）

默认值写在 `cordis.patch.yml` 里，改这个文件即可：

```yaml
- insert:
    - id: context-autopilot
      name: 'dsh-context-autopilot'
      config:
        thresholdTokens: 420000
        cooldownMs: 30000
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `thresholdTokens` | `420000` | 触发线。上下文超过它就压缩一次。 |
| `cooldownMs` | `30000` | 两次尝试之间的最小间隔，防止压缩失败后每轮重试。 |

怎么选 `thresholdTokens`：

- **350000**：保守。退化区之前早早压一次，代价是细节丢得快、压缩请求更频繁。
- **420000**（默认）：退化刚开始出现的区间上沿。
- **500000**：省事。压缩次数少，但已经进入 6% 命中率的区间。

模型上下文窗口不是 1M 的部署，请按比例下调；`thresholdTokens` 是绝对值，不是比例。

也可以在 profile 的 `cordis.patch.yml` 里覆盖，不必改本包：

```yaml
- id: context-autopilot
  config:
    thresholdTokens: 350000
```

## 自测

想立刻确认它真的会触发：把 `thresholdTokens` 改成 `1000`，保存后随便发一句话。生效的话你会看到上下文被压掉一截。测完改回。

## 验证状态

已做的验证：

- 用真实长会话的全部 assistant 消息回放，`contextTokensOf()` 与 `inputTokens + cacheReadTokens` 逐条比对，不一致 0 条；
- 记录到的「只思考不输出」里，八成以上发生在 42 万 tokens 以上，阈值确实卡在退化区之前；
- 安装返回 `application: applied`，插件行 `fiberPhase: active`。

未做的验证：首次真实触发尚未观测到（需要会话上下文自然涨到阈值）。

## 边界

- 它只负责「按上下文规模自动压缩」，不修推理本身。
  推理空转的运行时拦截（切断退化调用、steer 续跑）请用专门的 loop guard 插件，两者互补，不要互相替代。
- `ctx.compaction` 不可用时插件保持不活动，不会让 profile 加载失败。
- 压缩要一次额外的模型请求，并且会把旧历史替换成摘要；阈值调得太低会明显加快细节丢失。

## License

MIT
