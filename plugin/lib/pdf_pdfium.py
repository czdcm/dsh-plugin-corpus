#!/usr/bin/env python3
"""dsh-plugin-corpus — PDFium 文字层提取（随包引擎）。

用途：按页提取 PDF 文字层，输出 JSON，供插件继续过质量闸门/OCR。
使用 pypdfium2（Apache-2.0）调用 PDFium（BSD-3-Clause），随插件 vendor 分发，
不依赖用户安装 Python 包；自带 CJK CMap，可处理 Adobe-GB1 等中文 CID 字体。

调用（由 pdf.js runPdfiumText 负责）：
  python pdf_pdfium.py --path <pdf> [--pages "1-3,7"]
"""

import argparse
import json
import re
import sys

SPACE_GAP_RATIO = 0.46
WORD_CHAR = re.compile(r"[A-Za-z]")
CJK_CHAR = re.compile(r"[\u4e00-\u9fff]")


def normalize_text(text):
    return str(text).replace("\r\n", "\n").replace("\r", "\n")


def layout_text(textpage):
    """用字符坐标补空格：PDFium 不保证在相邻文本对象之间插空格。

    只处理 ASCII 字母之间的明显空隙（gap > 0.46 × 行高），避免把
    单词内部、数字、CJK 字符或标点拆开；分页边界由调用方保留，不在这里拼接。
    count_chars 与文本长度不一致（连字/代理对）时直接返回原文。
    """
    raw = textpage.get_text_range()
    if raw == "":
        return ""
    if textpage.count_chars() != len(raw):
        return normalize_text(raw)
    # 中文页面的字宽/字距与拉丁文差异大，坐标补空格容易把“km/h”“120”拆开；
    # CJK 占比超过 15% 时直接保留 PDFium 原文。
    if len(CJK_CHAR.findall(raw)) / max(1, len(raw)) > 0.15:
        return normalize_text(raw)

    out = []
    previous_char = None
    previous_box = None
    for index, char in enumerate(raw):
        if char == "\r":
            continue
        if char == "\n":
            out.append("\n")
            previous_char = None
            previous_box = None
            continue
        box = textpage.get_charbox(index)
        if previous_char is not None and WORD_CHAR.match(char) and WORD_CHAR.match(previous_char):
            gap = box[0] - previous_box[2]
            height = max(box[3] - box[1], previous_box[3] - previous_box[1], 1.0)
            if gap > SPACE_GAP_RATIO * height:
                out.append(" ")
        out.append(char)
        previous_char = char
        previous_box = box
    return normalize_text("".join(out))


def parse_pages(spec):
    """解析 1-based 页码范围："1,3-5,9"；空字符串表示全部页。"""
    if not spec:
        return None
    selected = set()
    for token in str(spec).split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            first_text, last_text = token.split("-", 1)
            first, last = int(first_text), int(last_text)
            if first > last:
                first, last = last, first
            selected.update(range(first, last + 1))
        else:
            selected.add(int(token))
    return selected or None


def open_document(pdfium, path):
    try:
        return pdfium.PdfDocument(path)
    except Exception as first_error:  # noqa: BLE001
        # 只加密、无用户密码的 PDF 允许用空密码打开。
        try:
            return pdfium.PdfDocument(path, password="")
        except Exception:
            raise first_error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--pages", default="")
    args = parser.parse_args()

    try:
        import pypdfium2 as pdfium
    except Exception as exc:  # noqa: BLE001
        print(f"pypdfium2 不可用：{exc}", file=sys.stderr)
        return 1

    try:
        document = open_document(pdfium, args.path)
    except Exception as exc:  # noqa: BLE001
        print(f"打开 PDF 失败：{exc}", file=sys.stderr)
        return 1

    selected = parse_pages(args.pages)
    pages = []
    try:
        page_count = len(document)
        for index in range(page_count):
            number = index + 1
            if selected is not None and number not in selected:
                continue
            try:
                textpage = document[index].get_textpage()
                try:
                    text = layout_text(textpage)
                except Exception:
                    # 布局后处理失败时退回原始文本，不能因补空格丢页。
                    text = normalize_text(textpage.get_text_range())
            except Exception as exc:  # noqa: BLE001
                pages.append({"page": number, "text": "", "chars": 0, "error": str(exc)})
                continue
            pages.append({
                "page": number,
                "text": text,
                "chars": len(text.strip()),
            })
        print(json.dumps({
            "pageCount": page_count,
            "pages": pages,
        }, ensure_ascii=False))
    finally:
        document.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
