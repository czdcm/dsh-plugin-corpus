# 第三方组件说明

本文件说明 `dsh-plugin-corpus` 仓库和发布包中使用的第三方组件。本文不是法律意见，公开再分发前请自行确认最新许可证文本与义务。

## 1. 本项目源码

- 许可证：**GNU General Public License, version 2 or later（GPL-2.0-or-later）**，全文见 [`LICENSE`](LICENSE)。
- 版权：Copyright (c) 2026 dsh-plugin-corpus contributors。
- 本项目自己的 `plugin/lib/*.js`、`tests/*`、`tools/*` 和文档均按 GPL-2.0-or-later 发布，除非另有说明。

## 2. 运行时与前端依赖（不随仓库打包）

这些组件由 DeepSeek Harness、Node.js 或浏览器环境提供，本仓库不复制其源码：

- **Node.js**：MIT 风格许可证，https://nodejs.org/
- **DeepSeek Harness / Cordis / Schemastery / DSH tools**：peer dependencies，由 DSH 安装；许可证见 DSH 发行包及 https://github.com/deepseek-ai
- **React**：MIT，由 DSH Web GUI 客户端运行时提供，https://react.dev/

## 3. 随包工具

### 3.1 OfficeCLI（`plugin/vendor/officecli/`）

- **许可证：Apache License 2.0**，全文见 `plugin/vendor/officecli/LICENSE`，归属说明见 `plugin/vendor/officecli/NOTICE.txt`。
- 上游：https://github.com/officecli/officecli
- 产品页：https://officecli.ai
- 仅用于把 Office 文档读成文本，不修改文档。
- 默认插件包包含该二进制及 Apache-2.0 许可证/NOTICE。

### 3.2 Poppler `pdftotext`（`plugin/vendor/pdftotext/`）

- **许可证：GNU GPL version 2 or later**，全文见 `plugin/vendor/pdftotext/LICENSE`，说明见 `plugin/vendor/pdftotext/NOTICE.txt`。
- 上游：https://poppler.freedesktop.org/
- 再分发该二进制需要满足 GPL 要求（许可证文本、对应源码可获取、NOTICE 等）。完整包包含它，并附 `SOURCE-OFFER.txt`。
- 不含它时，PDF 文字层不可提取（只能整本 OCR；没有 OCR 引擎则明确失败）；官方完整包始终包含它。

### 3.3 系统能力

- **Windows OCR**：通过 PowerShell 5.1 调用 `Windows.Media.Ocr`、`Windows.Data.Pdf` 等系统 API，不再分发微软二进制。
- **MinGW 运行时 DLL**：与 `pdftotext.exe` 一起随 Poppler 包分发，受其运行时例外和 GPL 义务约束。
- **测试夹具和 Markdown 文档**：由本项目创建，不包含第三方语料。

### 3.4 随包 RapidOCR 运行时（`plugin/vendor/rapidocr/`）

完整 Release 包内置一套可搬走的 Python 运行时与 OCR 依赖，扫描版 PDF 默认用它识别，无需用户安装 Python：

- **CPython 3.12.10**（`vendor/rapidocr/python/`）：Python Software Foundation License 2.0，https://www.python.org/ ；许可证文本随 `LICENSE.txt`。
- **rapidocr_onnxruntime 1.4.4**：Apache License 2.0，https://github.com/RapidAI/RapidOCR
- **ONNX Runtime 1.32.0**：MIT，https://github.com/microsoft/onnxruntime
- **OpenCV（opencv-python）5.0.0.93**：Apache License 2.0，https://github.com/opencv/opencv
- **NumPy 2.5.5**：BSD-3-Clause，https://numpy.org/
- **Pillow 13.0.0**：HPND，https://python-pillow.org/
- **Shapely 2.2.0**：BSD-3-Clause，https://github.com/shapely/shapely
- **PyYAML 6.0.3**：MIT，https://pyyaml.org/
- **protobuf 7.36.2**：BSD-3-Clause，https://github.com/protocolbuffers/protobuf
- **pyclipper 1.4.0**：MIT，https://github.com/fonttools/pyclipper
- **tqdm 4.70.1**：MIT，https://github.com/tqdm/tqdm
- **flatbuffers 25.12.19**：Apache License 2.0，https://github.com/google/flatbuffers
- **packaging 26.3**：Apache-2.0 / BSD-2-Clause 双许可，https://github.com/pypa/packaging
- **six 1.17.0**：MIT，https://github.com/benjaminp/six
- **colorama 0.4.6**：BSD-3-Clause，https://github.com/tartley/colorama

各组件自带的 `*.dist-info/`（含许可证文本）随 site-packages 一并保留。若不需要内置 OCR，可自行删除 `plugin/vendor/rapidocr/`，插件会回退到 Windows OCR（需系统 OCR 语言包）。

随包运行时按上游原样分发，未修改源码；对应源码可从上述上游项目获取。

## 4. 发布包策略

| 产物 | 内容 | 第三方二进制 |
|---|---|---|
| 默认 `*-plugin.zip` | 插件代码 + 完整 vendor + 许可证/说明 | OfficeCLI（Apache-2.0）+ pdftotext（GPL-2.0-or-later）+ RapidOCR 运行时（CPython/ONNX Runtime/OpenCV/NumPy 等） |
| `*-handoff.zip`（如果本地生成） | 完整开发交接包 | 本地 vendor；公开再分发前必须满足 GPL 义务 |

官方 Release 只发布完整包；`tools/package-plugin.ps1` 也只产出完整包（v1.5.0 起移除了纯 JS PDF 解析兜底，PDF 文字层依赖随包 pdftotext）。

如果发布包含 `pdftotext` 的构建，请保留许可证、NOTICE、源码获取说明；默认构建已经随包附带。Poppler 源码可从上游获取，`SOURCE-OFFER.txt` 中也有说明。

## 5. 链接

- Apache License 2.0：https://www.apache.org/licenses/LICENSE-2.0
- GNU GPL 2.0：https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
- Poppler：https://poppler.freedesktop.org/
- OfficeCLI：https://github.com/officecli/officecli
- RapidOCR：https://github.com/RapidAI/RapidOCR
- ONNX Runtime：https://github.com/microsoft/onnxruntime
- Python：https://www.python.org/
