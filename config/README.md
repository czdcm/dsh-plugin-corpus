# 权限策略模板

`corpus-access.example.json` 是 `%USERPROFILE%\.dsh\corpus-access.json` 的脱敏模板，复制后按本机路径修改。该文件包含本机绝对路径，不要提交到仓库。

| 字段 | 作用 |
|---|---|
| `default` | 未命中任何规则时的动作，通常保持 `deny` |
| `grants` | 授权列表；每条规则用 `workspace` 或 `session` 指定主体，`paths` 写集合名、目录前缀或 glob |
| `deny` | 显式拒绝列表；命中即拒绝，优先于 `grants` |
| `expiresAt` | 可选，毫秒时间戳或可解析的时间字符串；过期后规则自动失效 |

`session` 授权会沿 `parentSession` 链被子代理继承。
