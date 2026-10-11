import pytest

from pagelingo_parser.files import digest, write_json
from pagelingo_parser.reproject import reproject


@pytest.mark.parametrize("artifact", ["raw.json", "source.pdf"])
def test_reprojection_rejects_changed_evidence_before_reusing_measurement(tmp_path, artifact):
    source = tmp_path / "original"
    source.mkdir()
    path = source / artifact
    path.write_bytes(b"original evidence")
    write_json(source / "run.json", {"status": "complete"})
    write_json(
        source / "manifest.json",
        {"files": [{"path": artifact, "sha256": digest(path)}]},
    )
    path.write_bytes(b"changed evidence")
    output = tmp_path / "projection"

    with pytest.raises(ValueError, match="Original run changed"):
        reproject(source, output)

    assert not output.exists()
    assert path.read_bytes() == b"changed evidence"
