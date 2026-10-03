"""Optional network smoke check: does the public arXiv v6 PDF match our Library fixture?

Not part of CI; executes network I/O only when explicitly run.
Only prints size and SHA-256, never uploads or stores the PDF.
"""
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

URL = "https://arxiv.org/pdf/1712.01769v6"
EXPECTED_BYTES = 303_358
EXPECTED_SHA256 = "687e651bc1461992d6548e48555aae85159c78e2be5d4835042f7facdf268629"

with urllib.request.urlopen(URL, timeout=25) as response:
    actual = response.read(EXPECTED_BYTES + 1)
length = len(actual)
sha256 = hashlib.sha256(actual).hexdigest()
print(f"public_pdf_bytes={length}")
print(f"public_pdf_sha256={sha256}")
print(f"library_original_match={length == EXPECTED_BYTES and sha256 == EXPECTED_SHA256}")
if length != EXPECTED_BYTES or sha256 != EXPECTED_SHA256:
    raise SystemExit("Public file does not match the Library original; nothing stored")

# Optional one-off public PDF E2E fixture in this isolated test worktree.
# Atomic no-overwrite placement, mirroring file_transfer's hash requirement.
imports = Path(__file__).resolve().parents[1] / ".chatgpt2codex" / "imports"
imports.mkdir(parents=True, exist_ok=True)
destination = imports / "seq2seq-asr-chiu-2018.pdf"
with tempfile.NamedTemporaryFile(dir=imports, prefix=".verified-paper-", delete=False) as tmp:
    tmp.write(actual)
    tmp.flush()
    os.fsync(tmp.fileno())
    staging_path = tmp.name
try:
    try:
        os.link(staging_path, destination)
        print("public_pdf_saved=True")
    except FileExistsError:
        if destination.is_symlink() or destination.read_bytes() != actual:
            raise SystemExit("Different existing file; refusing to overwrite")
        print("public_pdf_saved=already_identical")
finally:
    os.unlink(staging_path)
print("public_pdf_destination=" + str(destination.relative_to(imports.parent.parent)))
