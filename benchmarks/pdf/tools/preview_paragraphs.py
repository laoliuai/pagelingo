"""Native line evidence and conservative indentation for experimental PDF exports.

Character indices are PDFium text-page indices, not PDF content-stream glyph IDs.
Region assignments remain geometric evidence, never a calibrated probability.
"""

import math
import re
from statistics import median

from pagelingo_parser.normalize import content_text

FURNITURE = {"header", "footer", "page_number"}
VISUALS = {"image", "table", "chart"}


def ranges(indices):
    """Compact half-open native-character ranges, with no duplicate members."""
    result = []
    for index in sorted(set(indices)):
        if result and result[-1][1] == index:
            result[-1][1] += 1
        else:
            result.append([index, index + 1])
    return result


def source_lines(chars):
    visible = [c for c in chars if c["bbox"] and c["fontSize"] > 0]
    if not visible:
        return []
    font = median(c["fontSize"] for c in visible)
    # Small scripts must not create an extra "first line" above normal prose.
    primary = [c for c in visible if c["fontSize"] >= 0.85 * font]
    primary_indices = {c["index"] for c in primary}
    groups = []
    for char in sorted(primary, key=lambda c: (c["baseline"][1], c["x"])):
        baseline = char["baseline"][1]
        if (
            not groups
            or abs(baseline - median(c["baseline"][1] for c in groups[-1]))
            > 0.3 * font / char["pageHeight"]
        ):
            groups.append([char])
        else:
            groups[-1].append(char)
    for char in visible:
        if char["index"] in primary_indices or not groups:
            continue
        group = min(groups, key=lambda g: abs(char["y"] - median(c["y"] for c in g)))
        group.append(char)
    return [
        {
            "bbox": [
                min(c["bbox"][0] for c in group),
                min(c["bbox"][1] for c in group),
                max(c["bbox"][2] for c in group),
                max(c["bbox"][3] for c in group),
            ],
            "baseline": median(c["baseline"][1] for c in group),
            "fontSize": median(c["fontSize"] for c in group),
            "nativeCharacterRanges": ranges(c["index"] for c in group),
            "members": sorted(group, key=lambda c: c["x"]),
        }
        for group in groups
    ]


def source_targets(blocks, run_id, source_index):
    targets = []
    for block in blocks:
        root_id = f"{run_id}/p{source_index}/b{block['index']}"
        children = block.get("content", [])
        if block["type"] in VISUALS and isinstance(children, list):
            items = [
                (f"{root_id}/c{i}", child) for i, child in enumerate(children) if child.get("bbox")
            ]
        else:
            items = [(root_id, block)]
        for identity, item in items:
            if item.get("bbox"):
                targets.append(
                    {
                        "id": identity,
                        "blockIndex": block["index"],
                        "kind": item["type"],
                        "bbox": item["bbox"],
                        "role": "furniture" if block["type"] in FURNITURE else "content",
                        "nativeIndices": [],
                        "ambiguousIndices": [],
                    }
                )
    return targets


def page_evidence(blocks, chars, page, parsed_index, source_index, run_id):
    targets = source_targets(blocks, run_id, source_index)
    unassigned, ambiguous = [], []
    for char in chars:
        if not char["bbox"]:
            continue
        candidates = [
            t
            for t in targets
            if t["bbox"][0] - 0.002 <= char["x"] <= t["bbox"][2] + 0.002
            and t["bbox"][1] - 0.002 <= char["y"] <= t["bbox"][3] + 0.002
        ]
        if not candidates:
            unassigned.append(char["index"])
            continue
        candidates.sort(
            key=lambda t: ((t["bbox"][2] - t["bbox"][0]) * (t["bbox"][3] - t["bbox"][1]), t["id"])
        )
        selected = candidates[0]
        selected["nativeIndices"].append(char["index"])
        if len(candidates) > 1:
            selected["ambiguousIndices"].append(char["index"])
            ambiguous.append(
                {"nativeIndex": char["index"], "candidateIds": [t["id"] for t in candidates]}
            )
    assignments = []
    for target in targets:
        members = [chars[i] for i in target.pop("nativeIndices")]
        uncertain = target.pop("ambiguousIndices")
        lines = source_lines(members)
        assignments.append(
            {
                **target,
                "nativeCharacterRanges": ranges(c["index"] for c in members),
                "ambiguousCharacterRanges": ranges(uncertain),
                "visualLines": [
                    {k: v for k, v in line.items() if k != "members"} for line in lines
                ],
            }
        )
    return {
        "parsedPageIndex": parsed_index,
        "sourcePageIndex": source_index,
        "width": page.get_width(),
        "height": page.get_height(),
        "cropBox": list(page.get_bbox()),
        "rotation": page.get_rotation(),
        "assignmentMethod": "character-center-and-smallest-region",
        "blocks": assignments,
        "unassignedCharacterRanges": ranges(unassigned),
        "ambiguousAssignments": ambiguous,
        "readingOrder": [t["id"] for t in assignments if t["role"] == "content"],
    }


def body_columns(blocks, lines_by_index, panel_members, marked_indices):
    samples = []
    for block in blocks:
        lines = lines_by_index.get(block["index"], [])
        if (
            block["type"] != "text"
            or block["index"] in panel_members | marked_indices
            or not lines
            or block["bbox"][2] - block["bbox"][0] < 0.26
        ):
            continue
        samples.append(
            {
                "left": min(line["bbox"][0] for line in lines),
                "right": block["bbox"][2],
                "weight": len(lines),
            }
        )
    clusters = []
    for sample in sorted(samples, key=lambda s: s["left"]):
        group = next((g for g in clusters if abs(g[0]["left"] - sample["left"]) < 0.018), None)
        if group is None:
            clusters.append([sample])
        else:
            group.append(sample)
    columns = []
    for group in sorted(clusters, key=lambda g: sum(s["weight"] for s in g), reverse=True):
        candidate = {
            "left": median(s["left"] for s in group),
            "right": median(s["right"] for s in group),
        }
        if not columns or all(
            min(candidate["right"], c["right"]) - max(candidate["left"], c["left"]) < 0.03
            and abs(candidate["left"] - c["left"]) > 0.22
            for c in columns
        ):
            columns.append(candidate)
    return sorted(columns, key=lambda c: c["left"])


def paragraph_records(blocks, evidence, callouts, marked_indices):
    lines_by_index = {
        b["blockIndex"]: b["visualLines"] for b in evidence["blocks"] if "/c" not in b["id"]
    }
    panel_members = {index for panel in callouts for index in panel["blockIndices"]}
    columns = body_columns(blocks, lines_by_index, panel_members, marked_indices)
    evidence["bodyColumns"] = columns
    records = []
    for block in blocks:
        index = block["index"]
        lines = lines_by_index.get(index, [])
        if block["type"] != "text" or not lines or index in marked_indices:
            continue
        assignment = next(
            b for b in evidence["blocks"] if b["blockIndex"] == index and "/c" not in b["id"]
        )
        if assignment["ambiguousCharacterRanges"]:
            continue
        font = median(line["fontSize"] for line in lines)
        if not math.isfinite(font) or font <= 0:
            continue
        first = lines[0]["bbox"][0]
        rest = median(line["bbox"][0] for line in lines[1:]) if len(lines) > 1 else first
        panel = next((p for p in callouts if index in p["blockIndices"]), None)
        if panel:
            peers = [
                line["bbox"][0]
                for i in panel["blockIndices"]
                if i not in marked_indices
                for line in lines_by_index.get(i, [])
            ]
            base = min(peers) if peers else min(first, rest)
            context = "callout"
        elif columns:
            center = (block["bbox"][0] + block["bbox"][2]) / 2
            column = min(columns, key=lambda c: abs(center - (c["left"] + c["right"]) / 2))
            base, context = column["left"], "body-column"
        else:
            continue
        first_em = (first - rest) * evidence["width"] / font
        inset_em = (rest - base) * evidence["width"] / font
        if len(lines) == 1 and context == "body-column" and 0.5 <= inset_em <= 2.2:
            text = content_text(block.get("content", "")).strip()
            if re.match(r"^[A-Z]", text) and len(text) > 25 and re.search(r"[.!?]$", text):
                first_em, inset_em = inset_em, 0
        # Ignore font bearings and tiny alignment noise; reject extreme geometry.
        first_em = first_em if 0.5 <= first_em <= 3 else 0
        inset_em = inset_em if 0.6 <= inset_em <= 8 else 0
        if not first_em and not inset_em:
            continue
        records.append(
            {
                "parsedPageIndex": evidence["parsedPageIndex"],
                "sourcePageIndex": evidence["sourcePageIndex"],
                "blockIndex": index,
                "sourceId": assignment["id"],
                "firstLineEm": round(first_em, 3),
                "leftInsetEm": round(inset_em, 3),
                "context": context,
                "referenceLeft": base,
                "nativeCharacterRanges": assignment["nativeCharacterRanges"],
                "visualLines": lines,
                "method": "native-lines-and-local-margin",
            }
        )
    return records


def validate_native_ownership(pages):
    """A chosen native character has one leaf owner; ambiguity remains visible."""
    for page in pages:
        seen = set()
        identities = set()
        for block in page["blocks"]:
            if block["id"] in identities:
                raise ValueError("Duplicate native source identity")
            identities.add(block["id"])
            for start, end in block["nativeCharacterRanges"]:
                current = set(range(start, end))
                if start < 0 or end <= start or seen & current:
                    raise ValueError("Overlapping native source ownership")
                seen.update(current)
