"""PDF user space -> normalized, rotated CropBox display coordinates."""

import math


def normalized_pdf_box(box, crop_box, rotation: int) -> list[float]:
    if rotation not in (0, 90, 180, 270):
        raise ValueError("Unsupported PDF rotation")
    if not all(math.isfinite(v) for v in (*box, *crop_box)):
        raise ValueError("Non-finite PDF coordinate")
    left, bottom, right, top = crop_box
    width, height = right - left, top - bottom
    if width <= 0 or height <= 0 or box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("Degenerate PDF rectangle")

    def transform(x, y):
        if rotation == 0:
            return (x - left) / width, (top - y) / height
        if rotation == 90:
            return (y - bottom) / height, (x - left) / width
        if rotation == 180:
            return (right - x) / width, (y - bottom) / height
        return (top - y) / height, (right - x) / width

    corners = [transform(x, y) for x in (box[0], box[2]) for y in (box[1], box[3])]
    result = [
        min(c[0] for c in corners),
        min(c[1] for c in corners),
        max(c[0] for c in corners),
        max(c[1] for c in corners),
    ]
    if any(v < -1e-6 or v > 1 + 1e-6 for v in result):
        raise ValueError("Rectangle extends outside displayed CropBox")
    return [max(0.0, min(1.0, v)) for v in result]


def display_box(box, width: float, height: float, origin: str = "TOPLEFT") -> list[float]:
    """A parser already in the rotated display frame; never rotate it a second time."""
    if origin == "BOTTOMLEFT":
        left, bottom, right, top = box
        box = [left, height - top, right, height - bottom]
    elif origin != "TOPLEFT":
        raise ValueError("Unknown coordinate origin")
    return validate_box([box[0] / width, box[1] / height, box[2] / width, box[3] / height])


def validate_box(box) -> list[float]:
    if len(box) != 4 or not all(math.isfinite(v) and 0 <= v <= 1 for v in box):
        raise ValueError("Bounding box must contain four normalized, finite coordinates")
    if box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError("Bounding box must have positive area")
    return list(box)
