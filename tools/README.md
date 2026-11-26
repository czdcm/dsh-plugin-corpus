# 工具脚本

| 脚本 | 用途 |
|---|---|
| `test-all.ps1` | 运行全部本地验收。优先使用 `DSH_NODE`；未设置时自动查找 DSH 自带 Node 或 PATH 中的 `node` |
| `deploy.ps1` | 把 `plugin/` 复制到 `%USERPROFILE%\.dsh\plugins\dsh-plugin-corpus`；覆盖前会自动备份旧版本 |
| `package-plugin.ps1` | 生成完整 Release zip（含 vendor），校验 OfficeCLI、pdftotext、RapidOCR 后写入 `releases/v<版本>/` |

部署或打包完成后都要完全重启 DSH，宿主代码只在进程启动时加载。

测试环境变量：

- `CORPUS_TEST_ROOT`、`CORPUS_TEST_IT`、`CORPUS_TEST_DSH`：启用真实语料回归；
- `CORPUS_TEST_FORMULA_PDF`：启用 PDF 公式回归；
- `CORPUS_TEST_OCR=1`：启用 Windows OCR 冒烟。
