# 安装指南

本文说明如何在 Windows 上安装 `dsh-plugin-corpus-v1.2.0-plugin.zip`。

本插件是 **DeepSeek Harness（DSH）插件**，不是独立应用：必须放入 DSH 插件目录，并在当前 DSH profile 中注册。

## 1. 压缩包里有什么

```text
dsh-plugin-corpus/
├─ package.json
├─ cordis.patch.yml
├─ README.md
├─ INSTALL.md
├─ LICENSE
├─ THIRD_PARTY_NOTICES.md
├─ lib/                 宿主工具、面板 API、客户端 UI
└─ vendor/              OfficeCLI、pdftotext 及其许可证
```

vendor 二进制已经包含在完整包里，不需要单独安装 OfficeCLI 或 pdftotext。

## 2. 环境要求

- Windows 10/11
- 已安装并可正常启动 DeepSeek Harness
- PowerShell 5.1+
- DSH profile 目录，通常是 `%USERPROFILE%\.dsh\profiles\desktop`

语料数据默认在 `%USERPROFILE%\.dsh\corpus`，不在插件目录里。替换插件不会删除语料。

### 源码 clone 不等于完整安装

GitHub 源码仓库不包含第三方二进制（`officecli.exe` / `pdftotext.exe`）。`git clone` 适合看代码和跑测试，但默认没有完整 Office/PDF 提取能力。完整安装请使用 Release 包；源码开发前先把 vendor 文件放回 `plugin/vendor/officecli/` 和 `plugin/vendor/pdftotext/`，或接受纯 JS/Windows OCR 降级。

## 3. 安装 / 升级

> 替换插件前必须**完全退出 DSH**，关浏览器标签不算。

### 第 1 步：退出 DSH

用 **文件 → 退出** 或托盘菜单退出，确认 DSH 进程已经结束。

### 第 2 步：备份旧插件

```powershell
$plugins = "$env:USERPROFILE\.dsh\plugins"
if (Test-Path "$plugins\dsh-plugin-corpus") {
  Copy-Item "$plugins\dsh-plugin-corpus" "$plugins\dsh-plugin-corpus.bak" -Recurse -Force
}
```

### 第 3 步：解压

解压到：

```text
%USERPROFILE%\.dsh\plugins\
```

检查：

```powershell
Test-Path "$env:USERPROFILE\.dsh\plugins\dsh-plugin-corpus\package.json"
Test-Path "$env:USERPROFILE\.dsh\plugins\dsh-plugin-corpus\lib\index.js"
Test-Path "$env:USERPROFILE\.dsh\plugins\dsh-plugin-corpus\vendor\officecli\officecli.exe"
```

三项都应为 `True`。

### 第 4 步：在 DSH profile 中注册

打开：

```text
%USERPROFILE%\.dsh\profiles\desktop\package.json
```

确认两处都有：

```json
{
  "dependencies": {
    "dsh-plugin-corpus": "link:C:/Users/<you>/.dsh/plugins/dsh-plugin-corpus"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-plugin-corpus"
      ]
    }
  }
}
```

注意：

- `<you>` 换成你的 Windows 用户名；
- `link:` 路径用正斜杠；
- `dependencies` 和 `dsh.profile.bundles` 缺一不可；
- 覆盖升级本机已有插件时，profile 通常不用改。

### 第 5 步：新机器才需要补 link

如果 profile 刚新增这个 link，在 profile 目录执行一次：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install
```

如果 pnpm 不在 PATH，优先使用 DSH 插件管理器添加本地插件。

### 第 6 步：启动并验证

启动 DSH 后检查：

- 左侧栏出现 **语料库**；
- 右侧栏或开始菜单出现 **语料权限**；
- 会话中调用 `corpus_access` 能返回权限范围。

面板没出现时，先确认 DSH 已完全重启、profile 两处都已注册、`node_modules/dsh-plugin-corpus` 链接正确。

## 4. 升级

1. 完全退出 DSH；
2. 备份当前 `%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus`；
3. 用新 zip 解压覆盖；
4. profile 不动；
5. 完全重启 DSH。

语料、权限和索引不在插件目录内，升级不会丢数据。

## 5. 卸载

1. 完全退出 DSH；
2. 从 profile 的 `dependencies` 和 `dsh.profile.bundles` 删除 `dsh-plugin-corpus`；
3. 删除 `%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus`；
4. 重启 DSH。

插件被卸载，但语料仍保留在 `%USERPROFILE%\.dsh\corpus`。要彻底删除数据，再单独删除该目录。

## 6. 包版本

| 包 | 内容 |
|---|---|
| `dsh-plugin-corpus-v1.2.0-plugin.zip` | 完整包：OfficeCLI + pdftotext |
| `dsh-plugin-corpus-v1.2.0-plugin-without-pdftotext.zip` | 仅 OfficeCLI；PDF 文字回退纯 JS/Windows OCR |

两个包使用同一份脱敏源码，区别仅在于是否包含 GPL 的 pdftotext 二进制及其许可证。
