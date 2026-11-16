#!/usr/bin/env python3
"""dsh-plugin-corpus — RapidOCR 辅助脚本（可选 OCR 引擎）。

两种输入：
  --manifest <json>   由插件用 Windows.Data.Pdf 渲染好的页面清单：
                      [{"page": 40, "path": "C:/.../page-0040.png"}, ...]
  --path <pdf>        插件没有渲染清单时，尝试用 PyMuPDF 直接渲染（需装 pymupdf）

输出与 ocr_windows.ps1 一致：`--- Page N ---` 分段 + 纯文本行，供 parseOcrPages() 解析。

依赖：rapidocr_onnxruntime、opencv-python、numpy（manifest 模式不需要 pymupdf）。
"""

import argparse
import json
import os
import sys
import tempfile


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


def ocr_image(engine, cv2, np, image_path):
    # 不要用 cv2.imread：Windows 上遇到中文/非 ASCII 路径会读失败。
    with open(image_path, "rb") as handle:
        payload = handle.read()
    image = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"读取图片失败：{image_path}")
    raw, _ = engine(image)
    rows = []
    for item in raw or []:
        box, text = item[0], item[1]
        if text is None:
            continue
        text = str(text).strip()
        if text == "":
            continue
        ys = [float(point[1]) for point in box]
        xs = [float(point[0]) for point in box]
        rows.append((min(ys), min(xs), text))
    # 先按行首 y 坐标粗分桶（12 px），同桶内按 x 排序。
    rows.sort(key=lambda row: (round(row[0] / 12.0), row[1]))
    return [text for _, _, text in rows]


def collect_from_manifest(path):
    with open(path, "r", encoding="utf-8") as handle:
        items = json.load(handle)
    if not isinstance(items, list) or not items:
        raise RuntimeError("manifest 为空或格式不对")
    out = []
    for item in items:
        number = int(item.get("page") or 0)
        image_path = str(item.get("path") or "")
        if number <= 0 or image_path == "":
            continue
        out.append((number, image_path))
    return out


def collect_from_pdf(pdf_path, pages_spec, render_height):
    import fitz  # PyMuPDF

    document = fitz.open(pdf_path)
    selected = parse_pages(pages_spec)
    out = []
    try:
        cache_dir = tempfile.mkdtemp(prefix="corpus-rapidocr-")
        for index in range(document.page_count):
            number = index + 1
            if selected is not None and number not in selected:
                continue
            page = document.load_page(index)
            rect = page.rect
            zoom = max(200, int(render_height or 3000)) / max(1.0, float(rect.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            target = os.path.join(cache_dir, f"page-{number:04d}.png")
            pix.save(target)
            out.append((number, target))
    finally:
        document.close()
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="")
    parser.add_argument("--path", default="")
    parser.add_argument("--pages", default="")
    parser.add_argument("--render-height", type=int, default=3000)
    args = parser.parse_args()
    if not args.manifest and not args.path:
        print("需要 --manifest 或 --path", file=sys.stderr)
        return 2

    try:
        import numpy as np
        import cv2
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # noqa: BLE001
        print(f"RapidOCR 依赖缺失：{exc}", file=sys.stderr)
        return 1

    try:
        if args.manifest:
            items = collect_from_manifest(args.manifest)
        else:
            items = collect_from_pdf(args.path, args.pages, args.render_height)
    except Exception as exc:  # noqa: BLE001
        print(f"准备页面失败：{exc}", file=sys.stderr)
        return 1

    engine = RapidOCR(
        intra_op_num_threads=4,
        det_limit_side_len=1200,
        det_limit_type="max",
    )
    for number, image_path in items:
        print("")
        print(f"--- Page {number} ---")
        try:
            for text in ocr_image(engine, cv2, np, image_path):
                print(text)
        except Exception as exc:  # noqa: BLE001
            print(f"--- Page {number} (OCR failed: {exc}) ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
