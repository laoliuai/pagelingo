"""Recover omitted round list markers from exact native prose and hanging indent."""

from pagelingo_parser.normalize import content_text
from preview_paragraphs import source_lines
from preview_typography import canonical


def recover_list_markers(blocks, chars):
    repairs = {}
    for block in blocks:
        if block["type"] != "text" or not isinstance(block.get("content"), list):
            continue
        text = content_text(block["content"])
        if not text or text.lstrip().startswith(tuple("•●▪◦‣–")):
            continue
        box = block["bbox"]
        selected = [c for c in chars if c["bbox"] and box[0] <= c["x"] <= box[2]
                    and box[1] <= c["y"] <= box[3]]
        lines = source_lines(selected)
        if len(lines) < 2 or len(lines[0]["members"]) < 2:
            continue
        first = lines[0]["members"]
        bullet, body = first[0], first[1]
        if bullet["text"] not in "•●▪◦‣" or len(bullet["text"]) != 1:
            continue
        if not 0 < body["bbox"][0] - bullet["bbox"][2] < 0.025:
            continue
        if any(abs(line["bbox"][0] - body["bbox"][0]) > 0.008 for line in lines[1:]):
            continue
        native = canonical("".join(c["text"] for c in selected)).replace("\x02", "")
        if native != bullet["text"] + canonical(text):
            continue
        others = [b for b in blocks if b is not block and b.get("bbox")]
        if any(b["bbox"][0] <= bullet["x"] <= b["bbox"][2]
               and b["bbox"][1] <= bullet["y"] <= b["bbox"][3] for b in others):
            continue
        repairs[block["index"]] = {
            "method": "exact-native-round-marker-and-hanging-indent",
            "parserText": text,
            "marker": bullet["text"],
            "nativeIndex": bullet["index"],
            "bbox": bullet["bbox"],
        }
        block["content"].insert(0, {"type": "text", "content": bullet["text"] + " "})
    return repairs
